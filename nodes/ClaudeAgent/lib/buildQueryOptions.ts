import { mergeSdkEnvWithProcess } from '../../shared/lib/buildSdkEnv';
import type { ClaudeModelConfig } from '../../shared/lib/types';
import {
	buildClaudeMcpAllowedTools,
	buildClaudeMcpDisallowedTools,
	resolveClaudeMcpPreApprovedTools,
} from './mcpToolAccess';
import { mergeDisallowedTools, PERMISSION_PRESETS, resolvePermissionPreset } from './permissionPresets';
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
}

export function applySystemPromptToOptions(
	queryOptions: Record<string, unknown>,
	input: Pick<BuildQueryOptionsInput, 'continuation' | 'systemMessage' | 'useClaudeCodePreset'>,
): void {
	if (input.continuation.kind !== 'new') return;
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

	const queryOptions: Record<string, unknown> = {
		cwd: input.cwd,
		...(input.additionalDirectories && input.additionalDirectories.length > 0
			? { additionalDirectories: input.additionalDirectories }
			: {}),
		settingSources: input.hasWorkspaceConfig ? input.settingSources : ['project'],
		includePartialMessages: true,
		model: input.modelConfig.model,
		env: mergeSdkEnvWithProcess(input.modelConfig.sdkEnv),
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
	return queryOptions;
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
