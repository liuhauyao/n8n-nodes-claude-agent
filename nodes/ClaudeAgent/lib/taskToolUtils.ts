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

/** 从 TaskCreate / TaskUpdate 的 tool_response 或 tool_result.content 提取 taskId */
export function extractTaskIdFromToolPayload(raw: unknown): string | undefined {
	if (!raw) return undefined;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		try {
			return extractTaskIdFromToolPayload(JSON.parse(trimmed));
		} catch {
			return undefined;
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

/** 从 Anthropic tool_result 块提取 taskId */
export function extractTaskIdFromToolResultBlock(block: Record<string, unknown>): string | undefined {
	const fromContent = extractTaskIdFromToolPayload(block.content);
	if (fromContent) return fromContent;
	return extractTaskIdFromToolPayload(block);
}

export function extractTaskUpdateFromToolResultBlock(block: Record<string, unknown>): {
	taskId?: string;
	status?: AgentTaskItem['status'];
} {
	const tryParse = (raw: unknown): { taskId?: string; status?: AgentTaskItem['status'] } | undefined => {
		if (!raw) return undefined;
		if (typeof raw === 'string') {
			try {
				return tryParse(JSON.parse(raw));
			} catch {
				return undefined;
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
