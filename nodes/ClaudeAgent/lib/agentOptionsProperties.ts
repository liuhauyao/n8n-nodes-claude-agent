import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';

import { MCP_SERVER_OPTION_PROPERTIES } from './mcpServerProperties';

const SETTING_SOURCE_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Project', value: 'project', description: 'Load .claude from the working directory' },
	{ name: 'User', value: 'user' },
	{ name: 'Local', value: 'local' },
	{ name: 'Team', value: 'team' },
	{ name: 'Plugins', value: 'plugins' },
];

export const CLAUDE_AGENT_OPTIONS_PROPERTY: INodeProperties = {
	displayName: 'Options',
	name: 'options',
	type: 'collection',
	placeholder: 'Add Option',
	default: {},
	options: [
		{
			displayName: 'Session',
			name: 'session',
			type: 'collection',
			placeholder: 'Configure Session',
			default: {},
			description: 'Multi-turn persistence via Redis (requires Redis credential on this node)',
			options: [
				{
					displayName: 'Session ID',
					name: 'sessionId',
					type: 'string',
					default: '',
					description: 'Business conversation key mapped to Claude SDK session_id in Redis',
				},
				{
					displayName: 'Session TTL (Seconds)',
					name: 'sessionTtlSeconds',
					type: 'number',
					default: 604800,
				},
				{
					displayName: 'Session Runtime',
					name: 'sessionRuntime',
					type: 'options',
					default: 'sidecar',
					options: [
						{
							name: 'Sidecar (Recommended)',
							value: 'sidecar',
							description:
								'Long-lived Agent Sidecar on localhost; supports setModel() for model switches without losing context',
						},
						{
							name: 'Stateless (Fallback)',
							value: 'stateless',
							description: 'Cold query() per n8n execution; uses resume/forkSession for session continuity',
						},
					],
				},
				{
					displayName: 'Sidecar URL',
					name: 'sidecarUrl',
					type: 'string',
					default: '={{ $env.CLAUDE_AGENT_SIDECAR_URL || "http://127.0.0.1:18790" }}',
					displayOptions: {
						show: {
							sessionRuntime: ['sidecar'],
						},
					},
					description: 'Base URL of claude-agent-sidecar (default http://127.0.0.1:18790)',
				},
			],
		},
		{
			displayName: 'Workspace',
			name: 'workspace',
			type: 'collection',
			placeholder: 'Configure Workspace',
			default: {},
			description: 'Skills, working directories, and Claude setting layers',
			options: [
				{
					displayName: 'Skills Root Directory',
					name: 'skillsRoot',
					type: 'string',
					default: '',
					description: 'Directory containing .claude/skills (placed first in cwd resolution)',
				},
				{
					displayName: 'Working Directories',
					name: 'workingDirectories',
					type: 'string',
					typeOptions: { multipleValues: true },
					default: [],
				},
				{
					displayName: 'Working Directory (Legacy)',
					name: 'workingDirectory',
					type: 'string',
					default: '',
				},
				{
					displayName: 'Setting Sources',
					name: 'settingSources',
					type: 'multiOptions',
					options: SETTING_SOURCE_OPTIONS,
					default: ['project'],
				},
				{
					displayName: 'Skills',
					name: 'skills',
					type: 'string',
					default: '',
					description: 'Comma-separated skill names, or "all" to enable every discovered skill',
				},
			],
		},
		{
			displayName: 'Agent Behavior',
			name: 'agentBehavior',
			type: 'collection',
			placeholder: 'Configure Behavior',
			default: {},
			options: [
				{
					displayName: 'Permission Preset',
					name: 'permissionPreset',
					type: 'options',
					default: 'customer_service',
					options: [
						{ name: 'MCP + Skills Only (no local file access)', value: 'mcp_skills_only' },
						{ name: 'Plan — No Tools Executed', value: 'plan_only' },
						{ name: 'Restricted — Read/Grep/Glob + Skills', value: 'customer_service' },
						{ name: 'Strict Read Only (alias for Restricted)', value: 'read_only' },
						{ name: 'Full Claude Code Tools', value: 'full_agent' },
					],
				},
				{
					displayName: 'Max Turns',
					name: 'maxTurns',
					type: 'number',
					default: 12,
					description: 'Maximum agentic turns (0 = SDK default; default 12 for headless workflows)',
				},
				{
					displayName: 'Use Claude Code System Prompt Preset',
					name: 'useClaudeCodePreset',
					type: 'boolean',
					default: true,
				},
				{
					displayName: 'Enable Extended Thinking',
					name: 'thinkingEnabled',
					type: 'boolean',
					default: false,
					description: 'Enable Claude extended thinking (maps to SDK thinking.type=enabled)',
				},
				{
					displayName: 'Max Thinking Tokens',
					name: 'maxThinkingTokens',
					type: 'number',
					default: 10000,
					displayOptions: {
						show: {
							thinkingEnabled: [true],
						},
					},
				},
				{
					displayName: 'Turn Budget (USD)',
					name: 'maxBudgetUsd',
					type: 'number',
					default: 0,
					description: 'Maximum USD cost per turn (0 = unlimited)',
				},
				{
					displayName: 'Forward Subagent Text',
					name: 'forwardSubagentText',
					type: 'boolean',
					default: false,
					description: 'Include subagent text output in the main stream when using subagents',
				},
				{
					displayName: 'Context Window Size (tokens)',
					name: 'contextWindowSize',
					type: 'number',
					default: 0,
					description: 'Model context window size in tokens. Set to match the model configured in Admin → AI Model. Used for proactive compaction (Direction B, triggers at 85%) and reactive compaction (Direction A). 0 = disabled.',
				},
			],
		},
		{
			displayName: 'Output',
			name: 'output',
			type: 'collection',
			placeholder: 'Configure Output',
			default: {},
			options: [
				{
					displayName: 'Structured Output JSON Schema',
					name: 'outputFormatSchema',
					type: 'string',
					typeOptions: { rows: 8 },
					default: '',
					description: 'JSON Schema for structured output (maps to SDK outputFormat). Leave empty to disable.',
				},
				{
					displayName: 'Output Schema Name',
					name: 'outputFormatName',
					type: 'string',
					default: 'output',
				},
				{
					displayName: 'Tool Search Mode',
					name: 'toolSearchMode',
					type: 'options',
					default: 'unset',
					options: [
						{ name: 'Unset (Provider Default)', value: 'unset' },
						{ name: 'Enabled', value: 'true' },
						{ name: 'Auto', value: 'auto' },
						{ name: 'Disabled', value: 'false' },
					],
					description: 'Sets ENABLE_TOOL_SEARCH in SDK env when not unset',
				},
			],
		},
		{
			displayName: 'Hooks',
			name: 'hooks',
			type: 'collection',
			placeholder: 'Configure Hooks',
			default: {},
			options: [
				{
					displayName: 'Hooks Config JSON',
					name: 'hooksJson',
					type: 'string',
					typeOptions: { rows: 8 },
					default: '',
					description:
						'Declarative hooks config. Example: {"preToolUse":{"maxCallsPerTurn":20,"perToolMaxCalls":{"mcp__server__tool":3}}}',
				},
			],
		},
		{
			displayName: 'Subagents',
			name: 'subagents',
			type: 'collection',
			placeholder: 'Configure Subagents',
			default: {},
			options: [
				{
					displayName: 'Enable Subagents',
					name: 'subagentsEnabled',
					type: 'boolean',
					default: false,
				},
				{
					displayName: 'Subagents JSON',
					name: 'subagentsJson',
					type: 'string',
					typeOptions: { rows: 8 },
					default: '',
					displayOptions: {
						show: {
							subagentsEnabled: [true],
						},
					},
					description: 'JSON array of AgentDefinition objects passed to SDK agents option',
				},
				{
					displayName: 'Primary Agent Override JSON',
					name: 'primaryAgentJson',
					type: 'string',
					typeOptions: { rows: 6 },
					default: '',
					description: 'Optional AgentDefinition JSON passed to SDK agent option',
				},
			],
		},
		{
			displayName: 'MCP',
			name: 'mcp',
			type: 'collection',
			placeholder: 'Configure MCP',
			default: {},
			options: MCP_SERVER_OPTION_PROPERTIES,
		},
	],
};
