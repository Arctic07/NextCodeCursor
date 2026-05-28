import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { logger } from '../../logger';
import type { ProviderRoundContext } from '../llm/providerRuntime';
import type { LLMMessage } from '../llm/types';
import { finalizeEditToolCall } from './editRuntime';
import { finalizeExecTool } from './execRuntime';
import { finalizeInteractionTool } from './interactionRuntime';
import { execMessage, toolCallCompleted, toolCallStarted } from './stream';
import { buildToolArgs } from './toolBuilders';
import {
    buildAskQuestionResultFromInteractionResponse,
    buildLocalToolResult,
    buildWebFetchApprovalResultFromInteractionResponse,
    buildWebSearchApprovalResultFromInteractionResponse,
} from './toolResults';
import { finalizeToolCall } from './toolLifecycle';
import { buildEditPlan, buildExecArgs, mapToolToExecArgs, resolveToolCall, type AvailableMcpTool, type ToolCallInfo } from './tools';
import { getBackgroundJob, registerBackgroundJob, type AgentSession } from './session';
import { buildExecToolResult } from './toolResults';
import { str } from './toolkit/results/shared';
import { waitForInteractionResponseWithHeartbeat, waitForPromiseWithHeartbeat } from './wait';
import { performWebFetch, performWebSearch } from './web';
import { interactionQuery } from './stream';
import type { ToolResultEnvelope } from './toolResults';
import type { ParsedRunRequest } from './protocol/types';

type SubagentModelOverride = ParsedRunRequest['subagentModelOverrides'][number];

function resolveSubagentModel(
    subagentType: string,
    parentModelId: string,
    overrides?: SubagentModelOverride[],
): string {
    const override = overrides?.find(o => o.subagentType === subagentType);
    if (!override || override.selection.case === 'inherit') {
        logger.debug({ subagentType, parentModelId, overrideCount: overrides?.length ?? 0 }, '[TOOL] subagent model → inherit parent');
        return parentModelId;
    }
    if (override.selection.case === 'model' && override.selection.modelId) {
        logger.info({ subagentType, modelId: override.selection.modelId, parentModelId }, '[TOOL] subagent model → override');
        return override.selection.modelId;
    }
    return parentModelId;
}

export interface TaskLaunchContext {
    tc: ToolCallInfo;
    execMessageId: number;
    modelCallId: string;
    startedArgs: Record<string, unknown>;
    sanitizedInput: Record<string, unknown>;
    cursorToolType: string;
}

export async function* runToolCall(params: {
    toolCall: ToolCallInfo;
    availableMcpTools: AvailableMcpTool[];
    conversationId: string;
    currentModelId: string;
    subagentModelOverrides?: SubagentModelOverride[];
    round: number;
    session: AgentSession | null;
    roundContext: Pick<ProviderRoundContext, 'createToolResult' | 'recordToolResult'>;
    messages: LLMMessage[];
    allocateExecMessageId: () => number;
    allocateInteractionId: () => number;
}): AsyncGenerator<AgentServerMessage, void, void> {
    yield* runToolCallInner(params);
}

async function* runToolCallInner(params: Parameters<typeof runToolCall>[0]): AsyncGenerator<AgentServerMessage, void, void> {
    const tc = params.toolCall;
    const resolvedTool = resolveToolCall(tc.name, tc.input, params.availableMcpTools);
    const cursorToolType = resolvedTool.cursorToolType;
    const execArgsType = mapToolToExecArgs(cursorToolType);
    const modelCallId = `${params.conversationId}-${params.round}-${tc.callId.slice(-4)}`;

    // sanitizedInput 兜底补全:
    //
    //   - taskToolCall: BYOK 模式下 SubAgent 必须继承主对话模型 (方案 A)。
    //     即便 taskTool.ts 的 schema 已经移除 model 字段, 这里仍然无条件强制
    //     覆盖 model / modelId —— 防御 LLM 记忆里残留的 "composer-2-fast" 等
    //     官方 fallback 路由名通过 schema 之外的途径溜进来 (例如 LLM 在
    //     arguments 里塞了非 schema 字段)。客户端侧 SubAgent 靠这个字段决定
    //     走哪个模型, 错了就直接挂。
    let sanitizedInput = resolvedTool.sanitizedInput;
    if (cursorToolType === 'taskToolCall') {
        const subagentType = (sanitizedInput.subagent_type ?? sanitizedInput.subagentType ?? 'explore') as string;
        const resolvedModelId = resolveSubagentModel(subagentType, params.currentModelId, params.subagentModelOverrides);
        sanitizedInput = { ...sanitizedInput, model: resolvedModelId, modelId: resolvedModelId };
    }
    let startedArgs: Record<string, unknown>;
    try {
        startedArgs = buildToolArgs(tc.name, sanitizedInput, tc.callId, {
            conversationId: params.conversationId,
            currentModelId: params.currentModelId,
        });
    } catch (e) {
        // server 端 buildArgs 失败（如文件读取/解析错误）→ 发送 proto error result，不发 exec
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.warn({ tool: tc.name, callId: tc.callId, error: errorMsg }, '[TOOL] buildStartedArgs failed');
        const errorArgs = { path: String(sanitizedInput.path ?? sanitizedInput.target_notebook ?? '') };
        yield toolCallStarted(tc.callId, cursorToolType, errorArgs, modelCallId);
        const errorResult = { result: { case: 'error', value: { message: errorMsg } } };
        yield toolCallCompleted(tc.callId, cursorToolType, errorArgs, errorResult, modelCallId);
        params.roundContext.recordToolResult(params.messages, params.roundContext.createToolResult({
            toolCallId: tc.callId,
            toolName: tc.name,
            content: `Error: ${errorMsg}`,
            isError: true,
        }));
        return;
    }

    // editToolCall (Edit/Write/ApplyPatch/EditNotebook):
    // 官方流程: editToolCallDelta → toolCallStarted → readArgs exec → server apply plan → writeArgs exec → toolCallCompleted。
    // 文件内容以 Client readResult 为准，Server 不再用本地 fs 预计算。
    if (cursorToolType === 'editToolCall' && params.session) {
        let plan;
        try {
            plan = buildEditPlan(tc.name, sanitizedInput, tc.callId, {
                conversationId: params.conversationId,
                currentModelId: params.currentModelId,
            });
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logger.warn({ tool: tc.name, callId: tc.callId, error: errorMsg }, '[TOOL] editToolCall buildEditPlan failed');
            yield toolCallStarted(tc.callId, cursorToolType, startedArgs, modelCallId);
            const errorResult = { result: { case: 'error', value: { message: errorMsg } } };
            yield toolCallCompleted(tc.callId, cursorToolType, startedArgs, errorResult, modelCallId);
            params.roundContext.recordToolResult(params.messages, params.roundContext.createToolResult({
                toolCallId: tc.callId,
                toolName: tc.name,
                content: `Error: ${errorMsg}`,
                isError: true,
            }));
            return;
        }

        yield* finalizeEditToolCall({
            session: params.session,
            toolName: tc.name,
            callId: tc.callId,
            modelCallId,
            startedArgs,
            input: sanitizedInput,
            plan,
            roundContext: params.roundContext,
            messages: params.messages,
            allocateExecMessageId: params.allocateExecMessageId,
        });
        return;
    }

    yield toolCallStarted(tc.callId, cursorToolType, startedArgs, modelCallId);

    // communicateUpdateToolCall: 服务端自动完成 (不走 exec)
    // 子代理通过此工具报告进度和最终摘要, 客户端从帧中提取 finalSummary
    if (cursorToolType === 'communicateUpdateToolCall') {
        const currentStep = typeof startedArgs.currentStep === 'string' ? startedArgs.currentStep : '';
        const result = {
            result: {
                case: 'success',
                value: {
                    currentStep,
                    messageIndex: params.messages.length,
                },
            },
        };
        const finalized = finalizeToolCall({
            roundContext: params.roundContext,
            messages: params.messages,
            cursorToolType,
            toolName: tc.name,
            callId: tc.callId,
            startedArgs,
            rawToolResult: result,
            input: sanitizedInput,
            modelCallId,
        });
        yield finalized.frame;
        logger.info({ tool: tc.name, currentStep, hasFinalSummary: !!startedArgs.finalSummary }, '[TOOL] communicateUpdate auto-completed');
        return;
    }

    // awaitToolCall (AwaitShell): 按后台 job 注册表分流 shell / subagent。
    //   - shell job  : readArgs 读取 {terminalsFolder}/{shellId}.txt 终端文件 (客户端默认通道)
    //   - subagent job: subagentAwaitArgs (agentId + timeoutMs) → SubagentAwaitResult
    // 路由依据是 launch 时登记的 kind,不靠猜路径前缀。
    // 核实: cursor-agent-exec(执行侧)只消费 server 下发的 exec 通道, 路由决定在 server 侧
    //       (客户端 forceServerSideSubagent / enableAwaitForSubagents, main.unminify.js:~834450)。
    if (cursorToolType === 'awaitToolCall' && params.session) {
        const taskId = str(sanitizedInput.task_id ?? sanitizedInput.taskId);
        const job = taskId ? getBackgroundJob(params.session, taskId) : undefined;
        const blockUntilMs = typeof sanitizedInput.block_until_ms === 'number'
            ? sanitizedInput.block_until_ms
            : typeof sanitizedInput.blockUntilMs === 'number'
                ? sanitizedInput.blockUntilMs
                : 30000;

        if (job?.kind === 'subagent') {
            // subagent: 走专用 subagentAwaitArgs 通道。
            const args = {
                agentId: job.agentId ?? taskId,
                timeoutMs: blockUntilMs,
            };
            const execId = `${tc.callId}-exec`;
            const execMessageId = params.allocateExecMessageId();
            yield execMessage(execMessageId, execId, 'subagentAwaitArgs', args);
            yield* finalizeExecTool({
                session: params.session,
                toolName: tc.name,
                callId: tc.callId,
                cursorToolType,
                execMessageId,
                modelCallId,
                startedArgs,
                input: sanitizedInput,
                roundContext: params.roundContext,
                messages: params.messages,
            });
            return;
        }

        // shell job (或未登记的 task_id, 保守按 shell 终端文件处理): readArgs 读终端文件。
        // 路径: {terminalsFolder}/{shellId}.txt。terminalsFolder 取注册表登记值或 session 兜底。
        const terminalsFolder = job?.terminalsFolder ?? params.session.terminalsFolder;
        const shellId = job?.shellId !== undefined ? String(job.shellId) : taskId;
        const path = terminalsFolder && shellId
            ? `${terminalsFolder}/${shellId}.txt`
            : str(sanitizedInput.path ?? taskId);
        const args: Record<string, unknown> = {
            path,
            toolCallId: tc.callId,
            ...(typeof sanitizedInput.offset === 'number' ? { offset: sanitizedInput.offset } : {}),
            ...(typeof sanitizedInput.limit === 'number' ? { limit: sanitizedInput.limit } : {}),
        };
        const execId = `${tc.callId}-exec`;
        const execMessageId = params.allocateExecMessageId();
        yield execMessage(execMessageId, execId, 'readArgs', args);
        yield* finalizeExecTool({
            session: params.session,
            toolName: tc.name,
            callId: tc.callId,
            cursorToolType,
            execMessageId,
            modelCallId,
            startedArgs,
            input: sanitizedInput,
            roundContext: params.roundContext,
            messages: params.messages,
        });
        return;
    }

    if (execArgsType && params.session) {
        let args: Record<string, unknown>;
        try {
            const execModelId = cursorToolType === 'taskToolCall' && typeof sanitizedInput.modelId === 'string'
                ? sanitizedInput.modelId
                : params.currentModelId;
            args = buildExecArgs(tc.name, sanitizedInput, tc.callId, {
                conversationId: params.conversationId,
                currentModelId: execModelId,
            });
        } catch (e) {
            // server 端 buildExecArgs 失败 → 发送 error result
            const errorMsg = e instanceof Error ? e.message : String(e);
            logger.warn({ tool: tc.name, callId: tc.callId, error: errorMsg }, '[TOOL] buildExecArgs failed');
            const errorResult = { result: { case: 'error', value: { message: errorMsg } } };
            yield toolCallCompleted(tc.callId, cursorToolType, startedArgs, errorResult, modelCallId);
            params.roundContext.recordToolResult(params.messages, params.roundContext.createToolResult({
                toolCallId: tc.callId,
                toolName: tc.name,
                content: `Error: ${errorMsg}`,
                isError: true,
            }));
            return;
        }
        const execId = `${tc.callId}-exec`;
        const execMessageId = params.allocateExecMessageId();
        yield execMessage(execMessageId, execId, execArgsType, args);
        yield* finalizeExecTool({
            session: params.session,
            toolName: tc.name,
            callId: tc.callId,
            cursorToolType,
            execMessageId,
            modelCallId,
            startedArgs,
            input: sanitizedInput,
            roundContext: params.roundContext,
            messages: params.messages,
                    });
        return;
    }

    if (cursorToolType === 'askQuestionToolCall' && params.session) {
        yield* finalizeInteractionTool({
            session: params.session,
            interactionId: params.allocateInteractionId(),
            queryCase: 'askQuestionInteractionQuery',
            queryValue: {
                args: startedArgs,
                toolCallId: tc.callId,
            },
            expectedResponseCase: 'askQuestionInteractionResponse',
            buildRawToolResult: (interactionResponse) => buildAskQuestionResultFromInteractionResponse(interactionResponse),
            roundContext: params.roundContext,
            messages: params.messages,
                        cursorToolType,
            toolName: tc.name,
            callId: tc.callId,
            startedArgs,
            input: sanitizedInput,
            modelCallId,
        });
        return;
    }

    if (cursorToolType === 'webSearchToolCall') {
        let approved = true
        let rejectionResult: ToolResultEnvelope | undefined
        if (params.session) {
            const interactionId = params.allocateInteractionId()
            yield interactionQuery(interactionId, 'webSearchRequestQuery', { args: startedArgs })
            const response = yield* waitForInteractionResponseWithHeartbeat(params.session, interactionId, 'webSearchRequestResponse', null)
            const ir = response ? (response.interactionResponse as Record<string, unknown>) : null
            if (ir) {
                const approval = buildWebSearchApprovalResultFromInteractionResponse(ir)
                if (!approval.approved) {
                    approved = false
                    rejectionResult = approval.result ?? buildLocalToolResult(cursorToolType, sanitizedInput)
                }
            }
        }

        let rawToolResult: ToolResultEnvelope
        if (approved) {
            try {
                const refs = yield* waitForPromiseWithHeartbeat(performWebSearch(String(sanitizedInput.searchTerm || sanitizedInput.search_term || '')))
                rawToolResult = { result: { case: 'success', value: { references: refs } } }
            }
            catch (e) {
                rawToolResult = { result: { case: 'error', value: { error: e instanceof Error ? e.message : 'web search failed' } } }
            }
        }
        else {
            rawToolResult = rejectionResult!
        }

        const finalized = finalizeToolCall({
            roundContext: params.roundContext,
            messages: params.messages,
            cursorToolType,
            toolName: tc.name,
            callId: tc.callId,
            startedArgs,
            rawToolResult,
            input: sanitizedInput,
            modelCallId,
        })
        yield finalized.frame
        return
    }

    if (cursorToolType === 'webFetchToolCall') {
        // Phase 1: 审批（skipApproval=true 表示客户端自动批准，但仍需走交互握手）
        let approved = true
        let rejectionResult: ToolResultEnvelope | undefined
        if (params.session) {
            const interactionId = params.allocateInteractionId()
            yield interactionQuery(interactionId, 'webFetchRequestQuery', { args: startedArgs })
            const response = yield* waitForInteractionResponseWithHeartbeat(params.session, interactionId, 'webFetchRequestResponse', null)
            const ir = response ? (response.interactionResponse as Record<string, unknown>) : null
            if (ir) {
                const approval = buildWebFetchApprovalResultFromInteractionResponse(ir)
                if (!approval.approved) {
                    approved = false
                    rejectionResult = approval.result ?? buildLocalToolResult(cursorToolType, sanitizedInput)
                }
            }
        }

        // Phase 2: 异步执行
        let rawToolResult: ToolResultEnvelope
        if (approved) {
            try {
                const fetchResult = yield* waitForPromiseWithHeartbeat(performWebFetch(String(sanitizedInput.url || '')))
                rawToolResult = { result: { case: 'success', value: { url: fetchResult.url, markdown: fetchResult.markdown } } }
            }
            catch (e) {
                rawToolResult = { result: { case: 'error', value: { url: String(sanitizedInput.url || ''), error: e instanceof Error ? e.message : 'web fetch failed' } } }
            }
        }
        else {
            rawToolResult = rejectionResult!
        }

        // Phase 3: 结果封装
        const finalized = finalizeToolCall({
            roundContext: params.roundContext,
            messages: params.messages,
            cursorToolType,
            toolName: tc.name,
            callId: tc.callId,
            startedArgs,
            rawToolResult,
            input: sanitizedInput,
            modelCallId,
        })
        yield finalized.frame
        return
    }

    // createPlanToolCall: 交互握手 (CreatePlanRequestQuery → CreatePlanRequestResponse)
    if (cursorToolType === 'createPlanToolCall' && params.session) {
        yield* finalizeInteractionTool({
            session: params.session,
            interactionId: params.allocateInteractionId(),
            queryCase: 'createPlanRequestQuery',
            queryValue: {
                args: startedArgs,
                toolCallId: tc.callId,
            },
            expectedResponseCase: 'createPlanRequestResponse',
            buildRawToolResult: (interactionResponse) => {
                const resp = interactionResponse as Record<string, unknown> | undefined;
                // interactionResponse 结构: { id, createPlanRequestResponse: { result: { success:{}, planUri } } }
                const inner = resp?.createPlanRequestResponse as Record<string, unknown> | undefined;
                const result = inner?.result as Record<string, unknown> | undefined;
                if (result?.success !== undefined) {
                    return {
                        result: { case: 'success', value: {} },
                        ...(typeof result.planUri === 'string' ? { planUri: result.planUri } : {}),
                    };
                }
                return { result: { case: 'error', value: { error: 'CreatePlan failed' } } };
            },
            roundContext: params.roundContext,
            messages: params.messages,
            cursorToolType,
            toolName: tc.name,
            callId: tc.callId,
            startedArgs,
            input: sanitizedInput,
            modelCallId,
        });
        return;
    }

    // switchModeToolCall: 交互握手 (switchModeRequestQuery → switchModeRequestResponse)
    // 抓包实证 (GPT.jsonl idx=27/6):
    //   Server → Client: interactionQuery { switchModeRequestQuery { args { targetModeId, explanation, toolCallId } } }
    //   Client → Server: interactionResponse { switchModeRequestResponse { approved {} } }
    // 用户批准后才真正切换模式。
    if (cursorToolType === 'switchModeToolCall' && params.session) {
        yield* finalizeInteractionTool({
            session: params.session,
            interactionId: params.allocateInteractionId(),
            queryCase: 'switchModeRequestQuery',
            queryValue: {
                args: startedArgs,
                toolCallId: tc.callId,
            },
            expectedResponseCase: 'switchModeRequestResponse',
            buildRawToolResult: (interactionResponse) => {
                const resp = interactionResponse as Record<string, unknown> | undefined;
                // interactionResponse 结构: { id, switchModeRequestResponse: { approved:{} } }
                const inner = resp?.switchModeRequestResponse as Record<string, unknown> | undefined;
                if (inner?.approved) {
                    const targetModeId = typeof sanitizedInput.target_mode_id === 'string'
                        ? sanitizedInput.target_mode_id
                        : typeof sanitizedInput.targetModeId === 'string'
                            ? sanitizedInput.targetModeId
                            : 'agent';
                    return { result: { case: 'success', value: { toModeId: targetModeId } } };
                }
                return { result: { case: 'error', value: { error: 'Mode switch rejected by user' } } };
            },
            roundContext: params.roundContext,
            messages: params.messages,
            cursorToolType,
            toolName: tc.name,
            callId: tc.callId,
            startedArgs,
            input: sanitizedInput,
            modelCallId,
        });
        return;
    }

    const finalized = finalizeToolCall({
        roundContext: params.roundContext,
        messages: params.messages,
                cursorToolType,
        toolName: tc.name,
        callId: tc.callId,
        startedArgs,
        rawToolResult: buildLocalToolResult(cursorToolType, sanitizedInput),
        input: sanitizedInput,
        modelCallId,
    });
    yield finalized.frame;
}

// ── Task 并发支持 ──

/** Phase 1: 发送 toolCallStarted + execMessage，不等待结果 */
export async function* launchTaskTool(params: {
    toolCall: ToolCallInfo;
    availableMcpTools: AvailableMcpTool[];
    conversationId: string;
    currentModelId: string;
    subagentModelOverrides?: SubagentModelOverride[];
    round: number;
    allocateExecMessageId: () => number;
}): AsyncGenerator<AgentServerMessage, TaskLaunchContext | null, void> {
    const tc = params.toolCall;
    const resolvedTool = resolveToolCall(tc.name, tc.input, params.availableMcpTools);
    const cursorToolType = resolvedTool.cursorToolType;
    const modelCallId = `${params.conversationId}-${params.round}-${tc.callId.slice(-4)}`;

    let sanitizedInput = resolvedTool.sanitizedInput;
    const subagentType = (sanitizedInput.subagent_type ?? sanitizedInput.subagentType ?? 'explore') as string;
    const resolvedModelId = resolveSubagentModel(subagentType, params.currentModelId, params.subagentModelOverrides);
    sanitizedInput = { ...sanitizedInput, model: resolvedModelId, modelId: resolvedModelId };

    logger.info({
        callId: tc.callId,
        runInBackground: sanitizedInput.run_in_background ?? sanitizedInput.runInBackground ?? '(unset)',
        resume: sanitizedInput.resume ?? '(none)',
        subagentType,
        resolvedModelId,
    }, '[TOOL] taskToolCall dispatching');

    let startedArgs: Record<string, unknown>;
    try {
        startedArgs = buildToolArgs(tc.name, sanitizedInput, tc.callId, {
            conversationId: params.conversationId,
            currentModelId: params.currentModelId,
        });
    }
    catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.warn({ tool: tc.name, callId: tc.callId, error: errorMsg }, '[TOOL] taskToolCall buildStartedArgs failed');
        return null;
    }

    yield toolCallStarted(tc.callId, cursorToolType, startedArgs, modelCallId);

    let args: Record<string, unknown>;
    try {
        const execModelId = typeof sanitizedInput.modelId === 'string'
            ? sanitizedInput.modelId
            : params.currentModelId;
        args = buildExecArgs(tc.name, sanitizedInput, tc.callId, {
            conversationId: params.conversationId,
            currentModelId: execModelId,
        });
    }
    catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.warn({ tool: tc.name, callId: tc.callId, error: errorMsg }, '[TOOL] taskToolCall buildExecArgs failed');
        return null;
    }

    const execMessageId = params.allocateExecMessageId();
    yield execMessage(execMessageId, `${tc.callId}-exec`, 'subagentArgs', args);

    return { tc, execMessageId, modelCallId, startedArgs, sanitizedInput, cursorToolType };
}

/** Phase 3: 并发 await 全部 Task 结果，生成 completedFrame */
export function finalizeTaskResult(
    ctx: TaskLaunchContext,
    execResult: Record<string, unknown> | null,
    roundContext: Pick<ProviderRoundContext, 'createToolResult' | 'recordToolResult'>,
    messages: LLMMessage[],
    session?: AgentSession | null,
): AgentServerMessage {
    if (execResult && 'execClientMessage' in execResult) {
        const ecm = execResult.execClientMessage as Record<string, unknown>;
        const sr = ecm.subagentResult as Record<string, unknown> | undefined;
        const success = sr?.success as Record<string, unknown> | undefined;
        logger.info({
            tool: ctx.tc.name,
            callId: ctx.tc.callId,
            agentId: success?.agentId,
            toolCallCount: success?.toolCallCount,
            finalMsgLen: typeof success?.finalMessage === 'string' ? success.finalMessage.length : 0,
        }, '[TOOL] task exec result received');

        // subagent 转后台 (SubagentSuccess.background_reason != 0): 登记后台 job,
        // 供后续 AwaitShell(task_id=agentId) 走 subagentAwaitArgs 通道轮询。
        if (session && success && typeof success.agentId === 'string') {
            const reason = success.backgroundReason;
            const isBg = (typeof reason === 'number' && reason !== 0)
                || (typeof reason === 'string' && reason !== 'SUBAGENT_BACKGROUND_REASON_UNSPECIFIED' && reason !== 'UNSPECIFIED' && reason !== '0' && reason !== '');
            if (isBg) {
                registerBackgroundJob(session, success.agentId, {
                    kind: 'subagent',
                    agentId: success.agentId,
                    ...(typeof success.transcriptPath === 'string' ? { transcriptPath: success.transcriptPath } : {}),
                });
            }
        }

        const finalized = finalizeToolCall({
            roundContext,
            messages,
            cursorToolType: ctx.cursorToolType,
            toolName: ctx.tc.name,
            callId: ctx.tc.callId,
            startedArgs: ctx.startedArgs,
            rawToolResult: buildExecToolResult(ctx.cursorToolType, ecm, ctx.sanitizedInput),
            input: ctx.sanitizedInput,
            modelCallId: ctx.modelCallId,
        });
        return finalized.frame;
    }

    logger.warn({ tool: ctx.tc.name, callId: ctx.tc.callId }, '[TOOL] task exec ended without result');
    const finalized = finalizeToolCall({
        roundContext,
        messages,
        cursorToolType: ctx.cursorToolType,
        toolName: ctx.tc.name,
        callId: ctx.tc.callId,
        startedArgs: ctx.startedArgs,
        rawToolResult: { result: { case: 'error', value: { message: 'no result' } } },
        input: ctx.sanitizedInput,
        modelCallId: ctx.modelCallId,
    });
    return finalized.frame;
}
