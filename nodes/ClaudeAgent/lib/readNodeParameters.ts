import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INode } from 'n8n-workflow';

import type { SessionRuntimeMode } from '../../shared/lib/types';
import type { McpToolAccessConfig } from './mcpToolAccess';
import type { McpServersFormValue } from './parseMcpServers';
import { readRedisCredentials, type RedisCredentials } from './sessionStore';

type SettingSource = 'user' | 'project' | 'local' | 'team' | 'plugins';

export interface ClaudeAgentRunParams {
	systemMessage: string;
	chatInput: string;
	sessionId: string;
	sessionTtlSeconds: number;
	sessionRuntime: SessionRuntimeMode;
	sidecarUrl: string;
	skillsRoot: string;
	workingDirectories: string[];
	workingDirectory: string;
	settingSources: SettingSource[];
	skills?: string[] | 'all';
	permissionPreset: string;
	maxTurns: number;
	useClaudeCodePreset: boolean;
	strictMcpConfig: boolean;
	mcpServersForm: McpServersFormValue;
	mcpServersJson: string;
	mcpToolAccess: McpToolAccessConfig;
	hasWorkspaceConfig: boolean;
}

function readSettingSources(raw: string | string[] | undefined): SettingSource[] {
	if (!raw || (Array.isArray(raw) && raw.length === 0)) return ['project'];
	const values = Array.isArray(raw) ? raw : [raw];
	return values.filter(Boolean) as SettingSource[];
}

function readSkills(raw: string | undefined): string[] | 'all' | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	if (trimmed.toLowerCase() === 'all') return 'all';
	return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

function pickString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function pickStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => String(item ?? '')).filter(Boolean);
	if (typeof value === 'string' && value.trim()) return [value.trim()];
	return [];
}

export function readClaudeAgentRunParams(
	ctx: IExecuteFunctions,
	itemIndex: number,
): ClaudeAgentRunParams {
	const options = ctx.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const session = (options.session ?? {}) as IDataObject;
	const workspace = (options.workspace ?? {}) as IDataObject;
	const agentBehavior = (options.agentBehavior ?? {}) as IDataObject;
	const mcp = (options.mcp ?? {}) as IDataObject;

	const legacyAdditional = ctx.getNodeParameter('additionalOptions', itemIndex, {}) as IDataObject;
	const legacyMcpForm = (legacyAdditional.mcpServers ?? {}) as McpServersFormValue;

	const skillsRoot =
		pickString(workspace.skillsRoot)
		|| pickString(ctx.getNodeParameter('skillsRoot', itemIndex, ''));
	const workingDirectories =
		pickStringArray(workspace.workingDirectories).length > 0
			? pickStringArray(workspace.workingDirectories)
			: pickStringArray(ctx.getNodeParameter('workingDirectories', itemIndex, []));
	const workingDirectory =
		pickString(workspace.workingDirectory)
		|| pickString(ctx.getNodeParameter('workingDirectory', itemIndex, ''));

	const settingSourcesRaw =
		workspace.settingSources !== undefined
			? workspace.settingSources
			: ctx.getNodeParameter('settingSources', itemIndex, ['project']);

	const skillsRaw =
		pickString(workspace.skills)
		|| pickString(ctx.getNodeParameter('skills', itemIndex, ''));

	const sessionId =
		pickString(session.sessionId)
		|| pickString(ctx.getNodeParameter('sessionId', itemIndex, ''));

	const sessionTtlSeconds = Number(
		session.sessionTtlSeconds
		?? legacyAdditional.sessionTtlSeconds
		?? 604800,
	);

	const sessionRuntimeRaw = pickString(session.sessionRuntime) || 'sidecar';
	const sessionRuntime: SessionRuntimeMode =
		sessionRuntimeRaw === 'stateless' ? 'stateless' : 'sidecar';

	const sidecarUrl =
		pickString(session.sidecarUrl)
		|| 'http://127.0.0.1:18790';

	const permissionPreset =
		pickString(agentBehavior.permissionPreset)
		|| pickString(ctx.getNodeParameter('permissionPreset', itemIndex, 'customer_service'))
		|| 'customer_service';

	const maxTurnsRaw = Number(
		agentBehavior.maxTurns
		?? ctx.getNodeParameter('maxTurns', itemIndex, 0)
		?? 0,
	);

	const useClaudeCodePreset =
		agentBehavior.useClaudeCodePreset !== undefined
			? agentBehavior.useClaudeCodePreset !== false
			: legacyAdditional.useClaudeCodePreset !== false;

	const strictMcpConfig = Boolean(
		mcp.strictMcpConfig
		?? legacyAdditional.strictMcpConfig,
	);

	const mcpServersForm = (mcp.mcpServers ?? legacyMcpForm ?? {}) as McpServersFormValue;
	const mcpServersJson = pickString(mcp.mcpServersJson)
		|| pickString(legacyAdditional.mcpServersJson);

	const mcpToolAccessRaw = (mcp.mcpToolAccess ?? {}) as IDataObject;
	const mcpToolAccess: McpToolAccessConfig = {
		filterMode: (pickString(mcpToolAccessRaw.filterMode) || 'none') as McpToolAccessConfig['filterMode'],
		deniedToolsRaw: pickString(mcpToolAccessRaw.deniedTools),
		allowedToolsRaw: pickString(mcpToolAccessRaw.allowedTools),
		allowComplementCatalogRaw: pickString(mcpToolAccessRaw.allowComplementCatalog),
	};

	const hasWorkspaceConfig = Boolean(
		skillsRoot.trim()
		|| workingDirectories.length > 0
		|| workingDirectory.trim()
		|| skillsRaw.trim()
		|| (Array.isArray(settingSourcesRaw) && settingSourcesRaw.length > 0)
		|| (typeof settingSourcesRaw === 'string' && settingSourcesRaw.trim()),
	);

	return {
		systemMessage: pickString(ctx.getNodeParameter('systemMessage', itemIndex, '')),
		chatInput: pickString(ctx.getNodeParameter('chatInput', itemIndex, '')),
		sessionId: sessionId.trim(),
		sessionTtlSeconds,
		sessionRuntime,
		sidecarUrl: sidecarUrl.trim(),
		skillsRoot: skillsRoot.trim(),
		workingDirectories,
		workingDirectory: workingDirectory.trim(),
		settingSources: readSettingSources(settingSourcesRaw as string | string[] | undefined),
		skills: readSkills(skillsRaw),
		permissionPreset,
		maxTurns: maxTurnsRaw,
		useClaudeCodePreset,
		strictMcpConfig,
		mcpServersForm,
		mcpServersJson,
		mcpToolAccess,
		hasWorkspaceConfig,
	};
}

export async function tryGetRedisCredentials(
	ctx: IExecuteFunctions,
): Promise<RedisCredentials | undefined> {
	try {
		return readRedisCredentials(await ctx.getCredentials('redis'));
	} catch {
		return undefined;
	}
}

export function resolveRedisForSession(
	node: INode,
	sessionId: string,
	redis: RedisCredentials | undefined,
	itemIndex: number,
): RedisCredentials | undefined {
	if (!sessionId) return undefined;
	if (!redis) {
		throw new NodeOperationError(
			node,
			'Session ID is set but no Redis credential is configured on this node. '
				+ 'Add a Redis credential under Options → Session, or clear Session ID.',
			{ itemIndex },
		);
	}
	return redis;
}
