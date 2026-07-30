/** 声明式 Hooks JSON → SDK programmatic hooks（无 eval） */
import type { HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import {
	bareToolName,
	extractTaskIdFromToolPayload,
	mapSdkTaskStatus,
} from './taskToolUtils';

export interface DeclarativePreToolUseConfig {
	maxCallsPerTurn?: number;
	perToolMaxCalls?: Record<string, number>;
}

export interface DeclarativePostToolUseConfig {
	logToOutput?: boolean;
}

/**
 * Stop Hook：headless 场景下用作输出前的硬性质量门（等价 CLI `/goal` 的确定性版本，
 * 不额外调用评估模型）。仅做规则可判定的检查——不判断记忆是否该写（那属于 Agent
 * 自身的主观判断，见 SKILL「写入检查」），只判断已发生的客观事实：
 * - 本轮是否有 MCP 写工具成功却缺 `<proposal_created>`
 * - 正文 `<proposal_created proposalId>` 是否 ⊆ 本轮写工具返回的 proposalId
 * - 正文是否缺 `<next>` 建议
 * - 若本轮建立了「作业规划」Task，是否全部 completed
 */
export interface DeclarativeStopHookConfig {
	enabled?: boolean;
	/** 连续 block 上限，避免死循环（参考 Claude Code /goal 8 次上限，headless 建议更小） */
	maxBlocks?: number;
	/** 正文缺 `<next>` 时是否 block */
	requireNextTag?: boolean;
	/** 命中 proposalWriteTools 成功调用后，正文缺 `<proposal_created` 时是否 block */
	requireProposalCreatedOnToolSuccess?: boolean;
	/**
	 * 正文中 `<proposal_created proposalId>` 必须 ⊆ 本轮 proposalWriteTools 的 tool_response
	 * 所记录的 proposalId（防手拼/幻觉 ID）
	 */
	requireProposalIdsSubsetOfToolResults?: boolean;
	/** 触发 proposal 相关 Stop 检查的工具名（裸名或前缀通配，如 'write*'） */
	proposalWriteTools?: string[];
	/** 若本轮存在 Task 作业规划，是否要求全部 completed 才允许结束 */
	requireAllTasksCompleted?: boolean;
}

export interface DeclarativeHooksConfig {
	preToolUse?: DeclarativePreToolUseConfig;
	postToolUse?: DeclarativePostToolUseConfig;
	stopHook?: DeclarativeStopHookConfig;
}

export interface HookRuntimeState {
	toolCallCount: number;
	perToolCounts: Map<string, number>;
	postToolLogs: Array<{ tool: string; ok: boolean; error?: string }>;
	/** 本轮成功执行过的工具裸名集合（供 Stop Hook 判定 proposal_created 是否遗漏） */
	postToolSuccessNames: Set<string>;
	/** 本轮 proposalWriteTools 成功响应中解析出的 proposalId（供子集校验） */
	proposalIdsFromWriteTools: Set<string>;
	/** 本轮 Task 作业规划状态（taskId → status），供 Stop Hook 判定是否全部完成 */
	taskStatusById: Map<string, string>;
	/** Stop Hook 已连续 block 次数，达到 maxBlocks 后放行避免死循环 */
	stopBlockCount: number;
}

export function parseHooksJson(raw: string | undefined): DeclarativeHooksConfig | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as DeclarativeHooksConfig;
		if (!parsed || typeof parsed !== 'object') return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function createHookRuntimeState(): HookRuntimeState {
	return {
		toolCallCount: 0,
		perToolCounts: new Map(),
		postToolLogs: [],
		postToolSuccessNames: new Set(),
		proposalIdsFromWriteTools: new Set(),
		taskStatusById: new Map(),
		stopBlockCount: 0,
	};
}

/** 重置每轮（每条用户消息对应的一次 query 结果）的 Hook 运行态，避免跨轮累加 */
export function resetHookRuntimeStateForNextTurn(state: HookRuntimeState): void {
	state.toolCallCount = 0;
	state.perToolCounts = new Map();
	state.postToolLogs = [];
	state.postToolSuccessNames = new Set();
	state.proposalIdsFromWriteTools = new Set();
	state.taskStatusById = new Map();
	state.stopBlockCount = 0;
}

export function buildDeclarativeHooks(
	config: DeclarativeHooksConfig | undefined,
	state: HookRuntimeState,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
	if (!config?.preToolUse && !config?.postToolUse && !config?.stopHook?.enabled) return undefined;

	const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
	const preConfig = config.preToolUse;

	if (preConfig) {
		const maxCallsPerTurn = preConfig.maxCallsPerTurn;
		const perToolMaxCalls = preConfig.perToolMaxCalls ?? {};

		hooks.PreToolUse = [
			{
				hooks: [
					async (input: HookInput): Promise<HookJSONOutput> => {
						const toolName = String((input as { tool_name?: unknown }).tool_name ?? '');
						state.toolCallCount += 1;

						if (typeof maxCallsPerTurn === 'number' && maxCallsPerTurn > 0) {
							if (state.toolCallCount > maxCallsPerTurn) {
								return {
									hookSpecificOutput: {
										hookEventName: 'PreToolUse',
										permissionDecision: 'deny',
										permissionDecisionReason: `Tool call limit exceeded (${maxCallsPerTurn} per turn)`,
									},
								};
							}
						}

						for (const [pattern, limit] of Object.entries(perToolMaxCalls)) {
							if (typeof limit !== 'number' || limit <= 0) continue;
							if (!matchesToolPattern(toolName, pattern)) continue;
							const current = (state.perToolCounts.get(pattern) ?? 0) + 1;
							state.perToolCounts.set(pattern, current);
							if (current > limit) {
								return {
									hookSpecificOutput: {
										hookEventName: 'PreToolUse',
										permissionDecision: 'deny',
										permissionDecisionReason: `Tool "${toolName}" call limit exceeded (${limit} per turn)`,
									},
								};
							}
						}

						return {
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								permissionDecision: 'allow',
							},
						};
					},
				],
			},
		];
	}

	const proposalWriteToolsForPost = config.stopHook?.proposalWriteTools ?? [];

	// PostToolUse：既承载既有 logToOutput 日志，也为 Stop Hook 累积「工具是否成功」
	// 「Task 是否全部完成」「写工具 proposalId」事实依据，因此只要 stopHook 启用也需要挂载。
	if (config.postToolUse || config.stopHook?.enabled) {
		hooks.PostToolUse = [
			{
				hooks: [
					async (input: HookInput): Promise<HookJSONOutput> => {
						const toolName = String((input as { tool_name?: unknown }).tool_name ?? '');
						const bareName = bareToolName(toolName);
						state.postToolSuccessNames.add(bareName);

						const postInput = input as { tool_response?: unknown; tool_input?: unknown; tool_use_id?: string };
						if (
							proposalWriteToolsForPost.length > 0
							&& proposalWriteToolsForPost.some((pattern) => matchesToolPattern(bareName, pattern))
						) {
							const pid = extractProposalIdFromToolResponse(postInput.tool_response);
							if (pid) state.proposalIdsFromWriteTools.add(pid);
						}

						if (bareName === 'TaskCreate') {
							// extractTaskIdFromToolPayload 内含纯文本兜底解析（如第三方模型经 shim
							// 转发返回 "Task #1 created successfully: xxx"），能命中时必须只登记这一个
							// 真实 id；若额外把 tool_use_id 也登记为 pending，TaskUpdate 用真实 id
							// 完成后 tool_use_id 那条会成为永远清不掉的孤儿 pending 项，导致 Stop Hook
							// 误判"未全部完成"而无限拦截（2026-07-07 生产复现的根因之一）。
							// 仅当两种结构化/文本解析都失败时，才退化为用 tool_use_id 本身占位登记。
							const toolUseId = typeof postInput.tool_use_id === 'string' ? postInput.tool_use_id : '';
							const realId = extractTaskIdFromToolPayload(postInput.tool_response)
								?? extractTaskIdFromToolPayload(postInput.tool_input)
								?? toolUseId;
							if (realId) state.taskStatusById.set(realId, 'pending');
						} else if (bareName === 'TaskUpdate') {
							const toolInput = postInput.tool_input;
							if (toolInput && typeof toolInput === 'object') {
								const obj = toolInput as Record<string, unknown>;
								const taskId = (obj.taskId ?? obj.id ?? obj.task_id) as string | undefined;
								const status = mapSdkTaskStatus(typeof obj.status === 'string' ? obj.status : undefined);
								if (taskId && status) {
									if (status === 'deleted') state.taskStatusById.delete(taskId);
									else state.taskStatusById.set(taskId, status);
								}
							}
						}

						if (config.postToolUse?.logToOutput) {
							state.postToolLogs.push({ tool: toolName, ok: true });
						}
						return {};
					},
				],
			},
		];
	}

	if (config.stopHook?.enabled) {
		const stopConfig = config.stopHook;
		const maxBlocks = typeof stopConfig.maxBlocks === 'number' && stopConfig.maxBlocks > 0
			? stopConfig.maxBlocks
			: 3;
		const proposalWriteTools = stopConfig.proposalWriteTools ?? [];

		hooks.TaskCreated = [
			{
				hooks: [
					async (input: HookInput): Promise<HookJSONOutput> => {
						const created = input as { task_id?: string };
						if (typeof created.task_id === 'string' && created.task_id) {
							state.taskStatusById.set(created.task_id, 'pending');
						}
						return {};
					},
				],
			},
		];

		hooks.TaskCompleted = [
			{
				hooks: [
					async (input: HookInput): Promise<HookJSONOutput> => {
						const completed = input as { task_id?: string };
						if (typeof completed.task_id === 'string' && completed.task_id) {
							state.taskStatusById.set(completed.task_id, 'completed');
						}
						return {};
					},
				],
			},
		];

		hooks.Stop = [
			{
				hooks: [
					async (input: HookInput): Promise<HookJSONOutput> => {
						const stopInput = input as { last_assistant_message?: string };
						const lastMessage = stopInput.last_assistant_message ?? '';
						const reasons: string[] = [];

						if (stopConfig.requireNextTag && !/<next>/i.test(lastMessage)) {
							reasons.push('正文缺少 <next> 快捷建议，请在末尾补充 2-4 条');
						}

						if (stopConfig.requireProposalCreatedOnToolSuccess && proposalWriteTools.length > 0) {
							const hasProposalWriteSuccess = [...state.postToolSuccessNames].some((name) =>
								proposalWriteTools.some((pattern) => matchesToolPattern(name, pattern)),
							);
							if (hasProposalWriteSuccess && !/<proposal_created/i.test(lastMessage)) {
								reasons.push('本轮已成功执行创改删工具，但正文缺少 <proposal_created> 标记');
							}
						}

						if (
							stopConfig.requireProposalIdsSubsetOfToolResults
							&& proposalWriteTools.length > 0
							&& state.proposalIdsFromWriteTools.size > 0
						) {
							const bodyIds = extractProposalIdsFromAssistantMessage(lastMessage);
							const unknown = bodyIds.filter((id) => !state.proposalIdsFromWriteTools.has(id));
							if (unknown.length > 0) {
								reasons.push(
									`正文 <proposal_created> 含未在本轮写工具结果中出现的 proposalId（${unknown.join(', ')}），`
									+ '请整行原样输出 MCP 响应字段 proposalCreatedTag，禁止手拼或改写 ID',
								);
							}
						}

						if (stopConfig.requireAllTasksCompleted && state.taskStatusById.size > 0) {
							const incomplete = [...state.taskStatusById.values()].some(
								(status) => status !== 'completed',
							);
							if (incomplete) {
								reasons.push(
									'作业规划 Task 尚未全部 completed：每完成一步必须 TaskUpdate（status: completed），'
									+ '开始下一步前 TaskUpdate（status: in_progress）；禁止仅用 Markdown 表格/报告代替 TaskUpdate',
								);
							}
						}

						if (reasons.length === 0) return {};

						if (state.stopBlockCount >= maxBlocks) {
							// 达到 block 上限，放行避免死循环；问题留给下一轮或人工介入
							return {};
						}
						state.stopBlockCount += 1;

						// SDK 官方契约：Stop 事件必须在顶层设置 decision:'block' + reason 才会真正
						// 阻止 Claude 结束本轮；单独的 hookSpecificOutput.additionalContext 只是「非阻断
						// 式反馈」，不会阻止 Stop（此前版本只写了 additionalContext，Hook 从未真正拦截过，
						// 这是任务清单「生成但不勾选完成」的根因，而非 streamAssembler/前端捕获问题）。
						const reason = reasons.join('；') + '。请补齐后再结束本轮回复。';
						return {
							decision: 'block',
							reason,
							hookSpecificOutput: {
								hookEventName: 'Stop',
								additionalContext: reason,
							},
						};
					},
				],
			},
		];
	}

	return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function matchesToolPattern(toolName: string, pattern: string): boolean {
	if (pattern === toolName) return true;
	if (pattern.endsWith('*')) {
		return toolName.startsWith(pattern.slice(0, -1));
	}
	return toolName.includes(pattern);
}

/** 从写工具 tool_response 提取 proposalId（优先 proposalCreatedTag / XML，否则 JSON 字段） */
export function extractProposalIdFromToolResponse(toolResponse: unknown): string | null {
	if (toolResponse == null) return null;
	if (typeof toolResponse === 'object' && !Array.isArray(toolResponse)) {
		const obj = toolResponse as Record<string, unknown>;
		const direct = obj.proposalId ?? obj.proposal_id;
		if (typeof direct === 'string' && direct.trim()) return direct.trim();
		if (typeof direct === 'number' && Number.isFinite(direct)) return String(direct);
		const tag = obj.proposalCreatedTag;
		if (typeof tag === 'string') {
			const fromTag = extractProposalIdsFromAssistantMessage(tag)[0];
			if (fromTag) return fromTag;
		}
	}
	const text = typeof toolResponse === 'string'
		? toolResponse
		: (() => {
			try {
				return JSON.stringify(toolResponse);
			} catch {
				return '';
			}
		})();
	if (!text) return null;
	const fromXml = extractProposalIdsFromAssistantMessage(text)[0];
	if (fromXml) return fromXml;
	const jsonMatch = text.match(/"proposalId"\s*:\s*"([^"]+)"/);
	return jsonMatch?.[1]?.trim() || null;
}

/** 从助手正文抽取全部 `<proposal_created proposalId="…">` */
export function extractProposalIdsFromAssistantMessage(message: string): string[] {
	if (!message) return [];
	const ids: string[] = [];
	const re = /<proposal_created\b[^>]*\bproposalId="([^"]+)"/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(message)) !== null) {
		const id = m[1]?.trim();
		if (id) ids.push(id);
	}
	return ids;
}
