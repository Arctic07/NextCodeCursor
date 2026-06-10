/**
 * aiserver.v1.DashboardService — 账户/设置/管理服务
 *
 * 306 方法，Cursor 最大的管理服务，涵盖:
 *   - 计费 (28): GetPlanInfo, GetCurrentPeriodUsage, GetUsageLimitStatus, IsOnNewPricing...
 *   - 团队 (77): GetTeams, GetTeamAdminSettings, SendTeamInvite, ChangeSeat...
 *   - 插件 (27): GetEffectiveUserPlugins, GetManagedSkills, InstallUserPlugin...
 *   - Slack (19): GetSlackInstallUrl, SetSlackAuth, GetSlackTeamSettings...
 *   - GitHub/Linear (22): ConnectGithubCallback, ConnectLinearCallback...
 *   - MCP (12): GetPluginMcpConfig, StoreMcpOAuthToken...
 *   - 命令 (2): GetGlobalCommands, GetTeamCommands
 *   - 隐私 (4): GetUserPrivacyMode, SetPrivacyMode...
 *   - 反馈 (19): SubmitFeedback, ReportBugbotDeeplinkEvent...
 *   - BGComposer (5): ListBackgroundComposerSecrets, CreateBackgroundComposerSecret...
 *   - 其他 (71): GetDefaultModel, GetServerConfig, Bedrock IAM...
 *
 * Transport: backendUrl (api2.cursor.sh)
 *   部分方法有 transport 覆盖:
 *     - listBackgroundComposerSecrets, create/revoke → backgroundComposerProxyTransport
 */
import type { ConnectRouter } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
    DashboardService,
    GetPlanInfoResponse_PlanInfoSchema,
    GetCurrentPeriodUsageResponse_PlanUsageSchema,
    PrivacyMode,
    GetUsageLimitStatusAndActiveGrantsResponse_UsageLimitPolicyStatusSchema,
} from '../../gen/aiserver_v1_pb';
import { exportCanvasHtml, getCanvasesDir, lookupCanvasByKey, storeCanvas } from '../../handlers/canvas/canvasStore';
import { fetchManagedSkills } from '../../config/managedSkillsStore';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default (router: ConnectRouter) => {
    router.service(DashboardService, {
        getPlanInfo: async () => ({
            planInfo: create(GetPlanInfoResponse_PlanInfoSchema, {
                planName: 'Pro',
                includedAmountCents: 999900,
                price: '$0/mo (BYOK)',
                billingCycleEnd: BigInt(Date.now() + 365 * 86400000),
            }),
        }),

        getCurrentPeriodUsage: async () => ({
            billingCycleStart: BigInt(Date.now() - 30 * 86400000),
            billingCycleEnd: BigInt(Date.now() + 30 * 86400000),
            planUsage: create(GetCurrentPeriodUsageResponse_PlanUsageSchema, {
                remaining: 999900,
                limit: 999900,
            }),
            enabled: true,
            displayMessage: 'BYOK — unlimited',
        }),

        getTeams: async () => ({}),
        getUserPrivacyMode: async () => ({ privacyMode: PrivacyMode.NO_TRAINING }),

        getUsageLimitStatusAndActiveGrants: async () => ({
            usageLimitPolicyStatus: create(GetUsageLimitStatusAndActiveGrantsResponse_UsageLimitPolicyStatusSchema, {
                canConfigureSpendLimit: true,
            }),
        }),

        getEffectiveUserPlugins: async () => ({}),
        // 插件市场 — 后续可考虑透传到官方 API 获取真实数据
        listMarketplacePlugins: async () => ({ plugins: [] }),
        isOnNewPricing: async () => ({ isOnNewPricing: true }),
        getManagedSkills: async (_req, { requestHeader }) => {
            return await fetchManagedSkills(requestHeader ?? new Headers()) as any
        },
        getTeamAdminSettingsOrEmptyIfNotInTeam: async () => ({}),
        getTeamReposOrEmptyIfNotInTeam: async () => ({}),
        // 3.6 新增: 不带 OrEmpty 后缀 — 非 team 用户打官方返回 unauthenticated 重试风暴
        getTeamAdminSettings: async () => ({}),
        getTeamBackgroundAgentSettings: async () => ({}),
        getTeamRepos: async () => ({}),
        // GetMe — 合成 BYOK 身份 (无 teamId = 非 team 用户,不触发 team 相关逻辑)
        getMe: async () => ({
            authId: 'byok-local',
            userId: 1,
            isEnterpriseUser: false,
        }),
        getGlobalCommands: async () => ({}),
        getTeamCommands: async () => ({}),
        getSlackInstallUrl: async () => ({}),

        shareCanvas: async (req) => {
            const result = storeCanvas({
                title: req.title,
                appJs: req.appJs,
                dataJson: req.dataJson,
                canvasKey: req.canvasKey,
            })
            const html = exportCanvasHtml({
                title: req.title,
                appJsGzip: req.appJs,
                dataJson: req.dataJson,
            })
            const safeName = (req.title || 'canvas').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'canvas'
            const exportPath = join(getCanvasesDir(), `${safeName}.html`)
            writeFileSync(exportPath, html)
            return { shareId: result.shareId, shareUrl: `file://${exportPath}` }
        },

        lookupSharedCanvasByKey: async (req) => {
            const meta = lookupCanvasByKey(req.canvasKey)
            if (!meta) return {}
            return { shareId: meta.shareId, shareUrl: `file://${join(meta.dir, 'export.html')}` }
        },
    });
};
