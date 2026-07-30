/** Headless n8n 不可用：无交互通道，启用会导致空转循环 */
export const HEADLESS_DISALLOWED_TOOLS = ['AskUserQuestion', 'TodoWrite'] as const;

export function mergeDisallowedTools(presetTools?: string[]): string[] {
	const merged = new Set<string>(HEADLESS_DISALLOWED_TOOLS);
	if (presetTools) {
		for (const tool of presetTools) merged.add(tool);
	}
	return [...merged];
}

export type PermissionPresetConfig = {
	allowedTools?: string[];
	disallowedTools?: string[];
	permissionMode?: string;
	allowDangerouslySkipPermissions?: boolean;
	/** SDK Options.tools：string[] 为内置工具 allow-list；preset 加载全部 Claude Code 工具 */
	tools?: { type: 'preset'; preset: 'claude_code' } | readonly string[];
	defaultStrictMcpConfig?: boolean;
};

/** 灵感助手 / plan_only：显式内置工具 allow-list（未列出的一律不加载） */
const MCP_SKILLS_BUILTIN_TOOLS = [
	'Skill',
	'TaskCreate',
	'TaskUpdate',
	'ListMcpResourcesTool',
	'ReadMcpResourceTool',
] as const;

/**
 * 纵深防御 deny：allow-list 已兜住；此处覆盖别名与高危名，
 * 防止 SDK 升级把新默认工具塞进 session。
 */
const MCP_SKILLS_DEFENSE_DENY = [
	'Bash', 'bash', 'InvokeBash', 'run', 'PowerShell', 'REPL',
	'Agent', 'Task', 'SendMessage', 'SendUserFile', 'PushNotification',
	'Workflow', 'Monitor', 'EnterWorktree', 'ExitWorktree',
	'TaskStop', 'TaskGet', 'TaskList', 'TaskOutput',
	'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
	'WebFetch', 'WebSearch', 'Artifact', 'ClaudeDesign', 'Projects',
	'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger',
	'EnterPlanMode', 'ExitPlanMode', 'EndConversation',
] as const;

const CODEBASE_READ_TOOLS = {
	tools: { type: 'preset', preset: 'claude_code' } as const,
	allowedTools: ['Read', 'Grep', 'Glob'],
	disallowedTools: [
		'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
	],
	permissionMode: 'bypassPermissions',
	allowDangerouslySkipPermissions: true,
};

export const PERMISSION_PRESETS: Record<string, PermissionPresetConfig> = {
	customer_service: {
		...CODEBASE_READ_TOOLS,
	},
	read_only: {
		...CODEBASE_READ_TOOLS,
	},
	mcp_skills_only: {
		tools: [...MCP_SKILLS_BUILTIN_TOOLS],
		allowedTools: ['Skill', 'TaskCreate', 'TaskUpdate'],
		disallowedTools: [...MCP_SKILLS_DEFENSE_DENY],
		permissionMode: 'dontAsk',
		defaultStrictMcpConfig: true,
	},
	plan_only: {
		tools: [...MCP_SKILLS_BUILTIN_TOOLS],
		allowedTools: ['Skill', 'TaskCreate', 'TaskUpdate'],
		disallowedTools: [...MCP_SKILLS_DEFENSE_DENY],
		permissionMode: 'dontAsk',
	},
	/** 内部调试：全量 Claude Code 工具；灵感助手生产路径勿用 */
	full_agent: {
		tools: { type: 'preset', preset: 'claude_code' },
		permissionMode: 'bypassPermissions',
		allowDangerouslySkipPermissions: true,
	},
};

const LEGACY_PERMISSION_PRESET_ALIASES: Record<string, keyof typeof PERMISSION_PRESETS> = {
	world_assistant: 'full_agent',
};

export function resolvePermissionPreset(raw: string): keyof typeof PERMISSION_PRESETS {
	const key = LEGACY_PERMISSION_PRESET_ALIASES[raw] ?? raw;
	if (key in PERMISSION_PRESETS) {
		return key as keyof typeof PERMISSION_PRESETS;
	}
	return 'customer_service';
}

export function resolveQueryPermissionMode(
	presetMode: string | undefined,
): { permissionMode?: string } {
	if (!presetMode) return {};
	return { permissionMode: presetMode };
}

/** 取 preset 的内置工具 allow-list（string[]）；preset 模式返回 null 表示「全量」 */
export function getExpectedBuiltinTools(presetKey: string): string[] | null {
	const key = resolvePermissionPreset(presetKey);
	const tools = PERMISSION_PRESETS[key].tools;
	if (Array.isArray(tools)) return [...tools];
	return null;
}

/**
 * 对比 SDK init 消息中的实际 tools 与 allow-list。
 * 返回超出 allow-list 的内置工具名（MCP 工具 mcp__* 忽略）。
 */
export function findUnexpectedBuiltinTools(
	actualTools: string[] | undefined,
	expectedBuiltin: string[] | null,
): string[] {
	if (!actualTools?.length || expectedBuiltin === null) return [];
	const expected = new Set(expectedBuiltin);
	// Task 是 Agent 的历史别名，init 可能仍列作 Task
	if (expected.has('Agent')) expected.add('Task');
	if (expected.has('Task')) expected.add('Agent');
	return actualTools.filter((name) => {
		if (!name || name.startsWith('mcp__')) return false;
		return !expected.has(name);
	});
}
