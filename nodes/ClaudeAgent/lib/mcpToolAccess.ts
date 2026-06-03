import type { McpServerConfig } from './parseMcpServers';

export type McpToolFilterMode = 'none' | 'deny' | 'allow';

export interface McpToolAccessConfig {
	filterMode: McpToolFilterMode;
	deniedToolsRaw: string;
	allowedToolsRaw: string;
	/** Allow 模式可选：服务端全部工具名清单，用于计算「catalog − allowed」并 deny 其余项 */
	allowComplementCatalogRaw: string;
}

export function parseToolNameList(raw: string): string[] {
	return raw
		.split(/[\n,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function listMcpServerNames(
	mcpServers: Record<string, McpServerConfig>,
): string[] {
	return Object.keys(mcpServers).map((k) => k.trim()).filter(Boolean);
}

export function resolveDeniedMcpToolNames(config: McpToolAccessConfig): string[] {
	if (config.filterMode === 'none') return [];

	if (config.filterMode === 'deny') {
		return parseToolNameList(config.deniedToolsRaw);
	}

	const allowed = parseToolNameList(config.allowedToolsRaw);
	if (allowed.length === 0) return [];

	const catalog = parseToolNameList(config.allowComplementCatalogRaw);
	if (catalog.length === 0) return [];

	const allowedSet = new Set(allowed);
	return catalog.filter((name) => !allowedSet.has(name));
}

export function resolveAllowedMcpToolNames(config: McpToolAccessConfig): string[] {
	if (config.filterMode !== 'allow') return [];
	return parseToolNameList(config.allowedToolsRaw);
}

/** Claude Agent SDK：mcp__{server}__{tool} */
export function buildClaudeMcpDisallowedTools(
	serverNames: string[],
	toolNames: string[],
): string[] {
	const out: string[] = [];
	for (const server of serverNames) {
		for (const tool of toolNames) {
			out.push(`mcp__${server}__${tool}`);
		}
	}
	return out;
}

export function buildClaudeMcpAllowedTools(
	serverNames: string[],
	toolNames: string[],
): string[] {
	const out: string[] = [];
	for (const server of serverNames) {
		for (const tool of toolNames) {
			out.push(`mcp__${server}__${tool}`);
		}
	}
	return out;
}

/** Claude SDK：按 MCP 服务器预批准全部工具（与 Cursor `Mcp(server:*)` 对齐） */
export function buildClaudeMcpServerWildcards(serverNames: string[]): string[] {
	return serverNames.map((server) => `mcp__${server}__*`);
}

/**
 * `permissionMode: dontAsk` 时，未列入 allowedTools 的 MCP 会被免询问拒绝。
 * - filterMode `deny` / `none`：为每个已配置 server 添加 `mcp__{server}__*`，deny 列表仍写入 disallowedTools
 * - filterMode `allow`：仅使用显式 allowed 列表，不加通配符（避免绕过 Allow List）
 */
export function resolveClaudeMcpPreApprovedTools(
	needsMcpPreApproval: boolean,
	serverNames: string[],
	access: McpToolAccessConfig,
	explicitAllowed: string[],
): string[] {
	if (!needsMcpPreApproval || serverNames.length === 0) {
		return explicitAllowed;
	}
	if (access.filterMode === 'allow') {
		return explicitAllowed;
	}
	return [...new Set([...buildClaudeMcpServerWildcards(serverNames), ...explicitAllowed])];
}

/** Cursor CLI：Mcp(server:tool) */
export function buildCursorMcpDenyTokens(
	serverNames: string[],
	toolNames: string[],
): string[] {
	const out: string[] = [];
	for (const server of serverNames) {
		for (const tool of toolNames) {
			out.push(`Mcp(${server}:${tool})`);
		}
	}
	return out;
}

export function buildCursorMcpAllowTokens(
	serverNames: string[],
	toolNames: string[],
): string[] {
	const out: string[] = [];
	for (const server of serverNames) {
		for (const tool of toolNames) {
			out.push(`Mcp(${server}:${tool})`);
		}
	}
	return out;
}
