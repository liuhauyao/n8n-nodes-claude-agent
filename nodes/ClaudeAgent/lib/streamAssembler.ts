import {
	encodeClaudeStreamPayload,
	embedClaudeMessageMeta,
	extractNextSuggestions,
	resolveToolLabel,
	shouldShowToolInUi,
	stripClaudeMessageMeta,
	stripNextTags,
	type ClaudeMessageMeta,
	type ClaudeStreamPayload,
} from './claudeStreamProtocol';

export interface StreamSink {
	onBegin: () => void | Promise<void>;
	onStructured: (jsonContent: string) => void | Promise<void>;
	onEnd: () => void | Promise<void>;
}

export class ClaudeStreamAssembler {
	private markdown = '';
	private readonly markdownSegments: string[] = [];
	private thinking = '';
	private thinkingStarted = false;
	private thinkingDurationMs?: number;
	private completedAssistantMessages = 0;
	private readonly startedTools = new Set<string>();
	private readonly toolCalls: ClaudeMessageMeta['toolCalls'] = [];
	private sessionId?: string;
	private usage?: ClaudeMessageMeta['usage'];
	private fallbackMarkdown = '';
	private structuredOutput?: unknown;
	private sdkSuggestions: string[] = [];
	private refusalMessage?: string;
	private readonly stepUsageByMessageId = new Map<string, { input: number; output: number }>();

	constructor(private readonly sink: StreamSink) {}

	async begin(): Promise<void> {
		await this.sink.onBegin();
	}

	async end(): Promise<void> {
		await this.sink.onEnd();
	}

	setFinalResult(result?: string): void {
		if (result?.trim()) {
			this.fallbackMarkdown = result.trim();
		}
	}

	getTextOutput(): string {
		let markdown = this.resolveFinalMarkdown();
		markdown = stripNextTags(stripClaudeMessageMeta(markdown));
		return markdown.trim();
	}

	getOutput(): string {
		const markdown = this.resolveFinalMarkdown();
		const suggestions = extractNextSuggestions(markdown);
		const meta: ClaudeMessageMeta = {
			timeline: [
				...(this.thinking ? [{ type: 'thinking', content: this.thinking }] : []),
				...this.buildMarkdownTimeline(),
			] as ClaudeMessageMeta['timeline'],
			toolCalls: this.toolCalls,
			thinking: this.thinking || undefined,
			thinkingDurationMs: this.thinkingDurationMs,
			usage: this.usage,
			sessionId: this.sessionId,
			suggestions: suggestions.length ? suggestions : undefined,
		};
		return embedClaudeMessageMeta(markdown, meta);
	}

	private buildMarkdownTimeline(): Array<{ type: 'markdown'; content: string }> {
		const blocks: string[] = [];
		for (const segment of this.markdownSegments) {
			const trimmed = segment.trim();
			if (!trimmed) continue;
			if (blocks.at(-1) === trimmed) continue;
			blocks.push(trimmed);
		}
		const current = this.markdown.trim();
		if (current && blocks.at(-1) !== current) {
			blocks.push(current);
		}
		return blocks.map((content) => ({ type: 'markdown', content }));
	}

	private resolveFinalMarkdown(): string {
		if (this.markdown.trim()) return this.markdown.trim();
		const lastSegment = this.markdownSegments.at(-1);
		if (lastSegment) return lastSegment;
		return this.fallbackMarkdown;
	}

	private beginNewAssistantMarkdownRound(): void {
		if (this.markdown.trim()) {
			this.markdownSegments.push(this.markdown.trim());
		}
		this.markdown = '';
	}

	getSessionId(): string | undefined {
		return this.sessionId;
	}

	getUsage(): ClaudeMessageMeta['usage'] | undefined {
		return this.usage;
	}

	getStructuredOutput(): unknown {
		return this.structuredOutput;
	}

	getSdkSuggestions(): string[] {
		return this.sdkSuggestions;
	}

	getRefusalMessage(): string | undefined {
		return this.refusalMessage;
	}

	async consume(message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') return;
		const record = message as Record<string, unknown>;
		const type = record.type;

		if (type === 'stream_event') {
			await this.consumeStreamEvent(record);
			return;
		}

		if (type === 'assistant') {
			await this.consumeAssistantMessage(record);
			return;
		}

		if (type === 'system') {
			await this.consumeSystemMessage(record);
			return;
		}

		if (type === 'result') {
			await this.consumeResultMessage(record);
		}
	}

	private async consumeSystemMessage(record: Record<string, unknown>): Promise<void> {
		const subtype = String(record.subtype ?? '');
		if (subtype === 'model_fallback') {
			const trigger = typeof record.message === 'string'
				? record.message
				: typeof record.model === 'string'
					? record.model
					: undefined;
			await this.emit({ kind: 'model_switch', trigger });
			await this.emit({
				kind: 'status',
				phase: 'model_fallback',
				message: trigger ?? 'Model switched due to availability',
			});
		}
	}

	private async consumeStreamEvent(record: Record<string, unknown>): Promise<void> {
		const event = record.event;
		if (!event || typeof event !== 'object') return;
		const evt = event as Record<string, unknown>;
		const eventType = evt.type;

		if (eventType === 'message_start') {
			if (this.completedAssistantMessages > 0) {
				this.beginNewAssistantMarkdownRound();
			}
			const message = evt.message as Record<string, unknown> | undefined;
			this.recordStepUsageFromAnthropicMessage(message);
			return;
		}

		if (eventType === 'content_block_delta') {
			const delta = evt.delta as Record<string, unknown> | undefined;
			if (!delta) return;
			if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
				this.markdown += delta.text;
				await this.emit({ kind: 'text', text: delta.text });
			}
			if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
				if (!this.thinkingStarted) {
					this.thinkingStarted = true;
					await this.emit({ kind: 'thinking_start' });
				}
				this.thinking += delta.thinking;
				await this.emit({ kind: 'thinking_chunk', text: delta.thinking });
			}
		}

		if (eventType === 'content_block_start') {
			const block = evt.content_block as Record<string, unknown> | undefined;
			if (block?.type === 'tool_use') {
				const callId = String(block.id ?? '');
				const name = String(block.name ?? 'tool');
				if (callId && !this.startedTools.has(callId)) {
					this.startedTools.add(callId);
					if (shouldShowToolInUi(name)) {
						this.toolCalls.push({ id: callId, name, label: resolveToolLabel(name), done: false });
						await this.emit({
							kind: 'tool_start',
							callId,
							name,
							label: resolveToolLabel(name),
						});
					}
				}
			}
		}

		if (eventType === 'content_block_stop') {
			const pending = this.toolCalls.find((t) => !t.done);
			if (pending) {
				pending.done = true;
				await this.emit({ kind: 'tool_end', callId: pending.id, ok: true });
			}
		}

		if (eventType === 'message_stop' && this.thinkingStarted) {
			this.thinkingStarted = false;
			await this.emit({ kind: 'thinking_end', durationMs: this.thinkingDurationMs });
		}
	}

	private async consumeAssistantMessage(record: Record<string, unknown>): Promise<void> {
		this.completedAssistantMessages++;

		const message = record.message as Record<string, unknown> | undefined;
		this.recordStepUsageFromAnthropicMessage(message);
		const content = message?.content;
		if (!Array.isArray(content)) return;
		for (const block of content) {
			if (!block || typeof block !== 'object') continue;
			const b = block as Record<string, unknown>;
			if (b.type === 'text' && typeof b.text === 'string' && b.text) {
				await this.appendAssistantText(b.text);
			}
			if (b.type === 'tool_use') {
				const callId = String(b.id ?? '');
				const name = String(b.name ?? 'tool');
				if (callId && !this.startedTools.has(callId) && shouldShowToolInUi(name)) {
					this.startedTools.add(callId);
					this.toolCalls.push({ id: callId, name, label: resolveToolLabel(name), done: true });
					await this.emit({ kind: 'tool_start', callId, name, label: resolveToolLabel(name) });
					await this.emit({ kind: 'tool_end', callId, ok: true });
				}
			}
		}
	}

	private async appendAssistantText(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;

		// SDK 常在 stream delta 后再发同内容的 assistant 消息：只补齐缺口，禁止重开一轮或重播全文
		if (this.markdown.trim() === trimmed) return;
		const lastSegment = this.markdownSegments.at(-1)?.trim();
		if (!this.markdown.trim() && lastSegment === trimmed) return;

		if (trimmed.startsWith(this.markdown)) {
			const suffix = trimmed.slice(this.markdown.length);
			this.markdown = trimmed;
			if (!suffix) return;
			await this.emit({ kind: 'text', text: suffix });
			return;
		}
		if (this.markdown.startsWith(trimmed)) return;

		this.beginNewAssistantMarkdownRound();
		this.markdown = trimmed;
		await this.emit({ kind: 'text', text: trimmed });
	}

	private async consumeResultMessage(record: Record<string, unknown>): Promise<void> {
		if (typeof record.session_id === 'string' && record.session_id) {
			this.sessionId = record.session_id;
			await this.emit({ kind: 'session', sessionId: record.session_id });
		}
		if (typeof record.result === 'string' && record.result.trim()) {
			this.fallbackMarkdown = record.result.trim();
		}

		const structured = record.structured_output ?? record.structuredOutput;
		if (structured !== undefined && structured !== null) {
			this.structuredOutput = structured;
			await this.emit({ kind: 'structured', data: structured });
		}

		const rawSuggestions = record.prompt_suggestions ?? record.promptSuggestions;
		if (Array.isArray(rawSuggestions)) {
			const items = rawSuggestions
				.map((item) => (typeof item === 'string' ? item : String(item ?? '')).trim())
				.filter(Boolean);
			if (items.length) {
				this.sdkSuggestions = items;
				await this.emit({ kind: 'suggestions', items });
			}
		}

		if (record.stop_reason === 'refusal') {
			this.refusalMessage = String(record.result ?? 'Claude refused the request');
			await this.emit({ kind: 'refusal', message: this.refusalMessage });
			await this.emit({ kind: 'status', phase: 'refusal', message: this.refusalMessage });
		}
		const usage = record.usage as Record<string, unknown> | undefined;
		const resolvedUsage = this.resolveUsageFromResult(usage, record.total_cost_usd);
		if (resolvedUsage) {
			this.usage = resolvedUsage;
			await this.emit({
				kind: 'usage',
				inputTokens: resolvedUsage.inputTokens,
				outputTokens: resolvedUsage.outputTokens,
				costUsd: resolvedUsage.costUsd,
			});
		}
		if (record.subtype === 'success') {
			await this.emit({ kind: 'status', phase: 'success', message: 'completed' });
		} else if (record.subtype === 'error') {
			await this.emit({ kind: 'status', phase: 'error', message: String(record.result ?? 'error') });
		}
	}

	private recordStepUsageFromAnthropicMessage(message?: Record<string, unknown>): void {
		if (!message || typeof message !== 'object') return;
		const msgId = typeof message.id === 'string' ? message.id : undefined;
		const usage = message.usage as Record<string, unknown> | undefined;
		if (!msgId || !usage) return;

		const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
		const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
		if (input <= 0 && output <= 0) return;

		this.stepUsageByMessageId.set(msgId, { input, output });
	}

	private aggregateStepUsageFallback(): { inputTokens: number; outputTokens: number } | undefined {
		if (this.stepUsageByMessageId.size === 0) return undefined;

		let inputTokens = 0;
		let outputTokens = 0;
		for (const step of this.stepUsageByMessageId.values()) {
			inputTokens += step.input;
			outputTokens += step.output;
		}
		if (inputTokens <= 0 && outputTokens <= 0) return undefined;
		return { inputTokens, outputTokens };
	}

	private resolveUsageFromResult(
		usage: Record<string, unknown> | undefined,
		totalCostUsd: unknown,
	): ClaudeMessageMeta['usage'] | undefined {
		const costUsd = typeof totalCostUsd === 'number' ? totalCostUsd : undefined;

		if (usage) {
			const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
			const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
			const hasNonZero = (inputTokens ?? 0) > 0 || (outputTokens ?? 0) > 0;
			if (hasNonZero) {
				return { inputTokens, outputTokens, costUsd };
			}
		}

		const fallback = this.aggregateStepUsageFallback();
		if (fallback) {
			return { ...fallback, costUsd };
		}

		if (!usage) return undefined;

		const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
		const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
		if (inputTokens === undefined && outputTokens === undefined) return undefined;
		return { inputTokens, outputTokens, costUsd };
	}

	private async emit(payload: ClaudeStreamPayload): Promise<void> {
		await this.sink.onStructured(encodeClaudeStreamPayload(payload));
	}
}
