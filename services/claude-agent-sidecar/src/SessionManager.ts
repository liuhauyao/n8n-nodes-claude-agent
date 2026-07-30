import type { Query } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeModelConfig, StoredSessionRecord } from '../../../dist/nodes/shared/lib/types';
import { modelConfigSummary } from '../../../dist/nodes/shared/lib/resolveModelConfig';
import { buildQueryOptions, getHookRuntimeState } from '../../../dist/nodes/ClaudeAgent/lib/buildQueryOptions';
import {
	recordAssistantMessageForHooks,
	resetHookRuntimeStateForNextTurn,
	type HookRuntimeState,
} from '../../../dist/nodes/ClaudeAgent/lib/buildDeclarativeHooks';
import { pickExtendedQueryFields } from '../../../dist/nodes/ClaudeAgent/lib/extendedQueryFields';
import { sanitizeQueryOptionsForSdk } from '../../../dist/nodes/ClaudeAgent/lib/queryOptionsSanitize';
import { loadClaudeSdk } from '../../../dist/nodes/ClaudeAgent/lib/loadClaudeSdk';
import { runStatelessTurn, toStoredRecord } from '../../../dist/nodes/ClaudeAgent/lib/runStatelessTurn';
import {
	isSameProfile,
	resolveSessionContinuation,
	sameModelConfig,
	type SessionContinuation,
} from '../../../dist/nodes/ClaudeAgent/lib/sessionContinuation';
import {
	deleteLiveSessionMeta,
	getStoredSession,
	setLiveSessionMeta,
	setStoredSession,
	type RedisCredentials,
} from '../../../dist/nodes/ClaudeAgent/lib/sessionStore';
import type { SidecarMessageRequest } from '../../../dist/nodes/ClaudeAgent/lib/sidecarClient';
import { liveSessionTtlSeconds, type SidecarConfig } from './config';
import {
	normalizeImageUrls,
	stripImageMarkdown,
} from '../../../dist/nodes/ClaudeAgent/lib/userMessageImages';
import { createUserMessage, createUserMessageWithImages, MessageQueue } from './MessageQueue';
import { SidecarStreamSink } from './SidecarStreamSink';

type TurnWaiter = {
	resolve: () => void;
	reject: (error: Error) => void;
};

/** 判断错误消息是否为 ContextWindowExceeded */
function isContextWindowExceeded(msg: string): boolean {
	return /context.?window.?exceed|prompt is too long|max.?context.?length|ContextWindowExceeded/i.test(msg);
}

class LiveSession {
	readonly businessSessionId: string;
	readonly inputQueue: MessageQueue;
	query?: Query;
	modelConfig: ClaudeModelConfig;
	claudeSessionId?: string;
	lastActiveAt = Date.now();
	currentSink?: SidecarStreamSink;
	consumerStarted = false;
	hookRuntimeState?: HookRuntimeState;
	/** 当前轮次已生成的文本缓冲，用于断线重连时向客户端提供进度快照 */
	currentTurnBuffer = '';
	/** 当前会话的 MCP 工具拒绝列表（每轮消息更新，通过 applyFlagSettings 生效） */
	currentMcpDisallowedSdk: string[] = [];
	/** 累计会话 input+output tokens，用于主动 compact 阈值判断 */
	cumulativeTokens = 0;
	/** 上下文窗口大小（tokens），0 表示未知，由 SidecarMessageRequest 传入 */
	contextWindowSize = 0;
	/** 本轮是否已推送 /compact 等待结果 */
	compactRetried = false;
	/** 本 session 是否已尝试过 /compact（防止无限循环） */
	compactAttempted = false;
	/** compact 完成后待重发的原始 chatInput */
	pendingChatInput = '';
	private turnWaiter?: TurnWaiter;
	private closed = false;

	constructor(businessSessionId: string, modelConfig: ClaudeModelConfig) {
		this.businessSessionId = businessSessionId;
		this.modelConfig = modelConfig;
		this.inputQueue = new MessageQueue();
	}

	touch(): void {
		this.lastActiveAt = Date.now();
	}

	async attachSink(sink: SidecarStreamSink): Promise<void> {
		this.currentSink = sink;
		await sink.begin();
	}

	waitForTurn(timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Sidecar message timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.turnWaiter = {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
		});
	}

	completeTurn(errorMessage?: string): void {
		const waiter = this.turnWaiter;
		this.turnWaiter = undefined;
		if (!waiter) return;
		if (errorMessage) {
			waiter.reject(new Error(errorMessage));
		} else {
			waiter.resolve();
		}
	}

	isBusy(): boolean {
		return this.turnWaiter !== undefined;
	}

	pushUserMessage(content: string, imageUrls: string[] = []): void {
		const urls = normalizeImageUrls(imageUrls, content);
		const text = stripImageMarkdown(content);
		if (urls.length) {
			this.inputQueue.push(createUserMessageWithImages(text, urls));
			return;
		}
		this.inputQueue.push(createUserMessage(content));
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.inputQueue.close();
		try {
			this.query?.close();
		} catch {
			// ignore
		}
	}

}

export class SessionManager {
	private readonly sessions = new Map<string, LiveSession>();
	private readonly config: SidecarConfig;
	private readonly redis: RedisCredentials;

	constructor(config: SidecarConfig) {
		this.config = config;
		this.redis = config.redis;
	}

	startIdleEviction(): void {
		setInterval(() => {
			void this.evictIdle(this.config.idleTimeoutMs);
		}, 60_000);
	}

	stop(): void {
		for (const session of this.sessions.values()) {
			session.close();
		}
		this.sessions.clear();
	}

	getActiveSessionCount(): number {
		return this.sessions.size;
	}

	/** 获取当前轮次已生成的文本缓冲，用于断线重连场景 */
	getSessionBuffer(businessSessionId: string): { content: string; active: boolean } | null {
		const live = this.sessions.get(businessSessionId);
		if (!live) return null;
		return { content: live.currentTurnBuffer, active: live.isBusy() };
	}

	async abortSession(businessSessionId: string): Promise<boolean> {
		const live = this.sessions.get(businessSessionId);
		if (!live?.query) return false;
		try {
			await live.query.interrupt();
			live.completeTurn('aborted');
		} catch {
			live.close();
		}
		return true;
	}

	async handleMessage(
		businessSessionId: string,
		req: SidecarMessageRequest,
		sink: SidecarStreamSink,
		sessionTtlSeconds: number,
	): Promise<void> {
		this.enforceMaxSessions();
		const stored = await getStoredSession(this.redis, businessSessionId);
		let live = this.sessions.get(businessSessionId);

		if (live && !isSameProfile(live.modelConfig, req.modelConfig)) {
			await this.evictLiveSession(businessSessionId);
			live = undefined;
		}

		const continuation = resolveSessionContinuation(req.modelConfig, stored);
		const needsForkBridge = !live && continuation.kind === 'fork';

		if (needsForkBridge) {
			const forkSessionId = await this.runForkBridge(
				businessSessionId,
				req,
				stored,
				sink,
				sessionTtlSeconds,
				continuation.sourceClaudeSessionId,
			);
			if (forkSessionId) {
				const resumeContinuation: SessionContinuation = {
					kind: 'resume',
					claudeSessionId: forkSessionId,
				};
				const idleLive = await this.createLiveSession(
					businessSessionId,
					req,
					resumeContinuation,
				);
				idleLive.claudeSessionId = forkSessionId;
				this.sessions.set(businessSessionId, idleLive);
				await this.persistLiveMeta(businessSessionId, req.modelConfig, forkSessionId);
			}
			return;
		}

		if (!live) {
			live = await this.createLiveSession(businessSessionId, req, continuation);
			this.sessions.set(businessSessionId, live);
		}

		await live.attachSink(sink);
		live.touch();

		if (
			live.query
			&& isSameProfile(live.modelConfig, req.modelConfig)
			&& live.modelConfig.model !== req.modelConfig.model
		) {
			await live.query.setModel(req.modelConfig.model);
			live.modelConfig = req.modelConfig;
		}

		live.currentTurnBuffer = '';

		// 每轮消息前动态更新 MCP 工具拒绝列表，确保模式切换立即生效（不依赖 session 创建时锁定的 disallowedTools）
		live.currentMcpDisallowedSdk = req.mcpDisallowedSdk ?? [];
		if (live.query) {
			await live.query.applyFlagSettings({
				permissions: {
					deny: live.currentMcpDisallowedSdk,
				},
			});
		}

		// 同步上下文窗口大小（每次消息更新，支持运行时调整）
		if (req.contextWindowSize && req.contextWindowSize > 0) {
			live.contextWindowSize = req.contextWindowSize;
		}

		// 方向 B：累计 tokens 超阈值时提前 /compact，避免到达硬限制
		const cwThreshold = live.contextWindowSize > 0
			? live.contextWindowSize * 0.85
			: 200_000;
		if (live.cumulativeTokens > cwThreshold && !live.compactAttempted) {
			live.compactAttempted = true;
			live.compactRetried = true;
			live.pendingChatInput = req.chatInput;
			live.pushUserMessage('/compact');
		} else {
			live.pushUserMessage(req.chatInput, req.imageUrls ?? []);
		}
		await live.waitForTurn(this.config.messageTimeoutMs);

		const claudeSessionId = live.claudeSessionId ?? stored?.claudeSessionId;
		if (claudeSessionId) {
			await setStoredSession(
				this.redis,
				businessSessionId,
				toStoredRecord(req.modelConfig, claudeSessionId),
				sessionTtlSeconds,
			);
		}

		await this.persistLiveMeta(businessSessionId, req.modelConfig, claudeSessionId);

		const outputContinuation = !live.claudeSessionId && continuation.kind === 'new'
			? 'new'
			: sameModelConfig(req.modelConfig, stored?.modelConfig ?? req.modelConfig)
				? 'resume'
				: 'setModel';

		await sink.finish({
			claudeSessionId,
			sessionContinuation: outputContinuation,
			sessionRuntime: 'sidecar',
			model: req.modelConfig.model,
			provider: req.modelConfig.providerType,
		});
	}

	private async persistLiveMeta(
		businessSessionId: string,
		modelConfig: ClaudeModelConfig,
		claudeSessionId?: string,
	): Promise<void> {
		await setLiveSessionMeta(
			this.redis,
			businessSessionId,
			{
				sidecarPid: process.pid,
				claudeSessionId: claudeSessionId ?? '',
				modelConfig: modelConfigSummary(modelConfig),
				lastActiveAt: Date.now(),
				streaming: true,
			},
			liveSessionTtlSeconds(this.config.idleTimeoutMs),
		);
	}

	private async runForkBridge(
		businessSessionId: string,
		req: SidecarMessageRequest,
		stored: StoredSessionRecord | undefined,
		sink: SidecarStreamSink,
		sessionTtlSeconds: number,
		previousClaudeSessionId: string,
	): Promise<string | undefined> {
		await sink.begin();
		const { query: queryFn } = await loadClaudeSdk();
		const turn = await runStatelessTurn({
			queryFn,
			chatInput: req.chatInput,
			imageUrls: req.imageUrls,
			storedSession: stored,
			assembler: sink.getAssembler(),
			modelConfig: req.modelConfig,
			cwd: req.cwd,
			additionalDirectories: req.additionalDirectories,
			settingSources: req.params.settingSources,
			hasWorkspaceConfig: req.params.hasWorkspaceConfig,
			systemMessage: req.systemMessage,
			useClaudeCodePreset: req.useClaudeCodePreset,
			mcpServers: req.mcpServers,
			mcpServerNames: req.mcpServerNames,
			mcpDisallowedSdk: req.mcpDisallowedSdk,
			mcpAllowedSdk: req.mcpAllowedSdk,
			mcpPreApproved: req.mcpPreApproved,
			permissionPreset: req.params.permissionPreset,
			strictMcpConfig: req.params.strictMcpConfig,
			skills: req.params.skills,
			maxTurns: req.params.maxTurns,
			...pickExtendedQueryFields(req.params),
		});

		if (turn.lastError) {
			await sink.fail(turn.lastError);
			return undefined;
		}

		const claudeSessionId = turn.claudeSessionId;
		if (claudeSessionId) {
			await setStoredSession(
				this.redis,
				businessSessionId,
				toStoredRecord(req.modelConfig, claudeSessionId),
				sessionTtlSeconds,
			);
		}

		await sink.finish({
			claudeSessionId,
			sessionContinuation: 'fork',
			sessionRuntime: 'sidecar',
			previousClaudeSessionId,
			model: req.modelConfig.model,
			provider: req.modelConfig.providerType,
		});
		return claudeSessionId;
	}

	private async createLiveSession(
		businessSessionId: string,
		req: SidecarMessageRequest,
		continuation: SessionContinuation,
	): Promise<LiveSession> {
		const live = new LiveSession(businessSessionId, req.modelConfig);
		const { query: queryFn } = await loadClaudeSdk();
		// 注意：mcpDisallowedSdk 传空数组，不在 session 创建时锁定工具拒绝列表；
		// 每轮消息前由 handleMessage 通过 applyFlagSettings 动态设置，支持模式切换不丢上下文。
		const queryOptions = buildQueryOptions({
			continuation,
			modelConfig: req.modelConfig,
			cwd: req.cwd,
			additionalDirectories: req.additionalDirectories,
			settingSources: req.params.settingSources,
			hasWorkspaceConfig: req.params.hasWorkspaceConfig,
			systemMessage: req.systemMessage,
			useClaudeCodePreset: req.useClaudeCodePreset,
			mcpServers: req.mcpServers,
			mcpServerNames: req.mcpServerNames,
			mcpDisallowedSdk: [],
			mcpAllowedSdk: req.mcpAllowedSdk,
			mcpPreApproved: req.mcpPreApproved,
			permissionPreset: req.params.permissionPreset,
			strictMcpConfig: req.params.strictMcpConfig,
			skills: req.params.skills,
			maxTurns: req.params.maxTurns,
			...pickExtendedQueryFields(req.params),
		});

		live.hookRuntimeState = getHookRuntimeState(queryOptions);
		live.query = queryFn({
			prompt: live.inputQueue,
			options: sanitizeQueryOptionsForSdk(queryOptions),
		}) as Query;

		void this.runLiveConsumer(live);
		return live;
	}

	private async runLiveConsumer(live: LiveSession): Promise<void> {
		if (live.consumerStarted) return;
		live.consumerStarted = true;
		const query = live.query;
		if (!query) return;

		try {
			for await (const message of query) {
				// 先登记助手正文，供 Stop Hook 按「本轮」判定 proposal 标记是否已按增量交付输出
				if (live.hookRuntimeState) {
					recordAssistantMessageForHooks(live.hookRuntimeState, message);
				}
				const sink = live.currentSink;
				if (sink) await sink.consumeSdkMessage(message);
			// 累积文本到轮次缓冲，供断线重连时获取进度快照
			// Claude SDK 消息结构：{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }
			const record = message as Record<string, unknown>;
			if (record.type === 'stream_event') {
				const event = record.event as Record<string, unknown> | undefined;
				if (event?.type === 'content_block_delta') {
					const delta = event.delta as Record<string, unknown> | undefined;
					if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
						live.currentTurnBuffer += delta.text;
					}
				}
			}
			if (typeof record.session_id === 'string' && record.session_id) {
					live.claudeSessionId = record.session_id;
				}
			if (record.type === 'result') {
				// 累积会话 tokens（供方向 B 阈值判断）
				const usageRecord = record.usage as { input_tokens?: number; output_tokens?: number } | undefined;
				if (usageRecord) {
					live.cumulativeTokens += (usageRecord.input_tokens ?? 0) + (usageRecord.output_tokens ?? 0);
				}
				// 每轮结束后重置 hook 运行态，避免跨轮次累加（含 Stop Hook 的工具成功/Task 状态追踪）
				if (live.hookRuntimeState) {
					resetHookRuntimeStateForNextTurn(live.hookRuntimeState);
				}
				if (record.subtype === 'error') {
					const errMsg = String(record.result ?? 'Claude agent run failed');
					if (isContextWindowExceeded(errMsg)) {
						if (!live.compactAttempted) {
							// 首次上下文溢出：推送 /compact，不通知等待方，继续消费
							live.compactAttempted = true;
							live.compactRetried = true;
							live.currentTurnBuffer = '';
							live.pushUserMessage('/compact');
							continue;
						}
						// /compact 后仍溢出：返回友好文案作为正常 output，不扣费
						const friendlyMsg = '很抱歉，当前会话的对话上下文已全部用完。您的灵感与世界设定都已保存在持久记忆中，请新建对话继续创作。';
						await sink?.emit({ kind: 'status', phase: 'context_exhausted' });
						await sink?.emit({ kind: 'text', text: friendlyMsg });
						await sink?.finish({
							claudeSessionId: live.claudeSessionId,
							sessionContinuation: 'context_exhausted',
							sessionRuntime: 'sidecar',
							outputOverride: friendlyMsg,
						});
						live.pendingChatInput = '';
						live.compactRetried = false;
						live.completeTurn();
						return;
					}
					live.completeTurn(errMsg);
					await sink?.fail(errMsg);
				} else {
					// success
					if (live.compactRetried && live.pendingChatInput) {
						// /compact 成功：重发原始消息，不结束等待
						const pendingInput = live.pendingChatInput;
						live.pendingChatInput = '';
						live.compactRetried = false;
						live.currentTurnBuffer = '';
						live.pushUserMessage(pendingInput);
						continue;
					}
					live.completeTurn();
				}
			}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			live.completeTurn(message);
			await live.currentSink?.fail(message);
		}
	}

	private enforceMaxSessions(): void {
		if (this.sessions.size < this.config.maxSessions) return;
		let oldestId: string | undefined;
		let oldestTs = Infinity;
		for (const [id, session] of this.sessions) {
			if (session.lastActiveAt < oldestTs) {
				oldestTs = session.lastActiveAt;
				oldestId = id;
			}
		}
		if (oldestId) void this.evictLiveSession(oldestId);
	}

	async evictIdle(maxIdleMs: number): Promise<void> {
		const now = Date.now();
		for (const [id, session] of this.sessions) {
			if (now - session.lastActiveAt >= maxIdleMs) {
				await this.evictLiveSession(id);
			}
		}
	}

	private async evictLiveSession(businessSessionId: string): Promise<void> {
		const live = this.sessions.get(businessSessionId);
		if (!live) return;
		live.close();
		this.sessions.delete(businessSessionId);
		await deleteLiveSessionMeta(this.redis, businessSessionId);
	}
}
