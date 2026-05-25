import {
	encodeClaudeStreamPayload,
	embedClaudeMessageMeta,
	resolveToolLabel,
	shouldShowToolInUi,
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
		return this.resolveFinalMarkdown();
	}

	getOutput(): string {
		const markdown = this.resolveFinalMarkdown();
		const markdownTimeline = [
			...this.markdownSegments.map((content) => ({ type: 'markdown', content })),
			...(this.markdown.trim() ? [{ type: 'markdown', content: this.markdown.trim() }] : []),
		];
		const meta: ClaudeMessageMeta = {
			timeline: [
				...(this.thinking ? [{ type: 'thinking', content: this.thinking }] : []),
				...markdownTimeline,
			] as ClaudeMessageMeta['timeline'],
			toolCalls: this.toolCalls,
			thinking: this.thinking || undefined,
			thinkingDurationMs: this.thinkingDurationMs,
			usage: this.usage,
			sessionId: this.sessionId,
		};
		return embedClaudeMessageMeta(markdown, meta);
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

		if (type === 'result') {
			await this.consumeResultMessage(record);
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
		if (this.completedAssistantMessages > 0) {
			this.beginNewAssistantMarkdownRound();
		}
		this.completedAssistantMessages++;

		const message = record.message as Record<string, unknown> | undefined;
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
		if (!text) return;
		if (this.markdown === text) return;
		if (text.startsWith(this.markdown)) {
			const suffix = text.slice(this.markdown.length);
			if (!suffix) return;
			this.markdown += suffix;
			await this.emit({ kind: 'text', text: suffix });
			return;
		}
		if (this.markdown.startsWith(text)) return;
		if (this.markdown && text.includes(this.markdown)) {
			const suffix = text.slice(this.markdown.length);
			this.markdown = text;
			if (suffix) await this.emit({ kind: 'text', text: suffix });
			return;
		}
		this.beginNewAssistantMarkdownRound();
		this.markdown = text;
		await this.emit({ kind: 'text', text });
	}

	private async consumeResultMessage(record: Record<string, unknown>): Promise<void> {
		if (typeof record.session_id === 'string' && record.session_id) {
			this.sessionId = record.session_id;
			await this.emit({ kind: 'session', sessionId: record.session_id });
		}
		if (typeof record.result === 'string' && record.result.trim()) {
			this.fallbackMarkdown = record.result.trim();
		}
		const usage = record.usage as Record<string, unknown> | undefined;
		if (usage) {
			this.usage = {
				inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
				outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
				costUsd: typeof record.total_cost_usd === 'number' ? record.total_cost_usd : undefined,
			};
		}
		if (record.subtype === 'success') {
			await this.emit({ kind: 'status', phase: 'success', message: 'completed' });
		} else if (record.subtype === 'error') {
			await this.emit({ kind: 'status', phase: 'error', message: String(record.result ?? 'error') });
		}
	}

	private async emit(payload: ClaudeStreamPayload): Promise<void> {
		await this.sink.onStructured(encodeClaudeStreamPayload(payload));
	}
}
