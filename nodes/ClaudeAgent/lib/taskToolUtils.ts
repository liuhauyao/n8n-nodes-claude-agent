import type { AgentTaskItem } from './claudeStreamProtocol';

/** 去掉 MCP 前缀，得到裸工具名 */
export function bareToolName(toolName: string): string {
	if (!toolName) return toolName;
	return toolName.includes('__') ? toolName.split('__').pop() ?? toolName : toolName;
}

export function isTaskPlanningToolName(toolName: string): boolean {
	const bare = bareToolName(toolName);
	return bare === 'TaskCreate' || bare === 'TaskUpdate';
}

/** SDK system.task_updated 的 status → 前端 agentTasks status */
export function mapSdkTaskStatus(
	raw: string | undefined,
): AgentTaskItem['status'] | undefined {
	if (!raw) return undefined;
	if (raw === 'completed') return 'completed';
	if (raw === 'pending') return 'pending';
	if (raw === 'in_progress' || raw === 'running') return 'in_progress';
	if (raw === 'deleted') return 'deleted';
	return undefined;
}

/**
 * 从 "Task #1 created successfully: xxx" / "Updated task #1 status" 这类纯文本
 * 兜底提取 taskId。部分模型/网关（如经 OpenAI 兼容 shim 转发的第三方模型，2026-07-07
 * 生产复现：model=deepseek-v4-flash）返回的 tool_result.content /
 * PostToolUse.tool_response 是人类可读文本而非结构化 JSON——SDK 官方结构化数据
 * 实际挂在与 message 同级的 tool_use_result 字段（见 extractTaskIdFromToolResultBlock
 * 的 toolUseResult 参数），此函数仅作该字段缺失时的最后兜底，避免误把 tool_use_id
 * 当成任务 id（曾导致 TaskUpdate 永远匹配不到已创建任务、Queue 卡在 pending 不勾选）。
 */
function extractTaskIdFromPlainTextResult(text: string): string | undefined {
	const created = text.match(/Task\s*#(\S+)\s+created/i);
	if (created) return created[1];
	const updated = text.match(/[Uu]pdated?\s+task\s*#(\S+)/i);
	if (updated) return updated[1];
	return undefined;
}

/** 从 TaskCreate / TaskUpdate 的 tool_response 或 tool_result.content 提取 taskId */
export function extractTaskIdFromToolPayload(raw: unknown): string | undefined {
	if (!raw) return undefined;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		try {
			return extractTaskIdFromToolPayload(JSON.parse(trimmed));
		} catch {
			return extractTaskIdFromPlainTextResult(trimmed);
		}
	}
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const found = extractTaskIdFromToolPayload(
				item && typeof item === 'object' ? (item as Record<string, unknown>).text ?? item : item,
			);
			if (found) return found;
		}
		return undefined;
	}
	if (typeof raw === 'object') {
		const obj = raw as Record<string, unknown>;
		const task = obj.task as Record<string, unknown> | undefined;
		if (task && typeof task.id === 'string') return task.id;
		if (typeof obj.taskId === 'string') return obj.taskId;
		if (typeof obj.id === 'string') return obj.id;
	}
	return undefined;
}

/**
 * 从 Anthropic tool_result 块提取 taskId。
 * @param toolUseResult SDK 消息里与 message 同级的 `tool_use_result` 结构化字段
 * （官方 TaskCreateOutput 真源：{ task: { id, subject } }）；block.content 只是
 * 喂给模型看的文本，不同上游模型/网关格式不一致，不能作为主判据。
 */
export function extractTaskIdFromToolResultBlock(
	block: Record<string, unknown>,
	toolUseResult?: unknown,
): string | undefined {
	const fromStructured = extractTaskIdFromToolPayload(toolUseResult);
	if (fromStructured) return fromStructured;
	const fromContent = extractTaskIdFromToolPayload(block.content);
	if (fromContent) return fromContent;
	return extractTaskIdFromToolPayload(block);
}

export function extractTaskUpdateFromToolResultBlock(
	block: Record<string, unknown>,
	toolUseResult?: unknown,
): {
	taskId?: string;
	status?: AgentTaskItem['status'];
} {
	const tryParse = (raw: unknown): { taskId?: string; status?: AgentTaskItem['status'] } | undefined => {
		if (!raw) return undefined;
		if (typeof raw === 'string') {
			try {
				return tryParse(JSON.parse(raw));
			} catch {
				const taskId = extractTaskIdFromPlainTextResult(raw);
				return taskId ? { taskId } : undefined;
			}
		}
		if (Array.isArray(raw)) {
			for (const item of raw) {
				const found = tryParse(
					item && typeof item === 'object' ? (item as Record<string, unknown>).text ?? item : item,
				);
				if (found?.taskId) return found;
			}
			return undefined;
		}
		if (typeof raw === 'object') {
			const obj = raw as Record<string, unknown>;
			const taskId = typeof obj.taskId === 'string'
				? obj.taskId
				: extractTaskIdFromToolPayload(obj);
			if (!taskId) return undefined;
			const statusChange = obj.statusChange as Record<string, unknown> | undefined;
			const status = statusChange && typeof statusChange.to === 'string'
				? mapSdkTaskStatus(statusChange.to)
				: undefined;
			return { taskId, status };
		}
		return undefined;
	};

	// 结构化 tool_use_result（官方 TaskUpdateOutput 真源）优先于喂给模型看的文本 content
	const fromStructured = tryParse(toolUseResult);
	if (fromStructured?.taskId) return fromStructured;
	const fromContent = tryParse(block.content);
	if (fromContent?.taskId) return fromContent;
	return tryParse(block) ?? {};
}

export function extractTaskUpdateFields(
	input: Record<string, unknown>,
): { taskId?: string; fields: Partial<AgentTaskItem> } {
	const taskId = (input.taskId ?? input.id ?? input.task_id) as string | undefined;
	const fields: Partial<AgentTaskItem> = {};
	const status = mapSdkTaskStatus(typeof input.status === 'string' ? input.status : undefined);
	if (status) fields.status = status;
	if (typeof input.subject === 'string') fields.subject = input.subject;
	if (typeof input.description === 'string') fields.description = input.description;
	if (typeof input.activeForm === 'string') fields.activeForm = input.activeForm;
	return { taskId, fields };
}
