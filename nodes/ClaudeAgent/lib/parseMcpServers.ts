import type { IDataObject } from 'n8n-workflow';

export type McpTransport = 'http' | 'sse' | 'stdio';

export interface McpServerConfig {
	type?: McpTransport;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
}

export interface McpServerFormEntry {
	name?: string;
	transport?: McpTransport | string;
	url?: string;
	headersJson?: string;
	command?: string;
	args?: string | string[];
	envJson?: string;
	cwd?: string;
	headers?: { header?: Array<{ name?: string; value?: string }> };
	envVars?: { envVar?: Array<{ name?: string; value?: string }> };
}

export interface McpServersFormValue {
	server?: McpServerFormEntry[];
}

function parseKeyValueCollection(
	entries: Array<{ name?: string; value?: string }> | undefined,
): Record<string, string> | undefined {
	if (!entries?.length) return undefined;
	const result: Record<string, string> = {};
	for (const entry of entries) {
		const key = entry.name?.trim();
		if (!key) continue;
		result[key] = String(entry.value ?? '');
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function parseJsonRecord(raw: string | undefined, fieldLabel: string): Record<string, string> | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error(`${fieldLabel} must be valid JSON object`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${fieldLabel} must be a JSON object`);
	}
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value === undefined || value === null) continue;
		result[key] = String(value);
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeArgs(args: string | string[] | undefined): string[] | undefined {
	if (args === undefined || args === null) return undefined;
	if (Array.isArray(args)) {
		const normalized = args.map((arg) => String(arg).trim()).filter(Boolean);
		return normalized.length > 0 ? normalized : undefined;
	}
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	return trimmed.split(',').map((part) => part.trim()).filter(Boolean);
}

function buildServerConfig(entry: McpServerFormEntry, index: number): { name: string; config: McpServerConfig } {
	const name = entry.name?.trim();
	if (!name) {
		throw new Error(`MCP server at index ${index + 1} is missing a name`);
	}

	const transport = (entry.transport?.trim().toLowerCase() || 'http') as McpTransport;
	if (transport !== 'http' && transport !== 'sse' && transport !== 'stdio') {
		throw new Error(`MCP server "${name}" has unsupported transport "${entry.transport}"`);
	}

	if (transport === 'stdio') {
		const command = entry.command?.trim();
		if (!command) {
			throw new Error(`MCP server "${name}" (stdio) requires a command`);
		}
		const config: McpServerConfig = { type: 'stdio', command };
		const args = normalizeArgs(entry.args);
		if (args) config.args = args;
		const env =
			parseKeyValueCollection(entry.envVars?.envVar)
			?? parseJsonRecord(entry.envJson, `MCP server "${name}" env JSON`);
		if (env) config.env = env;
		const cwd = entry.cwd?.trim();
		if (cwd) config.cwd = cwd;
		return { name, config };
	}

	const url = entry.url?.trim();
	if (!url) {
		throw new Error(`MCP server "${name}" (${transport}) requires a URL`);
	}
	const headers =
		parseKeyValueCollection(entry.headers?.header)
		?? parseJsonRecord(entry.headersJson, `MCP server "${name}" headers JSON`);
	const config: McpServerConfig = { type: transport, url };
	if (headers) config.headers = headers;
	return { name, config };
}

function parseFormServers(formValue: McpServersFormValue | undefined): Record<string, McpServerConfig> {
	const entries = formValue?.server;
	if (!entries?.length) return {};

	const result: Record<string, McpServerConfig> = {};
	for (let index = 0; index < entries.length; index++) {
		const { name, config } = buildServerConfig(entries[index], index);
		if (result[name]) {
		 throw new Error(`Duplicate MCP server name "${name}"`);
		}
		result[name] = config;
	}
	return result;
}

function assertMcpServerConfig(name: string, raw: unknown): McpServerConfig {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`MCP server "${name}" must be a JSON object`);
	}
	const record = raw as Record<string, unknown>;
	const explicitType = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';

	if (explicitType === 'stdio' || (!explicitType && typeof record.command === 'string')) {
		const command = typeof record.command === 'string' ? record.command.trim() : '';
		if (!command) {
			throw new Error(`MCP server "${name}" (stdio) requires "command"`);
		}
		const config: McpServerConfig = { type: 'stdio', command };
		if (Array.isArray(record.args)) {
			config.args = record.args.map((arg) => String(arg));
		}
		if (record.env && typeof record.env === 'object' && !Array.isArray(record.env)) {
			config.env = Object.fromEntries(
				Object.entries(record.env as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
			);
		}
		if (typeof record.cwd === 'string' && record.cwd.trim()) {
			config.cwd = record.cwd.trim();
		}
		return config;
	}

	const transport =
		explicitType === 'sse' || explicitType === 'http'
			? explicitType
			: explicitType === '' && typeof record.url === 'string'
				? 'http'
				: '';
	if (transport !== 'http' && transport !== 'sse') {
		throw new Error(`MCP server "${name}" must specify type "http", "sse", or "stdio"`);
	}

	const url = typeof record.url === 'string' ? record.url.trim() : '';
	if (!url) {
		throw new Error(`MCP server "${name}" (${transport}) requires "url"`);
	}
	const config: McpServerConfig = { type: transport, url };
	if (record.headers && typeof record.headers === 'object' && !Array.isArray(record.headers)) {
		config.headers = Object.fromEntries(
			Object.entries(record.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
		);
	}
	return config;
}

function parseJsonServers(mcpServersJson: string): Record<string, McpServerConfig> {
	const trimmed = mcpServersJson.trim();
	if (!trimmed) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error('MCP Servers JSON must be valid JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('MCP Servers JSON must be an object keyed by server name');
	}

	const result: Record<string, McpServerConfig> = {};
	for (const [name, config] of Object.entries(parsed as IDataObject)) {
		const trimmedName = name.trim();
		if (!trimmedName) continue;
		result[trimmedName] = assertMcpServerConfig(trimmedName, config);
	}
	return result;
}

export function parseMcpServers(
	mcpServersJson: string | undefined,
	formValue: McpServersFormValue | undefined,
): Record<string, McpServerConfig> {
	const jsonOverride = mcpServersJson?.trim();
	if (jsonOverride) {
		return parseJsonServers(jsonOverride);
	}
	return parseFormServers(formValue);
}

export function toClaudeSdkMcpServers(
	servers: Record<string, McpServerConfig>,
): Record<string, Record<string, unknown>> {
	const result: Record<string, Record<string, unknown>> = {};
	for (const [name, config] of Object.entries(servers)) {
		if (config.type === 'stdio' || config.command) {
			result[name] = {
				command: config.command,
				...(config.args ? { args: config.args } : {}),
				...(config.env ? { env: config.env } : {}),
				...(config.cwd ? { cwd: config.cwd } : {}),
			};
		} else {
			result[name] = {
				type: config.type ?? 'http',
				url: config.url,
				...(config.headers ? { headers: config.headers } : {}),
			};
		}
	}
	return result;
}
