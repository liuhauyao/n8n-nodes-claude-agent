import {
	encodeClaudeStreamPayload,
	embedClaudeMessageMeta,
	resolveToolLabel,
	type AgentMetaPendingQuestion,
	type ClaudeMessageMeta,
	type ClaudeStreamPayload,
} from './claudeStreamProtocol';
import {
	isAskQuestionToolName,
	isUpdateTodosToolName,
	parseAskQuestionArgs,
	parseUpdateTodosArgs,
	type AskQuestionItem,
} from './askTodoProtocol';
import { toAgentPendingQuestion } from './hitlTypes';

export interface StreamSink {
	onBegin: () => void | Promise<void>;
	onStructured: (jsonContent: string) => void | Promise<void>;
	onEnd: () => void | Promise<void>;
}

export class ClaudeStreamAssembler {
	private markdown = '';
	private thinking = '';
	private thinkingStarted = false;
	private thinkingDurationMs?: number;
	private readonly startedTools = new Set<string>();
	private readonly toolCalls: ClaudeMessageMeta['toolCalls'] = [];
	private readonly todos: Array<{ id: string; content: string; status: string }> = [];
	private sessionId?: string;
	private usage?: ClaudeMessageMeta['usage'];
	private fallbackMarkdown = '';
	private lastAskCallId = '';
	private lastAskTitle?: string;
	private lastAskQuestions: AskQuestionItem[] = [];
	private lastRequestId = '';
	private awaitingInput = false;
	private readonly emittedAskQuestions = new Set<string>();

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
		return this.markdown || this.fallbackMarkdown;
	}

	getOutput(options?: { pendingQuestion?: AgentMetaPendingQuestion | null }): string {
		const markdown = this.markdown || this.fallbackMarkdown;
		const pendingQuestion =
			options?.pendingQuestion !== undefined
				? options.pendingQuestion
				: this.awaitingInput && this.lastAskCallId
					? this.getPendingQuestionMeta()
					: undefined;
		const meta: ClaudeMessageMeta = {
			timeline: [
				...(this.thinking ? [{ type: 'thinking', content: this.thinking }] : []),
				...(markdown ? [{ type: 'markdown', content: markdown }] : []),
				...(this.todos.length > 0 ? [{ type: 'todos', items: this.todos }] : []),
			] as ClaudeMessageMeta['timeline'],
			toolCalls: this.toolCalls,
			thinking: this.thinking || undefined,
			thinkingDurationMs: this.thinkingDurationMs,
			usage: this.usage,
			sessionId: this.sessionId,
			todos: this.todos.length > 0 ? [...this.todos] : undefined,
			pendingQuestion: pendingQuestion ?? null,
		};
		return embedClaudeMessageMeta(markdown, meta);
	}

	getSessionId(): string | undefined {
		return this.sessionId;
	}

	getUsage(): ClaudeMessageMeta['usage'] | undefined {
		return this.usage;
	}

	isAwaitingInput(): boolean {
		return this.awaitingInput;
	}

	getPendingQuestionMeta(): AgentMetaPendingQuestion | undefined {
		if (!this.lastAskCallId || this.lastAskQuestions.length === 0) return undefined;
		const requestId = this.lastRequestId || this.lastAskCallId;
		return toAgentPendingQuestion(
			this.lastAskCallId,
			requestId,
			this.lastAskTitle,
			this.lastAskQuestions,
		);
	}

	async emitHitlCheckpoint(params: {
		executionId: string;
		resumeUrl: string;
		segmentIndex: number;
	}): Promise<void> {
		const pendingQuestion = this.getPendingQuestionMeta();
		if (!pendingQuestion) return;
		await this.emit({
			kind: 'hitl_checkpoint',
			executionId: params.executionId,
			resumeUrl: params.resumeUrl,
			pendingQuestion,
			segmentIndex: params.segmentIndex,
			requestId: pendingQuestion.requestId,
			callId: pendingQuestion.callId,
		});
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

	private async handleAskQuestionTool(callId: string, args: unknown): Promise<void> {
		const parsed = parseAskQuestionArgs(args);
		if (!parsed || this.emittedAskQuestions.has(callId)) return;
		this.emittedAskQuestions.add(callId);
		this.lastAskCallId = callId;
		this.lastAskTitle = parsed.title;
		this.lastAskQuestions = parsed.questions;
		this.lastRequestId = callId;
		this.awaitingInput = true;
		await this.emit({
			kind: 'ask_question',
			callId,
			title: parsed.title,
			questions: parsed.questions,
		});
		await this.emit({ kind: 'awaiting_input', requestId: callId });
	}

	private async handleUpdateTodosTool(args: unknown): Promise<void> {
		const items = parseUpdateTodosArgs(args);
		if (!items?.length) return;
		for (const item of items) {
			const idx = this.todos.findIndex((t) => t.id === item.id);
			if (idx >= 0) this.todos[idx] = item;
			else this.todos.push(item);
		}
		await this.emit({ kind: 'todo_update', items: [...this.todos] });
	}

	private async consumeStreamEvent(record: Record<string, unknown>): Promise<void> {
		const event = record.event;
		if (!event || typeof event !== 'object') return;
		const evt = event as Record<string, unknown>;
		const eventType = evt.type;

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
				const input = block.input;
				if (isAskQuestionToolName(name)) {
					await this.handleAskQuestionTool(callId, input);
					return;
				}
				if (isUpdateTodosToolName(name)) {
					await this.handleUpdateTodosTool(input);
					return;
				}
				if (callId && !this.startedTools.has(callId)) {
					this.startedTools.add(callId);
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
		const message = record.message as Record<string, unknown> | undefined;
		const content = message?.content;
		if (!Array.isArray(content)) return;
		for (const block of content) {
			if (!block || typeof block !== 'object') continue;
			const b = block as Record<string, unknown>;
			if (b.type === 'text' && typeof b.text === 'string' && b.text) {
				if (!this.markdown.endsWith(b.text)) {
					const suffix = b.text.startsWith(this.markdown) ? b.text.slice(this.markdown.length) : b.text;
					if (suffix) {
						this.markdown += suffix;
						await this.emit({ kind: 'text', text: suffix });
					}
				}
			}
			if (b.type === 'tool_use') {
				const callId = String(b.id ?? '');
				const name = String(b.name ?? 'tool');
				const input = b.input;
				if (isAskQuestionToolName(name)) {
					await this.handleAskQuestionTool(callId, input);
					continue;
				}
				if (isUpdateTodosToolName(name)) {
					await this.handleUpdateTodosTool(input);
					continue;
				}
				if (callId && !this.startedTools.has(callId)) {
					this.startedTools.add(callId);
					this.toolCalls.push({ id: callId, name, label: resolveToolLabel(name), done: true });
					await this.emit({ kind: 'tool_start', callId, name, label: resolveToolLabel(name) });
					await this.emit({ kind: 'tool_end', callId, ok: true });
				}
			}
		}
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
