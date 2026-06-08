import {
	NodeConnectionTypes,
	NodeOperationError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { mergeSdkEnvWithProcess } from '../shared/lib/buildSdkEnv';
import {
	modelConfigSummary,
	resolveModelConfigForAgent,
} from '../shared/lib/resolveModelConfig';
import type { ClaudeModelConfig, StoredSessionRecord } from '../shared/lib/types';
import { claudeProviderCredentialTest } from '../shared/lib/claudeProviderCredentialTest';
import { CLAUDE_MODEL_CONFIG_FIELD } from '../shared/lib/types';
import { CLAUDE_AGENT_OPTIONS_PROPERTY } from './lib/agentOptionsProperties';
import { loadClaudeSdk } from './lib/loadClaudeSdk';
import {
	buildClaudeMcpAllowedTools,
	buildClaudeMcpDisallowedTools,
	listMcpServerNames,
	resolveAllowedMcpToolNames,
	resolveClaudeMcpPreApprovedTools,
	resolveDeniedMcpToolNames,
} from './lib/mcpToolAccess';
import { parseMcpServers, toClaudeSdkMcpServers } from './lib/parseMcpServers';
import { resolveWorkingDir } from './lib/resolveWorkingDir';
import {
	readClaudeAgentRunParams,
	resolveRedisForSession,
	tryGetRedisCredentials,
} from './lib/readNodeParameters';
import { getStoredSession, setStoredSession } from './lib/sessionStore';
import { ClaudeStreamAssembler } from './lib/streamAssembler';

/** Headless n8n 不可用：无交互通道，启用会导致空转循环 */
const HEADLESS_DISALLOWED_TOOLS = ['AskUserQuestion', 'TodoWrite'] as const;

function mergeDisallowedTools(presetTools?: string[]): string[] {
	const merged = new Set<string>(HEADLESS_DISALLOWED_TOOLS);
	if (presetTools) {
		for (const tool of presetTools) merged.add(tool);
	}
	return [...merged];
}

type PermissionPresetConfig = {
	allowedTools?: string[];
	disallowedTools?: string[];
	permissionMode?: string;
	allowDangerouslySkipPermissions?: boolean;
	tools?: { type: 'preset'; preset: 'claude_code' } | readonly string[];
	defaultStrictMcpConfig?: boolean;
};

/** 代码只读模式：注册 claude_code 工具集，再靠 allowed/disallowed 收窄到 Read/Grep/Glob */
const CODEBASE_READ_TOOLS = {
	tools: { type: 'preset', preset: 'claude_code' } as const,
	allowedTools: ['Read', 'Grep', 'Glob'],
	disallowedTools: [
		'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
	],
	permissionMode: 'bypassPermissions',
	allowDangerouslySkipPermissions: true,
};

const PERMISSION_PRESETS: Record<string, PermissionPresetConfig> = {
	customer_service: {
		...CODEBASE_READ_TOOLS,
	},
	read_only: {
		...CODEBASE_READ_TOOLS,
	},
	mcp_skills_only: {
		// 保留 claude_code 工具注册，便于流式输出 tool_start/tool_end；执行由 disallowedTools + dontAsk 拦截
		tools: { type: 'preset', preset: 'claude_code' },
		disallowedTools: [
			'Bash', 'Write', 'Edit', 'Read', 'Grep', 'Glob',
			'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
		],
		permissionMode: 'dontAsk',
		defaultStrictMcpConfig: true,
	},
	plan_only: {
		tools: { type: 'preset', preset: 'claude_code' },
		disallowedTools: [
			'Bash', 'Write', 'Edit', 'Read', 'Grep', 'Glob',
			'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
		],
		// dontAsk：工具调用仍出现在流式 UI，但一律拒绝执行（plan 模式则完全不产生 tool 事件）
		permissionMode: 'dontAsk',
	},
	full_agent: {
		tools: { type: 'preset', preset: 'claude_code' },
		permissionMode: 'bypassPermissions',
		allowDangerouslySkipPermissions: true,
	},
};

const LEGACY_PERMISSION_PRESET_ALIASES: Record<string, keyof typeof PERMISSION_PRESETS> = {
	world_assistant: 'full_agent',
};

function resolvePermissionPreset(raw: string): keyof typeof PERMISSION_PRESETS {
	const key = LEGACY_PERMISSION_PRESET_ALIASES[raw] ?? raw;
	if (key in PERMISSION_PRESETS) {
		return key as keyof typeof PERMISSION_PRESETS;
	}
	return 'customer_service';
}

function canResumeClaudeSession(
	current: ClaudeModelConfig,
	stored: StoredSessionRecord | undefined,
): boolean {
	if (!stored?.claudeSessionId) return false;
	if (!stored.modelConfig?.model) return true;
	const storedConfig = stored.modelConfig;
	return (
		storedConfig.model === current.model
		&& storedConfig.providerType === current.providerType
		&& storedConfig.profileIndex === current.profileIndex
	);
}

export class ClaudeAgent implements INodeType {
	methods = {
		credentialTest: {
			claudeProviderCredentialTest,
		},
	};

	description: INodeTypeDescription = {
		displayName: 'Claude Agent',
		name: 'claudeAgent',
		icon: 'file:claude.svg',
		group: ['transform'],
		version: 3,
		subtitle: '={{$parameter["modelConfigSource"]}}',
		description:
			'Run Claude Code via the Claude Agent SDK. User Message and model routing are required; add Options for session, workspace, MCP, or tool permissions.',
		defaults: {
			name: 'Claude Agent',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'claudeProvider',
				testedBy: 'claudeProviderCredentialTest',
				required: false,
				displayOptions: {
					show: {
						modelConfigSource: ['fromCredential'],
					},
				},
			},
			{
				name: 'redis',
				required: false,
			},
		],
		properties: [
			{
				displayName: 'Model Config Source',
				name: 'modelConfigSource',
				type: 'options',
				default: 'fromSelector',
				options: [
					{
						name: 'From Previous Node (Claude Model Selector)',
						value: 'fromSelector',
						description: 'Read claudeModelConfig from upstream item JSON',
					},
					{
						name: 'From Credential on This Node',
						value: 'fromCredential',
					},
					{
						name: 'From Input JSON Fields',
						value: 'fromInput',
						description: 'Use inferenceModel / inferenceModelProvider with optional Provider Map',
					},
				],
			},
			{
				displayName: 'Model Override',
				name: 'modelOverride',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						modelConfigSource: ['fromCredential', 'fromInput'],
					},
				},
			},
			{
				displayName: 'Provider Map JSON',
				name: 'providerMapJson',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				displayOptions: {
					show: {
						modelConfigSource: ['fromInput'],
					},
				},
				description:
					'Maps inferenceModelProvider values to profile credential field names, e.g. {"deepseek":"profile2Credential","anthropic":"profile1Credential"}',
			},
			{
				displayName: 'Config Field Name',
				name: 'configFieldName',
				type: 'string',
				default: CLAUDE_MODEL_CONFIG_FIELD,
				displayOptions: {
					show: {
						modelConfigSource: ['fromSelector'],
					},
				},
			},
			{
				displayName: 'User Message',
				name: 'chatInput',
				type: 'string',
				default: '',
				required: true,
				description: 'Current user message sent to Claude',
			},
			{
				displayName: 'System Message',
				name: 'systemMessage',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Optional system prompt prepended on the first turn (ignored when resuming a session)',
			},
			CLAUDE_AGENT_OPTIONS_PROPERTY,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		let queryFn: Awaited<ReturnType<typeof loadClaudeSdk>>['query'];
		try {
			({ query: queryFn } = await loadClaudeSdk());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new NodeOperationError(this.getNode(), message);
		}

		const redisCredentials = await tryGetRedisCredentials(this);

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const itemJson = items[itemIndex].json;
				const modelConfigSource = this.getNodeParameter('modelConfigSource', itemIndex, 'fromSelector') as
					| 'fromSelector'
					| 'fromCredential'
					| 'fromInput';
				const params = readClaudeAgentRunParams(this, itemIndex);

				if (!params.chatInput?.trim()) {
					throw new NodeOperationError(this.getNode(), 'User message (chatInput) is empty', { itemIndex });
				}

				const modelConfig = await resolveModelConfigForAgent(this, itemIndex, itemJson, {
					modelConfigSource,
					outputFieldName: String(this.getNodeParameter('configFieldName', itemIndex, CLAUDE_MODEL_CONFIG_FIELD)),
					modelOverride: String(this.getNodeParameter('modelOverride', itemIndex, '')).trim() || undefined,
					providerMapJson: String(this.getNodeParameter('providerMapJson', itemIndex, '')),
				});

				const redis = resolveRedisForSession(
					this.getNode(),
					params.sessionId,
					redisCredentials,
					itemIndex,
				);

				const storedSession = params.sessionId && redis
					? await getStoredSession(redis, params.sessionId)
					: undefined;
				const resumeSession = canResumeClaudeSession(modelConfig, storedSession);

				const resolvedWorkspace = params.hasWorkspaceConfig
					? resolveWorkingDir({
						skillsRoot: params.skillsRoot,
						workingDirectories: params.workingDirectories,
						legacyWorkingDirectory: params.workingDirectory,
					})
					: undefined;
				const cwd = resolvedWorkspace?.cwd ?? process.cwd();
				const additionalDirectories = resolvedWorkspace?.additionalDirectories ?? [];

				const mcpServersParsed = parseMcpServers(params.mcpServersJson, params.mcpServersForm);
				const mcpServers = toClaudeSdkMcpServers(mcpServersParsed);
				const mcpServerNames = listMcpServerNames(mcpServersParsed);
				const deniedMcpTools = resolveDeniedMcpToolNames(params.mcpToolAccess);
				const allowedMcpTools = resolveAllowedMcpToolNames(params.mcpToolAccess);
				const mcpDisallowedSdk = buildClaudeMcpDisallowedTools(mcpServerNames, deniedMcpTools);
				const mcpAllowedSdk = buildClaudeMcpAllowedTools(mcpServerNames, allowedMcpTools);
				const presetKey = resolvePermissionPreset(params.permissionPreset);
				const mcpPreApproved = resolveClaudeMcpPreApprovedTools(
					presetKey === 'mcp_skills_only',
					mcpServerNames,
					params.mcpToolAccess,
					mcpAllowedSdk,
				);
				const preset = PERMISSION_PRESETS[presetKey];
				const strictMcpConfig = params.strictMcpConfig || preset.defaultStrictMcpConfig === true;

				const systemMessage = params.systemMessage?.trim() ?? '';
				const userMessage = params.chatInput.trim();
				// 用户消息单独作为 prompt；systemMessage 仅写入 systemPrompt（首条与续聊均如此）
				const prompt = userMessage;

				const assembler = new ClaudeStreamAssembler({
					onBegin: async () => {
						if (this.isStreaming()) await this.sendChunk('begin', itemIndex);
					},
					onStructured: async (jsonContent: string) => {
						if (this.isStreaming()) await this.sendChunk('item', itemIndex, jsonContent);
					},
					onEnd: async () => {
						if (this.isStreaming()) await this.sendChunk('end', itemIndex);
					},
				});

				await assembler.begin();

				const queryOptions: Record<string, unknown> = {
					cwd,
					...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
					settingSources: params.hasWorkspaceConfig ? params.settingSources : ['project'],
					includePartialMessages: true,
					model: modelConfig.model,
					env: mergeSdkEnvWithProcess(modelConfig.sdkEnv),
					...(resumeSession && storedSession?.claudeSessionId
						? { resume: storedSession.claudeSessionId }
						: {}),
					...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
					...(strictMcpConfig ? { strictMcpConfig: true } : {}),
					...(params.skills ? { skills: params.skills } : {}),
					...(params.maxTurns > 0 ? { maxTurns: params.maxTurns } : {}),
					...(preset.allowedTools || mcpPreApproved.length > 0
						? {
							allowedTools: [
								...(preset.allowedTools ?? []),
								...mcpPreApproved,
							],
						}
						: {}),
					disallowedTools: mergeDisallowedTools([
						...(preset.disallowedTools ?? []),
						...mcpDisallowedSdk,
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

				if (params.useClaudeCodePreset) {
					queryOptions.systemPrompt = systemMessage
						? { type: 'preset', preset: 'claude_code', append: systemMessage }
						: { type: 'preset', preset: 'claude_code' };
				} else if (systemMessage) {
					queryOptions.systemPrompt = systemMessage;
				}

				let lastError: string | undefined;
				for await (const message of queryFn({
					prompt,
					options: queryOptions,
				})) {
					await assembler.consume(message);
					const record = message as Record<string, unknown>;
					if (record.type === 'result' && record.subtype === 'error') {
						lastError = String(record.result ?? 'Claude agent run failed');
					}
				}

				await assembler.end();

				if (lastError) {
					throw new NodeOperationError(this.getNode(), lastError, { itemIndex });
				}

				const claudeSessionId = assembler.getSessionId()
					?? (resumeSession ? storedSession?.claudeSessionId : undefined);
				if (params.sessionId && claudeSessionId && redis) {
					await setStoredSession(
						redis,
						params.sessionId,
						{
							claudeSessionId,
							modelConfig: modelConfigSummary(modelConfig),
						},
						params.sessionTtlSeconds,
					);
				}

				const usage = assembler.getUsage();
				returnData.push({
					json: {
						output: assembler.getOutput(),
						textOutput: assembler.getTextOutput(),
						model: modelConfig.model,
						provider: modelConfig.providerType,
						profileName: modelConfig.profileName,
						claudeSessionId,
						sessionId: params.sessionId || undefined,
						costUsd: usage?.costUsd,
						usage,
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (error instanceof NodeOperationError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				throw new NodeOperationError(this.getNode(), message, { itemIndex });
			}
		}

		return [returnData];
	}
}
