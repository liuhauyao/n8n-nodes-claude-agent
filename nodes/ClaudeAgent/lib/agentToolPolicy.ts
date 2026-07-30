/**
 * 灵感助手工具展示策略（节点侧）。
 * 与前端 matrees-shared/utils/ai/agentToolPolicy.ts 保持语义一致。
 */

export type AgentToolGroup =
	| 'retrieve'
	| 'write'
	| 'audit'
	| 'novel'
	| 'relation'
	| 'illustration'
	| 'internal'
	| 'unknown';

export type AgentToolVisibility = 'show' | 'hidden';

function bareToolName(rawName: string): string {
	if (!rawName) return '';
	if (rawName.startsWith('mcp__')) {
		const parts = rawName.split('__').filter(Boolean);
		return parts[parts.length - 1] ?? rawName;
	}
	if (rawName.includes('·')) {
		return rawName.split('·').pop()?.trim() ?? rawName;
	}
	return rawName.trim();
}

/** T4 隐身：过程噪声 / 记忆 / MCP 资源 */
const HIDDEN_TOOLS = new Set([
	'Skill',
	'getMemory',
	'writeMemory',
	'getUserMemory',
	'saveUserMemory',
	'getWorldMemory',
	'saveWorldMemory',
	'patchUserMemory',
	'patchWorldMemory',
	'contributeWorldMemory',
	'recordMemoryAtom',
	'getRecentChatMessages',
	'ListMcpResourcesTool',
	'ReadMcpResourceTool',
	'ReadMcpResourceDirTool',
	'listMcpResources',
	'fetchMcpResource',
	// Task 规划工具走 task_snapshot，不在工具条展示
	'TaskCreate',
	'TaskUpdate',
	'TaskGet',
	'TaskList',
	'TodoWrite',
	'AskUserQuestion',
	// 能力边界外：漏网也不向 UI 发流式事件
	'Bash', 'bash', 'InvokeBash', 'run',
	'Agent', 'Task', 'SendMessage', 'TaskStop',
	'Workflow', 'EnterWorktree', 'ExitWorktree',
	'Read', 'Write', 'Edit', 'Grep', 'Glob',
	'WebFetch', 'WebSearch',
]);

const GROUP_BY_TOOL: Record<string, AgentToolGroup> = {
	searchWorld: 'retrieve',
	keywordSearchWorld: 'retrieve',
	semanticSearchWorld: 'retrieve',
	getEntity: 'retrieve',
	getWorldContext: 'retrieve',
	getDefinition: 'retrieve',
	getEvent: 'retrieve',
	getConcept: 'retrieve',
	getDefinitionTree: 'retrieve',
	getCalendars: 'retrieve',
	getWorldOverview: 'retrieve',
	getContentBlocks: 'retrieve',
	getContentBlockById: 'retrieve',
	listAccessibleWorlds: 'retrieve',
	getProposalStatus: 'retrieve',
	listMyProposals: 'retrieve',

	writeDefinitionProposal: 'write',
	writeEventProposal: 'write',
	writeConceptProposal: 'write',
	deleteEntityProposal: 'write',
	manageProposal: 'write',
	createDefinitionProposal: 'write',
	updateDefinitionProposal: 'write',
	deleteDefinitionProposal: 'write',
	createEventProposal: 'write',
	updateEventProposal: 'write',
	deleteEventProposal: 'write',
	updateConceptProposal: 'write',
	submitProposal: 'write',
	revokeProposal: 'write',
	discardProposal: 'write',

	listPendingProposals: 'audit',
	getProposalDiff: 'audit',
	auditProposal: 'audit',
	approveProposal: 'audit',
	rejectProposal: 'audit',
	approveProposalWithMerge: 'audit',

	getWork: 'novel',
	listNovelStructure: 'novel',
	getChapter: 'novel',
	listMySeeds: 'novel',
	writeWorkProposal: 'novel',
	writeChapterProposal: 'novel',
	manageVolume: 'novel',
	sortNovelStructure: 'novel',
	createWorkProposal: 'novel',
	updateWorkProposal: 'novel',
	deleteWorkProposal: 'novel',
	createChapterProposal: 'novel',
	updateChapterProposal: 'novel',
	deleteChapterProposal: 'novel',
	createVolume: 'novel',
	updateVolume: 'novel',
	deleteVolume: 'novel',
	sortVolumes: 'novel',
	sortChapters: 'novel',

	listRelationEnums: 'relation',
	listItemRelations: 'relation',
	writeRelationProposal: 'relation',
	manageRelationEnum: 'relation',
	createRelationProposal: 'relation',
	updateRelationProposal: 'relation',
	listCustomRelationEnums: 'relation',
	createCustomRelationEnum: 'relation',
	updateCustomRelationEnum: 'relation',
	deleteCustomRelationEnum: 'relation',

	listIllustration: 'illustration',
	uploadIllustrationFromUrl: 'illustration',

	Skill: 'internal',
	getMemory: 'internal',
	writeMemory: 'internal',
	recordMemoryAtom: 'internal',
	getRecentChatMessages: 'internal',
	ListMcpResourcesTool: 'internal',
	ReadMcpResourceTool: 'internal',
	ReadMcpResourceDirTool: 'internal',
	TaskCreate: 'internal',
	TaskUpdate: 'internal',
};

export function resolveToolVisibility(rawName: string): AgentToolVisibility {
	const bare = bareToolName(rawName);
	if (HIDDEN_TOOLS.has(bare) || HIDDEN_TOOLS.has(rawName)) return 'hidden';
	return 'show';
}

export function resolveToolGroup(rawName: string): AgentToolGroup {
	const bare = bareToolName(rawName);
	return GROUP_BY_TOOL[bare] ?? GROUP_BY_TOOL[rawName] ?? 'unknown';
}

function pickString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!obj) return undefined;
	for (const key of keys) {
		const v = obj[key];
		if (typeof v === 'string' && v.trim()) return v.trim();
	}
	return undefined;
}

/**
 * 用户可见的工具失败文案：只保留失败态语义，不暴露 MCP/协议原文。
 * Agent 侧仍可通过 tool_result 读到完整错误；本函数仅用于流式 meta / 前端展示。
 */
export function sanitizeToolErrorForDisplay(
	raw?: string | null,
	opts?: { denied?: boolean },
): string | undefined {
	if (opts?.denied) return '权限不足';
	if (raw == null || !String(raw).trim()) return '未成功';
	const s = String(raw).trim();
	if (
		s.startsWith('{')
		|| s.startsWith('[')
		|| /TOOL_ERROR|No such tool|ECONNREFUSED|ENOENT|mcp__/i.test(s)
		|| /itemType|entityType|worldId|proposalId/i.test(s)
		|| /可选\s*[:：]|definition\s*,\s*event/i.test(s)
		|| /\bat\s+[\w.]+\(/.test(s)
	) {
		return '未成功';
	}
	const latinHeavy = (s.replace(/[\u4e00-\u9fff\s，。！？、；：""''（）]/g, '').match(/[A-Za-z_]/g) || []).length;
	if (s.length > 40 || latinHeavy >= 8) return '未成功';
	return s;
}

/**
 * 生成 T2 脱敏摘要：仅白名单业务字段，不做通用 JSON 序列化。
 */
export function summarizeToolCall(
	rawName: string,
	input?: Record<string, unknown> | null,
	output?: unknown,
): string | undefined {
	const bare = bareToolName(rawName);
	const out =
		output && typeof output === 'object' && !Array.isArray(output)
			? (output as Record<string, unknown>)
			: undefined;

	const keyword = pickString(input ?? undefined, ['keyword', 'query', 'q', 'search']);
	const title = pickString(input ?? undefined, ['title', 'name', 'subject']);
	const entityType = pickString(input ?? undefined, [
		'entityType',
		'entity_type',
		'proposalType',
		'proposal_type',
		'itemType',
		'item_type',
	]);
	const decision = pickString(input ?? undefined, ['decision', 'operate', 'operateType']);
	const mode = pickString(input ?? undefined, ['mode', 'scope']);

	// 稳定顺序：动作 · 类型 · 「标题」· 关键词，便于展示层拼完整短句
	const parts: string[] = [];
	if (decision) parts.push(decision);
	if (entityType) parts.push(entityType);
	if (title) parts.push(`「${title}」`);
	if (keyword) parts.push(keyword);
	if (mode && !keyword && !title && !decision) parts.push(mode);

	if (out) {
		const failed = out.success === false || out.is_error === true || !!out.error;
		if (failed) {
			parts.push(sanitizeToolErrorForDisplay(pickString(out, ['message', 'msg', 'error']))!);
		}
		const outTitle = pickString(out, ['title', 'fileId', 'illustrationId']);
		if (outTitle && (bare.includes('upload') || bare.includes('Illustration'))) {
			parts.push(outTitle.slice(0, 40));
		}
	}

	if (!parts.length) return undefined;
	return parts.join(' · ').slice(0, 120);
}
