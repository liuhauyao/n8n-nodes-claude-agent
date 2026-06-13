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
	tools?: { type: 'preset'; preset: 'claude_code' } | readonly string[];
	defaultStrictMcpConfig?: boolean;
};

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
		tools: { type: 'preset', preset: 'claude_code' },
		disallowedTools: [
			'Bash', 'Write', 'Edit', 'Read', 'Grep', 'Glob',
			'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
		],
		permissionMode: 'dontAsk',
		defaultStrictMcpConfig: true,
	},
	plan_only: {
		tools: { type: 'preset', preset: 'claude_code' },
		disallowedTools: [
			'Bash', 'Write', 'Edit', 'Read', 'Grep', 'Glob',
			'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
		],
		permissionMode: 'dontAsk',
	},
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
