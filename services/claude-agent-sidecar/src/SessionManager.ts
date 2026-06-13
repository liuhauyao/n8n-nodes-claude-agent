import type { Query } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeModelConfig, StoredSessionRecord } from '../../../dist/nodes/shared/lib/types';
import { modelConfigSummary } from '../../../dist/nodes/shared/lib/resolveModelConfig';
import { buildQueryOptions } from '../../../dist/nodes/ClaudeAgent/lib/buildQueryOptions';
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

class LiveSession {
	readonly businessSessionId: string;
	readonly inputQueue: MessageQueue;
	query?: Query;
	modelConfig: ClaudeModelConfig;
	claudeSessionId?: string;
	lastActiveAt = Date.now();
	currentSink?: SidecarStreamSink;
	consumerStarted = false;
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

		live.pushUserMessage(req.chatInput, req.imageUrls ?? []);
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
			mcpDisallowedSdk: req.mcpDisallowedSdk,
			mcpAllowedSdk: req.mcpAllowedSdk,
			mcpPreApproved: req.mcpPreApproved,
			permissionPreset: req.params.permissionPreset,
			strictMcpConfig: req.params.strictMcpConfig,
			skills: req.params.skills,
			maxTurns: req.params.maxTurns,
		});

		live.query = queryFn({
			prompt: live.inputQueue,
			options: queryOptions,
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
				const sink = live.currentSink;
				if (sink) await sink.consumeSdkMessage(message);
				const record = message as Record<string, unknown>;
				if (typeof record.session_id === 'string' && record.session_id) {
					live.claudeSessionId = record.session_id;
				}
				if (record.type === 'result') {
					if (record.subtype === 'error') {
						const err = String(record.result ?? 'Claude agent run failed');
						live.completeTurn(err);
						await sink?.fail(err);
					} else {
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
