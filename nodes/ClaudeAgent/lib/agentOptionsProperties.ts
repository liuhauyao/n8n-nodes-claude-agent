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
						{ name: 'Restricted — Read/Web + MCP', value: 'customer_service' },
						{ name: 'Strict Read Only', value: 'read_only' },
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
