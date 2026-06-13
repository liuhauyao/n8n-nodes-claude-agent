import { mergeSdkEnvWithProcess } from '../../shared/lib/buildSdkEnv';
import type { ClaudeModelConfig } from '../../shared/lib/types';
import {
	buildDeclarativeHooks,
	createHookRuntimeState,
	parseHooksJson,
	type HookRuntimeState,
} from './buildDeclarativeHooks';
import {
	buildClaudeMcpAllowedTools,
	buildClaudeMcpDisallowedTools,
	resolveClaudeMcpPreApprovedTools,
} from './mcpToolAccess';
import { applyToolSearchEnv, buildOutputFormatOption, parseJsonObject } from './parseExtendedOptions';
import { mergeDisallowedTools, PERMISSION_PRESETS, resolvePermissionPreset } from './permissionPresets';
import type { ToolSearchMode } from './readNodeParameters';
import type { SessionContinuation } from './sessionContinuation';
import { buildUtf8GuardCanUseTool } from './utf8ReplacementGuard';

type SettingSource = 'user' | 'project' | 'local' | 'team' | 'plugins';

export interface BuildQueryOptionsInput {
	continuation: SessionContinuation;
	modelConfig: ClaudeModelConfig;
	cwd: string;
	additionalDirectories?: string[];
	settingSources: SettingSource[];
	hasWorkspaceConfig: boolean;
	systemMessage: string;
	useClaudeCodePreset: boolean;
	mcpServers: Record<string, unknown>;
	mcpServerNames: string[];
	mcpDisallowedSdk: string[];
	mcpAllowedSdk: string[];
	mcpPreApproved: string[];
	permissionPreset: string;
	strictMcpConfig: boolean;
	skills?: string[] | 'all';
	maxTurns: number;
	thinkingEnabled?: boolean;
	maxThinkingTokens?: number;
	maxBudgetUsd?: number;
	forwardSubagentText?: boolean;
	outputFormatSchema?: string;
	outputFormatName?: string;
	toolSearchMode?: ToolSearchMode;
	hooksJson?: string;
	subagentsEnabled?: boolean;
	subagentsJson?: string;
	primaryAgentJson?: string;
	hookRuntimeState?: HookRuntimeState;
}

export function applySystemPromptToOptions(
	queryOptions: Record<string, unknown>,
	input: Pick<BuildQueryOptionsInput, 'continuation' | 'systemMessage' | 'useClaudeCodePreset'>,
): void {
	// 无论 new / resume / fork 均需注入：
	// 我们使用的 anthropic-openai-shim 完全无状态，每次 API 调用都必须携带 system 字段；
	// CLI 的 session JSONL 文件只存储对话历史，不持久化 systemPrompt。
	// resume 时不注入会导致 API 请求缺少 system 字段，模型退回为无角色默认行为。
	const systemMessage = input.systemMessage?.trim() ?? '';
	if (input.useClaudeCodePreset) {
		queryOptions.systemPrompt = systemMessage
			? { type: 'preset', preset: 'claude_code', append: systemMessage }
			: { type: 'preset', preset: 'claude_code' };
	} else if (systemMessage) {
		queryOptions.systemPrompt = systemMessage;
	}
}

export function buildQueryOptions(input: BuildQueryOptionsInput): Record<string, unknown> {
	const presetKey = resolvePermissionPreset(input.permissionPreset);
	const preset = PERMISSION_PRESETS[presetKey];
	const strictMcpConfig = input.strictMcpConfig || preset.defaultStrictMcpConfig === true;
	const hookState = input.hookRuntimeState ?? createHookRuntimeState();
	const mergedSdkEnv = applyToolSearchEnv(
		input.modelConfig.sdkEnv,
		input.toolSearchMode ?? 'unset',
	);
	const outputFormat = buildOutputFormatOption(input.outputFormatSchema, input.outputFormatName);
	const hooksConfig = parseHooksJson(input.hooksJson);
	const declarativeHooks = buildDeclarativeHooks(hooksConfig, hookState);
	const primaryAgent = parseJsonObject(input.primaryAgentJson);
	const subagents = input.subagentsEnabled
		? (() => {
			const parsed = input.subagentsJson?.trim();
			if (!parsed) return undefined;
			try {
				const arr = JSON.parse(parsed);
				return Array.isArray(arr) ? arr : undefined;
			} catch {
				return undefined;
			}
		})()
		: undefined;

	const queryOptions: Record<string, unknown> = {
		cwd: input.cwd,
		...(input.additionalDirectories && input.additionalDirectories.length > 0
			? { additionalDirectories: input.additionalDirectories }
			: {}),
		settingSources: input.hasWorkspaceConfig ? input.settingSources : ['project'],
		includePartialMessages: true,
		model: input.modelConfig.model,
		env: mergeSdkEnvWithProcess(mergedSdkEnv),
		...(input.continuation.kind === 'resume'
			? { resume: input.continuation.claudeSessionId }
			: {}),
		...(input.continuation.kind === 'fork'
			? {
				resume: input.continuation.sourceClaudeSessionId,
				forkSession: true,
			}
			: {}),
		...(Object.keys(input.mcpServers).length > 0 ? { mcpServers: input.mcpServers } : {}),
		...(strictMcpConfig ? { strictMcpConfig: true } : {}),
		...(input.skills ? { skills: input.skills } : {}),
		...(input.maxTurns > 0 ? { maxTurns: input.maxTurns } : {}),
		...(input.thinkingEnabled
			? {
				thinking: {
					type: 'enabled',
					budget_tokens: input.maxThinkingTokens && input.maxThinkingTokens > 0
						? input.maxThinkingTokens
						: 10000,
				},
			}
			: {}),
		...(input.maxBudgetUsd && input.maxBudgetUsd > 0 ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
		...(input.forwardSubagentText ? { forwardSubagentText: true } : {}),
		...(outputFormat ? { outputFormat } : {}),
		...(declarativeHooks ? { hooks: declarativeHooks } : {}),
		...(primaryAgent ? { agent: primaryAgent } : {}),
		...(subagents?.length ? { agents: subagents } : {}),
		...(preset.allowedTools || input.mcpPreApproved.length > 0
			? {
				allowedTools: [
					...(preset.allowedTools ?? []),
					...input.mcpPreApproved,
				],
			}
			: {}),
		disallowedTools: mergeDisallowedTools([
			...(preset.disallowedTools ?? []),
			...input.mcpDisallowedSdk,
		]),
		...(preset.permissionMode ? { permissionMode: preset.permissionMode } : {}),
		...(preset.allowDangerouslySkipPermissions
			? { allowDangerouslySkipPermissions: true }
			: {}),
		...(preset.tools !== undefined
			? {
				tools: Array.isArray(preset.tools)
					? [...preset.tools]
					: preset.tools,
			}
			: {}),
	};

	applySystemPromptToOptions(queryOptions, input);
	queryOptions.canUseTool = buildUtf8GuardCanUseTool();
	(queryOptions as Record<string, unknown> & { __hookRuntimeState?: HookRuntimeState }).__hookRuntimeState = hookState;
	return queryOptions;
}

export function getHookRuntimeState(queryOptions: Record<string, unknown>): HookRuntimeState | undefined {
	return (queryOptions as Record<string, unknown> & { __hookRuntimeState?: HookRuntimeState }).__hookRuntimeState;
}

export function buildMcpSdkLists(
	permissionPreset: string,
	mcpServerNames: string[],
	mcpToolAccess: Parameters<typeof resolveClaudeMcpPreApprovedTools>[2],
	mcpAllowedSdk: string[],
): { mcpPreApproved: string[] } {
	const presetKey = resolvePermissionPreset(permissionPreset);
	const mcpPreApproved = resolveClaudeMcpPreApprovedTools(
		presetKey === 'mcp_skills_only',
		mcpServerNames,
		mcpToolAccess,
		mcpAllowedSdk,
	);
	return { mcpPreApproved };
}

export {
	buildClaudeMcpAllowedTools,
	buildClaudeMcpDisallowedTools,
	resolveClaudeMcpPreApprovedTools,
};
