import {
	encodeClaudeStreamPayload,
	embedClaudeMessageMeta,
	extractNextSuggestions,
	resolveToolLabel,
	shouldShowToolInUi,
	stripClaudeMessageMeta,
	stripNextTags,
	type AgentTaskItem,
	type ClaudeMessageMeta,
	type ClaudeStreamPayload,
} from './claudeStreamProtocol';
import {
	bareToolName,
	extractTaskIdFromToolResultBlock,
	extractTaskUpdateFields,
	extractTaskUpdateFromToolResultBlock,
	isTaskPlanningToolName,
	mapSdkTaskStatus,
} from './taskToolUtils';

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

	/**
	 * 用户作业规划（Task 工具）状态。与「强制开工顺序」无关，仅复杂多步业务
	 * 诉求时才会非空——SDK TaskCreate 的真实 taskId 只出现在其 tool_result 里，
	 * 因此需要 pendingTaskCreates 暂存 create 阶段的字段，等 tool_result 到达
	 * 后再登记真实 id；TaskUpdate 的 input 里已带 taskId，可直接应用。
	 */
	private readonly agentTasks: AgentTaskItem[] = [];
	private readonly taskIndexByRealId = new Map<string, number>();
	private readonly pendingTaskCreates = new Map<
		string,
		{ subject: string; description?: string; activeForm?: string }
	>();
	private readonly pendingTaskUpdates = new Map<string, Partial<AgentTaskItem>>();
	private readonly processedTaskToolUseIds = new Set<string>();
	/** TaskCreate 的 tool_use_id → SDK 真实 taskId（解析失败时用于 TaskUpdate 对齐） */
	private readonly toolUseIdToRealId = new Map<string, string>();

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
		const agentTasks = this.getAgentTasks();
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
			agentTasks: agentTasks.length ? agentTasks : undefined,
		};
		return embedClaudeMessageMeta(markdown, meta);
	}

	/** 当前用户作业规划快照（过滤 deleted），空数组表示本回合无复杂任务 */
	getAgentTasks(): AgentTaskItem[] {
		return this.agentTasks.filter((task) => task.status !== 'deleted');
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

		if (type === 'user') {
			await this.consumeUserMessage(record);
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
			return;
		}

		if (subtype === 'task_started') {
			const taskId = typeof record.task_id === 'string' ? record.task_id : undefined;
			const toolUseId = typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined;
			if (taskId && toolUseId) {
				this.toolUseIdToRealId.set(toolUseId, taskId);
				if (this.migrateTaskId(toolUseId, taskId)) {
					await this.emitTaskSnapshot();
				}
			}
			return;
		}

		if (subtype === 'task_updated') {
			const taskId = typeof record.task_id === 'string' ? record.task_id : undefined;
			const patch = record.patch as Record<string, unknown> | undefined;
			const status = mapSdkTaskStatus(typeof patch?.status === 'string' ? patch.status : undefined);
			if (taskId && status && this.tryApplyTaskUpdateWithMigration(taskId, { status })) {
				await this.emitTaskSnapshot();
			}
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
		let taskChanged = false;
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
				if (callId && isTaskPlanningToolName(name)) {
					const input = (b.input as Record<string, unknown>) ?? {};
					if (this.handleTaskToolUse(callId, name, input)) taskChanged = true;
				}
			}
		}
		if (taskChanged) await this.emitTaskSnapshot();
	}

	/**
	 * 用户作业规划工具（Task）来自完整 assistant message 的 tool_use 块（含已解析
	 * 完整 input），而非 stream_event 的增量 delta（tool_use 的 input 在流式阶段是
	 * TaskCreate 的 subject/description 在 assistant tool_use 完整 input 中即可解析，
	 * 解析后立即登记并推送 task_snapshot（不必等 tool_result）。tool_result 到达时
	 * 若含 SDK 真实 taskId 则迁移 id；TaskUpdate 的 input 已带 taskId，可直接应用。
	 * 返回 true 表示 agentTasks 快照发生了可见变化（需要上层 emit）。
	 */
	private handleTaskToolUse(callId: string, name: string, input: Record<string, unknown>): boolean {
		if (this.processedTaskToolUseIds.has(callId)) return false;
		this.processedTaskToolUseIds.add(callId);

		const bareName = bareToolName(name);
		if (bareName === 'TaskCreate') {
			const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
			if (!subject) return false;
			if (this.resolveTaskIndex(callId) !== undefined) return false;
			const description = typeof input.description === 'string' ? input.description : undefined;
			const activeForm = typeof input.activeForm === 'string' ? input.activeForm : undefined;
			this.registerTaskId(
				callId,
				{
					id: callId,
					subject,
					description,
					activeForm,
					status: 'pending',
				},
				callId,
			);
			return true;
		}

		if (bareName === 'TaskUpdate') {
			const { taskId, fields } = extractTaskUpdateFields(input);
			if (!taskId || !Object.keys(fields).length) return false;
			return this.tryApplyTaskUpdateWithMigration(taskId, fields);
		}

		return false;
	}

	private resolveTaskIndex(taskId: string): number | undefined {
		const direct = this.taskIndexByRealId.get(taskId);
		if (direct !== undefined) return direct;

		const aliased = this.toolUseIdToRealId.get(taskId);
		if (aliased) {
			const idx = this.taskIndexByRealId.get(aliased);
			if (idx !== undefined) return idx;
		}

		for (const [toolUseId, realId] of this.toolUseIdToRealId) {
			if (taskId === realId) {
				const idx = this.taskIndexByRealId.get(realId) ?? this.taskIndexByRealId.get(toolUseId);
				if (idx !== undefined) return idx;
			}
		}

		return undefined;
	}

	private tryApplyTaskUpdateWithMigration(taskId: string, fields: Partial<AgentTaskItem>): boolean {
		if (this.applyTaskUpdate(taskId, fields)) return true;
		const tasks = this.getAgentTasks();
		if (tasks.length === 1 && tasks[0].id.startsWith('call_') && taskId !== tasks[0].id) {
			if (this.migrateTaskId(tasks[0].id, taskId)) {
				this.applyTaskUpdate(taskId, fields);
				return true;
			}
		}
		this.applyTaskUpdate(taskId, fields);
		return false;
	}

	private applyTaskUpdate(taskId: string, fields: Partial<AgentTaskItem>): boolean {
		const idx = this.resolveTaskIndex(taskId);
		if (idx === undefined) {
			const existing = this.pendingTaskUpdates.get(taskId) ?? {};
			this.pendingTaskUpdates.set(taskId, { ...existing, ...fields });
			return false;
		}
		const prev = this.agentTasks[idx];
		const next = { ...prev, ...fields };
		if (JSON.stringify(prev) === JSON.stringify(next)) return false;
		this.agentTasks[idx] = next;
		return true;
	}

	private migrateTaskId(fromId: string, toId: string): boolean {
		if (!fromId || !toId || fromId === toId) return false;
		const idx = this.taskIndexByRealId.get(fromId);
		if (idx === undefined) return false;

		this.agentTasks[idx] = { ...this.agentTasks[idx], id: toId };
		this.taskIndexByRealId.delete(fromId);
		this.taskIndexByRealId.set(toId, idx);
		this.toolUseIdToRealId.set(fromId, toId);

		const pending = this.pendingTaskUpdates.get(fromId);
		if (pending) {
			this.applyTaskUpdate(toId, pending);
			this.pendingTaskUpdates.delete(fromId);
		}
		const pendingByReal = this.pendingTaskUpdates.get(toId);
		if (pendingByReal) {
			this.applyTaskUpdate(toId, pendingByReal);
			this.pendingTaskUpdates.delete(toId);
		}
		return true;
	}

	private registerTaskId(realId: string, initial: AgentTaskItem, toolUseId?: string): void {
		if (toolUseId && realId !== toolUseId) {
			this.toolUseIdToRealId.set(toolUseId, realId);
			if (this.taskIndexByRealId.has(toolUseId)) {
				this.migrateTaskId(toolUseId, realId);
				return;
			}
		}

		const idx = this.agentTasks.length;
		this.agentTasks.push(initial);
		this.taskIndexByRealId.set(realId, idx);
		if (toolUseId) this.toolUseIdToRealId.set(toolUseId, realId);

		for (const key of [realId, toolUseId].filter(Boolean) as string[]) {
			const pendingUpdate = this.pendingTaskUpdates.get(key);
			if (pendingUpdate) {
				this.applyTaskUpdate(realId, pendingUpdate);
				this.pendingTaskUpdates.delete(key);
			}
		}
	}

	private async consumeUserMessage(record: Record<string, unknown>): Promise<void> {
		const message = record.message as Record<string, unknown> | undefined;
		const content = message?.content;
		if (!Array.isArray(content)) return;
		// SDK 官方结构化结果（TaskCreateOutput/TaskUpdateOutput 真源）挂在消息记录的
		// tool_use_result 字段，与 message.content 同级；message.content[].content
		// 只是喂给模型看的人类可读文本，不同上游模型/网关（如第三方模型经 OpenAI 兼容
		// shim 转发）格式不一致（例如纯文本 "Task #1 created successfully: ..."），
		// 曾误把 taskId 解析兜底成 tool_use_id，导致 TaskUpdate 永远匹配不到已创建的
		// 任务、前端 Queue 卡在 pending 不勾选——这是本类 bug 的真实根因。
		const toolUseResult = record.tool_use_result ?? (record as Record<string, unknown>).toolUseResult;
		let changed = false;
		for (const block of content) {
			if (!block || typeof block !== 'object') continue;
			const b = block as Record<string, unknown>;
			if (b.type !== 'tool_result') continue;
			if (this.handleTaskToolResult(b, toolUseResult)) changed = true;
			if (this.handleTaskUpdateToolResult(b, toolUseResult)) changed = true;
		}
		if (changed) await this.emitTaskSnapshot();
	}

	/** TaskUpdate 的 tool_result：从 statusChange 确认状态（assistant tool_use 已先行解析时作兜底） */
	private handleTaskUpdateToolResult(block: Record<string, unknown>, toolUseResult?: unknown): boolean {
		const { taskId, status } = extractTaskUpdateFromToolResultBlock(block, toolUseResult);
		if (!taskId) return false;
		const fields: Partial<AgentTaskItem> = {};
		if (status) fields.status = status;
		if (!Object.keys(fields).length) return false;
		return this.tryApplyTaskUpdateWithMigration(taskId, fields);
	}

	private handleTaskToolResult(block: Record<string, unknown>, toolUseResult?: unknown): boolean {
		const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
		if (!toolUseId) return false;

		const parsedId = extractTaskIdFromToolResultBlock(block, toolUseResult);
		const existingIdx = this.resolveTaskIndex(toolUseId);
		if (existingIdx !== undefined) {
			this.pendingTaskCreates.delete(toolUseId);
			if (parsedId && parsedId !== toolUseId) {
				return this.migrateTaskId(toolUseId, parsedId);
			}
			return false;
		}

		const pending = this.pendingTaskCreates.get(toolUseId);
		if (!pending) return false;
		this.pendingTaskCreates.delete(toolUseId);

		const realId = parsedId ?? toolUseId;
		this.registerTaskId(
			realId,
			{
				id: realId,
				subject: pending.subject || realId,
				description: pending.description,
				activeForm: pending.activeForm,
				status: 'pending',
			},
			toolUseId,
		);
		return true;
	}

	private async emitTaskSnapshot(): Promise<void> {
		await this.emit({ kind: 'task_snapshot', tasks: this.getAgentTasks() });
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
			if (this.getAgentTasks().length > 0) {
				await this.emitTaskSnapshot();
			}
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
