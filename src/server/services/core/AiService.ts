/**
 * aiserver.v1.AiService — 核心 AI 服务
 *
 * Cursor 最大的服务 (183 方法)，承载几乎所有 AI 能力：
 *   - 模型管理: AvailableModels, GetDefaultModel, CheckQueuePosition
 *   - 对话: StreamChat, StreamChatTryReallyHard, StreamComposer, StreamEdit
 *   - 补全: StreamCpp, StreamNextCursorPrediction, CppConfig, CppAppend
 *   - Agent: InterfaceAgentInit, StreamInterfaceAgentStatus
 *   - 任务: TaskInit, TaskInfo, TaskStreamLog, TaskSendMessage
 *   - 知识库: KnowledgeBaseList, KnowledgeBaseAdd, AvailableDocs
 *   - 配置: ServerTime, HealthCheck, CppConfig, CppEditHistoryStatus
 *   - 遥测: ReportClientNumericMetrics, UpdateVscodeProfile, ReportFeedback
 *
 * Transport: backendUrl (api2.cursor.sh)
 *   部分方法有独立 transport 覆盖:
 *     - streamNextCursorPrediction, getCppEditClassification, streamCpp → geoCppTransport
 *     - cppConfig → cppConfigTransport
 *     - cppEditHistoryAppend, cppAppend → telemTransport
 *     - streamStt, streamBugBotAgentic, streamUiBestOfNJudge → agenticComposerTransport
 *
 * 拦截策略 (与 ~/.ccursor/routes.json redirect 白名单配合):
 *   - AvailableModels: 双源合并 (上游官方订阅 + 本地 BYOK providers.json)
 *   - StreamChat / StreamUiApply / 其他被白名单覆盖的方法: 由各 stream 实现处理
 *   - 未列入白名单的方法: 不会到我们这里, 直通官方
 */
import type { ConnectRouter } from '@connectrpc/connect'
import { create } from '@bufbuild/protobuf'
import {
  AiService,
  AvailableModelsResponse_FeatureModelConfigSchema,
  AvailableModelsResponseSchema,
} from '../../gen/aiserver_v1_pb'
import { buildByokAvailableModels } from '../../handlers/models/byokModelBuilder'
import { logger } from '../../logger'

/**
 * BYOK ON 模式下,客户端能命中我们这里就说明白名单生效中。
 * 直接返回 providers.json 整合后的本地 BYOK 模型列表,不再合并上游。
 *
 * BYOK OFF 模式下,白名单不含 AvailableModels,这个 handler 根本不会被调用 ——
 * 客户端直接拿到官方真实订阅列表。
 */
async function handleAvailableModels() {
  const byok = buildByokAvailableModels()
  logger.info({ count: byok.length }, '[MODEL] availableModels (BYOK only)')
  return create(AvailableModelsResponseSchema, {
    models: byok,
    modelNames: byok.map(m => m.name),
    // feature config 给空 stub,Cursor 客户端遇到空 config 会用内置默认行为
    composerModelConfig: create(AvailableModelsResponse_FeatureModelConfigSchema, {}),
    cmdKModelConfig: create(AvailableModelsResponse_FeatureModelConfigSchema, {}),
    backgroundComposerModelConfig: create(AvailableModelsResponse_FeatureModelConfigSchema, {}),
    useModelParameters: false,
  })
}

export default (router: ConnectRouter) => {
  router.service(AiService, {
    serverTime: async () => ({
      receiveTimestamp: Date.now(),
      transmitTimestamp: Date.now(),
    }),

    availableModels: handleAvailableModels,

    getDefaultModel: async () => ({}),
    getDefaultModelNudgeData: async () => ({ nudgeDate: '0' }),
    cppConfig: async () => ({
      isOn: true,
      isGhostText: true,
      shouldLetUserEnableCppEvenIfNotPro: true,
    }),
    cppEditHistoryStatus: async () => ({ on: true, onlyIfExplicit: true }),
    availableDocs: async () => ({ docs: [] }),
    knowledgeBaseList: async () => ({ success: true }),
    knowledgeBaseAdd: async () => ({ success: true, id: '0' }),
    reportClientNumericMetrics: async () => ({}),
    updateVscodeProfile: async () => ({}),
  })
}
