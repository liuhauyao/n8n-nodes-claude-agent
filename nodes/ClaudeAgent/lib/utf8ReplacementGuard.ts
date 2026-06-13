/** Unicode replacement character (U+FFFD)，常见于 UTF-8 多字节字符在流式输出中被截断 */
export const UTF8_REPLACEMENT_CHAR = '\uFFFD';

export const UTF8_REPLACEMENT_DENY_MESSAGE =
	'工具参数检测到乱码字符（U+FFFD，通常由模型流式输出截断中文导致）。'
	+ '请重新生成完整参数并重试该工具调用，确保 content、description 等文本字段不含 � 符号。';

export const UTF8_REPLACEMENT_MAX_DENY_MESSAGE =
	'多次重试后工具参数仍含乱码（U+FFFD），已停止拦截。请缩短 content 篇幅或更换模型后重试。';

const GUARDED_MCP_TOOL = /(?:create|update)(?:Definition|Event|Concept)Proposal$/i;

/** 递归检测对象/字符串中是否含 U+FFFD */
export function containsUtf8ReplacementChar(value: unknown): boolean {
	if (value == null) return false;
	if (typeof value === 'string') return value.includes(UTF8_REPLACEMENT_CHAR);
	if (Array.isArray(value)) return value.some(containsUtf8ReplacementChar);
	if (typeof value === 'object') {
		for (const nested of Object.values(value as Record<string, unknown>)) {
			if (containsUtf8ReplacementChar(nested)) return true;
		}
	}
	return false;
}

/** 是否应对该 MCP 写提案类工具做乱码校验 */
export function shouldGuardMcpToolInput(toolName: string): boolean {
	const normalized = toolName.replace(/^mcp__[^_]+__/, '');
	return GUARDED_MCP_TOOL.test(normalized);
}

export type Utf8GuardPermissionResult =
	| { behavior: 'allow' }
	| { behavior: 'deny'; message: string };

export interface Utf8GuardCanUseToolOptions {
	maxDenials?: number;
}

/**
 * 供 Claude Agent SDK `canUseTool` 使用：写提案类 MCP 工具入参含 U+FFFD 时拒绝执行，促使模型重试。
 */
export function buildUtf8GuardCanUseTool(
	options: Utf8GuardCanUseToolOptions = {},
): (
	toolName: string,
	input: Record<string, unknown>,
) => Promise<Utf8GuardPermissionResult> {
	const maxDenials = options.maxDenials ?? 8;
	let denialCount = 0;

	return async (toolName, input) => {
		if (!shouldGuardMcpToolInput(toolName)) {
			return { behavior: 'allow' };
		}
		if (!containsUtf8ReplacementChar(input)) {
			return { behavior: 'allow' };
		}
		denialCount += 1;
		if (denialCount > maxDenials) {
			return { behavior: 'deny', message: UTF8_REPLACEMENT_MAX_DENY_MESSAGE };
		}
		return { behavior: 'deny', message: UTF8_REPLACEMENT_DENY_MESSAGE };
	};
}
