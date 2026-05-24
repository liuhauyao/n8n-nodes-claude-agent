import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodePropertyOptions,
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
import { loadClaudeSdk } from './lib/loadClaudeSdk';
import { parseMcpServers, toClaudeSdkMcpServers, type McpServersFormValue } from './lib/parseMcpServers';
import { resolveWorkingDir } from './lib/resolveWorkingDir';
import { getStoredSession, setStoredSession, type RedisCredentials } from './lib/sessionStore';
import { ClaudeStreamAssembler } from './lib/streamAssembler';

type SettingSource = 'user' | 'project' | 'local' | 'team' | 'plugins';

const SETTING_SOURCE_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Project', value: 'project', description: 'Load .claude from the working directory' },
	{ name: 'User', value: 'user' },
	{ name: 'Local', value: 'local' },
	{ name: 'Team', value: 'team' },
	{ name: 'Plugins', value: 'plugins' },
];

const PERMISSION_PRESETS: Record<
	string,
	{
		allowedTools?: string[];
		disallowedTools?: string[];
		permissionMode?: string;
		allowDangerouslySkipPermissions?: boolean;
		tools?: { type: 'preset'; preset: 'claude_code' };
	}
> = {
	customer_service: {
		allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
		disallowedTools: ['Bash', 'Write', 'Edit'],
		permissionMode: 'bypassPermissions',
		allowDangerouslySkipPermissions: true,
	},
	read_only: {
		allowedTools: ['Read', 'Grep', 'Glob'],
		disallowedTools: ['Bash', 'Write', 'Edit'],
		permissionMode: 'bypassPermissions',
		allowDangerouslySkipPermissions: true,
	},
	full_agent: {
		tools: { type: 'preset', preset: 'claude_code' },
		permissionMode: 'bypassPermissions',
		allowDangerouslySkipPermissions: true,
	},
};

/** Legacy alias — removed from UI in 1.0.29; behaves as full_agent. */
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

function readRedisCredentials(raw: IDataObject): RedisCredentials {
	return {
		host: String(raw.host ?? 'localhost'),
		port: Number(raw.port ?? 6379),
		user: raw.user ? String(raw.user) : undefined,
		password: raw.password ? String(raw.password) : undefined,
		database: raw.database !== undefined ? Number(raw.database) : 0,
	};
}

function readSettingSources(raw: string | string[] | undefined): SettingSource[] {
	if (!raw) return ['project'];
	const values = Array.isArray(raw) ? raw : [raw];
	return values.filter(Boolean) as SettingSource[];
}

function readSkills(raw: string | undefined): string[] | 'all' | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	if (trimmed.toLowerCase() === 'all') return 'all';
	return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Resume Claude SDK session only when provider/profile/model unchanged (same chat sessionId). */
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
		version: 1,
		subtitle: '={{$parameter["modelConfigSource"]}}',
		description:
			'Run Claude Code via the Claude Agent SDK with MCP, skills, streaming, and Provider-based model routing',
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
				required: true,
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
				displayName: 'System Message',
				name: 'systemMessage',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Prepended on the first turn (ignored when resuming an existing session)',
			},
			{
				displayName: 'User Message',
				name: 'chatInput',
				type: 'string',
				default: '',
				description: 'Current user message sent to Claude',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description: 'Business conversation key stored in Redis (maps to Claude SDK session_id)',
			},
			{
				displayName: 'Permission Preset',
				name: 'permissionPreset',
				type: 'options',
				default: 'customer_service',
				options: [
					{ name: 'Restricted — Read/Web + MCP', value: 'customer_service' },
					{ name: 'Strict Read Only', value: 'read_only' },
					{ name: 'Full Claude Code Tools', value: 'full_agent' },
				],
			},
			{
				displayName: 'Skills Root Directory',
				name: 'skillsRoot',
				type: 'string',
				default: '',
				description: 'Directory containing .claude/skills (placed first in cwd resolution)',
			},
			{
				displayName: 'Working Directories',
				name: 'workingDirectories',
				type: 'string',
				typeOptions: { multipleValues: true },
				default: [],
				description: 'Absolute workspace paths combined with Skills Root',
			},
			{
				displayName: 'Working Directory (legacy)',
				name: 'workingDirectory',
				type: 'string',
				default: '',
				description: 'Deprecated: use Working Directories instead',
			},
			{
				displayName: 'Setting Sources',
				name: 'settingSources',
				type: 'multiOptions',
				options: SETTING_SOURCE_OPTIONS,
				default: ['project'],
			},
			{
				displayName: 'Skills',
				name: 'skills',
				type: 'string',
				default: '',
				description: 'Comma-separated skill names, or "all" to enable every discovered skill',
			},
			{
				displayName: 'Max Turns',
				name: 'maxTurns',
				type: 'number',
				default: 0,
				description: 'Maximum agentic turns (0 = SDK default)',
			},
			{
				displayName: 'Additional Options',
				name: 'additionalOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'MCP Servers',
						name: 'mcpServers',
						type: 'fixedCollection',
						typeOptions: { multipleValues: true },
						default: {},
						options: [
							{
								displayName: 'Server',
								name: 'server',
								values: [
									{ displayName: 'Name', name: 'name', type: 'string', default: '' },
									{
										displayName: 'Transport',
										name: 'transport',
										type: 'options',
										options: [
											{ name: 'HTTP', value: 'http' },
											{ name: 'SSE', value: 'sse' },
											{ name: 'Stdio', value: 'stdio' },
										],
										default: 'http',
									},
									{
										displayName: 'URL',
										name: 'url',
										type: 'string',
										default: '',
										displayOptions: { show: { transport: ['http', 'sse'] } },
									},
									{
										displayName: 'Headers JSON',
										name: 'headersJson',
										type: 'string',
										default: '',
										displayOptions: { show: { transport: ['http', 'sse'] } },
									},
									{
										displayName: 'Command',
										name: 'command',
										type: 'string',
										default: '',
										displayOptions: { show: { transport: ['stdio'] } },
									},
									{
										displayName: 'Arguments',
										name: 'args',
										type: 'string',
										typeOptions: { multipleValues: true },
										default: [],
										displayOptions: { show: { transport: ['stdio'] } },
									},
									{
										displayName: 'Environment JSON',
										name: 'envJson',
										type: 'string',
										default: '',
										displayOptions: { show: { transport: ['stdio'] } },
									},
									{
										displayName: 'Working Directory',
										name: 'cwd',
										type: 'string',
										default: '',
										displayOptions: { show: { transport: ['stdio'] } },
									},
								],
							},
						],
					},
					{
						displayName: 'MCP Servers JSON',
						name: 'mcpServersJson',
						type: 'string',
						typeOptions: { rows: 6 },
						default: '',
						description: 'When set, overrides the MCP Servers form',
					},
					{
						displayName: 'Strict MCP Config',
						name: 'strictMcpConfig',
						type: 'boolean',
						default: false,
						description: 'Ignore project .mcp.json and use only servers configured here',
					},
					{
						displayName: 'Session TTL (Seconds)',
						name: 'sessionTtlSeconds',
						type: 'number',
						default: 604800,
					},
					{
						displayName: 'Use Claude Code System Prompt Preset',
						name: 'useClaudeCodePreset',
						type: 'boolean',
						default: true,
					},
				],
			},
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

		const redisCredentials = readRedisCredentials(await this.getCredentials('redis'));

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const itemJson = items[itemIndex].json;
				const modelConfigSource = this.getNodeParameter('modelConfigSource', itemIndex, 'fromSelector') as
					| 'fromSelector'
					| 'fromCredential'
					| 'fromInput';
				const systemMessage = this.getNodeParameter('systemMessage', itemIndex, '') as string;
				const chatInput = this.getNodeParameter('chatInput', itemIndex, '') as string;
				const sessionId = this.getNodeParameter('sessionId', itemIndex, '') as string;
				const permissionPreset = this.getNodeParameter('permissionPreset', itemIndex, 'customer_service') as string;
				const skillsRoot = this.getNodeParameter('skillsRoot', itemIndex, '') as string;
				const workingDirectories = this.getNodeParameter('workingDirectories', itemIndex, []) as string[];
				const workingDirectory = this.getNodeParameter('workingDirectory', itemIndex, '') as string;
				const settingSources = readSettingSources(
					this.getNodeParameter('settingSources', itemIndex, ['project']) as string | string[],
				);
				const skills = readSkills(this.getNodeParameter('skills', itemIndex, '') as string);
				const maxTurnsRaw = Number(this.getNodeParameter('maxTurns', itemIndex, 0));
				const additionalOptions = this.getNodeParameter('additionalOptions', itemIndex, {}) as IDataObject;
				const mcpServersForm = (additionalOptions.mcpServers ?? {}) as McpServersFormValue;
				const mcpServersJson = String(additionalOptions.mcpServersJson ?? '');
				const strictMcpConfig = Boolean(additionalOptions.strictMcpConfig);
				const sessionTtlSeconds = Number(additionalOptions.sessionTtlSeconds ?? 604800);
				const useClaudeCodePreset = additionalOptions.useClaudeCodePreset !== false;

				if (!chatInput?.trim()) {
					throw new NodeOperationError(this.getNode(), 'User message (chatInput) is empty', { itemIndex });
				}

				let modelConfig = await resolveModelConfigForAgent(this, itemIndex, itemJson, {
					modelConfigSource,
					outputFieldName: String(this.getNodeParameter('configFieldName', itemIndex, CLAUDE_MODEL_CONFIG_FIELD)),
					modelOverride: String(this.getNodeParameter('modelOverride', itemIndex, '')).trim() || undefined,
					providerMapJson: String(this.getNodeParameter('providerMapJson', itemIndex, '')),
				});

				const storedSession = sessionId ? await getStoredSession(redisCredentials, sessionId) : undefined;
				const resumeSession = canResumeClaudeSession(modelConfig, storedSession);

				const { cwd, additionalDirectories } = resolveWorkingDir({
					skillsRoot,
					workingDirectories,
					legacyWorkingDirectory: workingDirectory,
				});

				const mcpServersParsed = parseMcpServers(mcpServersJson, mcpServersForm);
				const mcpServers = toClaudeSdkMcpServers(mcpServersParsed);
				const preset = PERMISSION_PRESETS[resolvePermissionPreset(permissionPreset)];

				const prompt = resumeSession
					? chatInput.trim()
					: [systemMessage?.trim(), chatInput.trim()].filter(Boolean).join('\n\n---\n\n');

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
					settingSources,
					includePartialMessages: true,
					model: modelConfig.model,
					env: mergeSdkEnvWithProcess(modelConfig.sdkEnv),
					...(resumeSession && storedSession?.claudeSessionId
						? { resume: storedSession.claudeSessionId }
						: {}),
					...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
					...(strictMcpConfig ? { strictMcpConfig: true } : {}),
					...(skills ? { skills } : {}),
					...(maxTurnsRaw > 0 ? { maxTurns: maxTurnsRaw } : {}),
					...(preset.allowedTools ? { allowedTools: preset.allowedTools } : {}),
					...(preset.disallowedTools ? { disallowedTools: preset.disallowedTools } : {}),
					...(preset.permissionMode ? { permissionMode: preset.permissionMode } : {}),
					...(preset.allowDangerouslySkipPermissions
						? { allowDangerouslySkipPermissions: true }
						: {}),
					...(preset.tools ? { tools: preset.tools } : {}),
				};

				if (useClaudeCodePreset) {
					const append = systemMessage?.trim();
					queryOptions.systemPrompt = append
						? { type: 'preset', preset: 'claude_code', append }
						: { type: 'preset', preset: 'claude_code' };
				} else if (systemMessage?.trim() && !resumeSession) {
					queryOptions.systemPrompt = systemMessage.trim();
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
				if (sessionId && claudeSessionId) {
					await setStoredSession(
						redisCredentials,
						sessionId,
						{
							claudeSessionId,
							modelConfig: modelConfigSummary(modelConfig),
						},
						sessionTtlSeconds,
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
						sessionId,
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
