import type { INodeProperties } from 'n8n-workflow';

/** Options → MCP 内：按工具名限制 Agent 可见/可调的 MCP 工具（与业务无关，由工作流填写） */
export const MCP_TOOL_FILTER_PROPERTIES: INodeProperties[] = [
	{
		displayName: 'MCP Tool Filter',
		name: 'mcpToolAccess',
		type: 'collection',
		placeholder: 'Configure Tool Filter',
		default: { filterMode: 'none' },
		description:
			'Limit MCP tools per configured server. Tool names are bare names from the server tools/list (no mcp__ prefix).',
		options: [
			{
				displayName: 'Filter Mode',
				name: 'filterMode',
				type: 'options',
				options: [
					{ name: 'No Filter', value: 'none' },
					{ name: 'Deny List', value: 'deny' },
					{ name: 'Allow List', value: 'allow' },
				],
				default: 'none',
			},
			{
				displayName: 'Denied Tool Names',
				name: 'deniedTools',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description:
					'Comma or newline separated. Applied to each MCP server key in MCP Servers / JSON.',
				displayOptions: {
					show: {
						filterMode: ['deny'],
					},
				},
			},
			{
				displayName: 'Allowed Tool Names',
				name: 'allowedTools',
				type: 'string',
				typeOptions: { rows: 6 },
				default: '',
				description: 'Allow list: only these tools (plus optional catalog below for deny complement).',
				displayOptions: {
					show: {
						filterMode: ['allow'],
					},
				},
			},
			{
				displayName: 'Tool Catalog (Allow Complement)',
				name: 'allowComplementCatalog',
				type: 'string',
				typeOptions: { rows: 8 },
				default: '',
				description:
					'Optional full tool name list from your MCP server. When set with Allow List, all catalog tools except allowed ones are denied (Claude: removed from context; Cursor: cli.json deny).',
				displayOptions: {
					show: {
						filterMode: ['allow'],
					},
				},
			},
		],
	},
];
