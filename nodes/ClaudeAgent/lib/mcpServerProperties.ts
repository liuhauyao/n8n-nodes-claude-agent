import type { INodeProperties } from 'n8n-workflow';

export const MCP_SERVER_OPTION_PROPERTIES: INodeProperties[] = [
	{
		displayName: 'MCP Servers',
		name: 'mcpServers',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		options: [
			{
				displayName: 'Server',
				name: 'server',
				values: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{
						displayName: 'Transport',
						name: 'transport',
						type: 'options',
						options: [
							{ name: 'HTTP', value: 'http' },
							{ name: 'SSE', value: 'sse' },
							{ name: 'Stdio', value: 'stdio' },
						],
						default: 'http',
					},
					{
						displayName: 'URL',
						name: 'url',
						type: 'string',
						default: '',
						displayOptions: { show: { transport: ['http', 'sse'] } },
					},
					{
						displayName: 'Headers JSON',
						name: 'headersJson',
						type: 'string',
						default: '',
						displayOptions: { show: { transport: ['http', 'sse'] } },
					},
					{
						displayName: 'Command',
						name: 'command',
						type: 'string',
						default: '',
						displayOptions: { show: { transport: ['stdio'] } },
					},
					{
						displayName: 'Arguments',
						name: 'args',
						type: 'string',
						typeOptions: { multipleValues: true },
						default: [],
						displayOptions: { show: { transport: ['stdio'] } },
					},
					{
						displayName: 'Environment JSON',
						name: 'envJson',
						type: 'string',
						default: '',
						displayOptions: { show: { transport: ['stdio'] } },
					},
					{
						displayName: 'Working Directory',
						name: 'cwd',
						type: 'string',
						default: '',
						displayOptions: { show: { transport: ['stdio'] } },
					},
				],
			},
		],
	},
	{
		displayName: 'MCP Servers JSON',
		name: 'mcpServersJson',
		type: 'string',
		typeOptions: { rows: 6 },
		default: '',
		description: 'When set, overrides the MCP Servers form',
	},
	{
		displayName: 'Strict MCP Config',
		name: 'strictMcpConfig',
		type: 'boolean',
		default: false,
		description: 'Ignore project .mcp.json and use only servers configured here',
	},
];
