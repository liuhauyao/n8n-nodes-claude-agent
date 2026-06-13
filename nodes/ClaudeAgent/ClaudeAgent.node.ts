import {
	NodeConnectionTypes,
	NodeOperationError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import {
	modelConfigSummary,
	resolveModelConfigForAgent,
} from '../shared/lib/resolveModelConfig';
import type { ClaudeModelConfig, SessionRuntimeMode } from '../shared/lib/types';
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
import { runStatelessTurn, toStoredRecord } from './lib/runStatelessTurn';
import {
	consumeSidecarStreamWithMeta,
	isSidecarUnavailableError,
	postSidecarMessage,
	type SidecarMessageRequest,
} from './lib/sidecarClient';
import { resolvePermissionPreset } from './lib/permissionPresets';
import {
	hasUserTurnContent,
	normalizeImageUrls,
} from './lib/userMessageImages';

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
				const imageUrls = normalizeImageUrls(itemJson.imageUrls, params.chatInput);

				if (!hasUserTurnContent(params.chatInput, imageUrls)) {
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

				const onStructured = async (jsonContent: string) => {
					if (this.isStreaming()) await this.sendChunk('item', itemIndex, jsonContent);
				};

				const assembler = new ClaudeStreamAssembler({
					onBegin: async () => {
						if (this.isStreaming()) await this.sendChunk('begin', itemIndex);
					},
					onStructured,
					onEnd: async () => {
						if (this.isStreaming()) await this.sendChunk('end', itemIndex);
					},
				});

				await assembler.begin();

				const queryInputBase = {
					modelConfig,
					cwd,
					additionalDirectories,
					settingSources: params.settingSources,
					hasWorkspaceConfig: params.hasWorkspaceConfig,
					systemMessage: params.systemMessage,
					useClaudeCodePreset: params.useClaudeCodePreset,
					mcpServers,
					mcpServerNames,
					mcpDisallowedSdk,
					mcpAllowedSdk,
					mcpPreApproved,
					permissionPreset: params.permissionPreset,
					strictMcpConfig: params.strictMcpConfig,
					skills: params.skills,
					maxTurns: params.maxTurns,
				};

				let sessionRuntime: SessionRuntimeMode | 'stateless-fallback' = params.sessionRuntime;
				let sessionContinuation = 'new';
				let previousClaudeSessionId: string | undefined;
				let claudeSessionId: string | undefined;
				let output = '';
				let textOutput = '';
				let usage = assembler.getUsage();

				const trySidecar = params.sessionRuntime === 'sidecar' && Boolean(params.sessionId);
				if (trySidecar) {
					try {
						const sidecarBody: SidecarMessageRequest = {
							chatInput: params.chatInput.trim(),
							imageUrls,
							systemMessage: params.systemMessage,
							modelConfig,
							params,
							useClaudeCodePreset: params.useClaudeCodePreset,
							cwd,
							additionalDirectories,
							mcpServers,
							mcpServerNames,
							mcpDisallowedSdk,
							mcpAllowedSdk,
							mcpPreApproved,
						};
						const abortSignal = this.getExecutionCancelSignal?.();
						const stream = await postSidecarMessage(
							params.sidecarUrl,
							params.sessionId,
							sidecarBody,
							abortSignal ?? undefined,
						);
						const doneMeta = await consumeSidecarStreamWithMeta(stream, onStructured);
						sessionRuntime = 'sidecar';
						if (doneMeta) {
							output = doneMeta.output;
							textOutput = doneMeta.textOutput;
							claudeSessionId = doneMeta.claudeSessionId;
							usage = doneMeta.usage;
							sessionContinuation = doneMeta.sessionContinuation;
							previousClaudeSessionId = doneMeta.previousClaudeSessionId;
						}
					} catch (error) {
						if (!isSidecarUnavailableError(error)) {
							throw error;
						}
						sessionRuntime = 'stateless-fallback';
					}
				}

				if (sessionRuntime !== 'sidecar') {
					const turn = await runStatelessTurn({
						...queryInputBase,
						queryFn,
						chatInput: params.chatInput.trim(),
						imageUrls,
						storedSession,
						assembler,
					});
					sessionContinuation = turn.continuationKind;
					previousClaudeSessionId = turn.previousClaudeSessionId;
					claudeSessionId = turn.claudeSessionId;
					if (turn.lastError) {
						throw new NodeOperationError(this.getNode(), turn.lastError, { itemIndex });
					}
					output = assembler.getOutput();
					textOutput = assembler.getTextOutput();
					usage = assembler.getUsage();
				}

				await assembler.end();

				if (params.sessionId && claudeSessionId && redis) {
					await setStoredSession(
						redis,
						params.sessionId,
						toStoredRecord(modelConfig, claudeSessionId),
						params.sessionTtlSeconds,
					);
				}

				returnData.push({
					json: {
						output: output || assembler.getOutput(),
						textOutput: textOutput || assembler.getTextOutput(),
						model: modelConfig.model,
						provider: modelConfig.providerType,
						profileName: modelConfig.profileName,
						claudeSessionId,
						sessionId: params.sessionId || undefined,
						sessionContinuation,
						sessionRuntime,
						previousClaudeSessionId,
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
