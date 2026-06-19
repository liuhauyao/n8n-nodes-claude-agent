/** n8n item.content JSON envelope for Claude-native stream events. */
export const CLAUDE_STREAM_MARKER = '__claude__';

export type ClaudeStreamPayload =
	| { kind: 'tool_start'; callId: string; name: string; label: string }
	| { kind: 'tool_end'; callId: string; ok?: boolean; error?: string }
	| { kind: 'thinking_start' }
	| { kind: 'thinking_chunk'; text: string }
	| { kind: 'thinking_end'; durationMs?: number }
	| { kind: 'text'; text: string }
	| { kind: 'status'; phase: string; message?: string }
	| { kind: 'session'; sessionId: string }
	| { kind: 'structured'; data: unknown }
	| { kind: 'suggestions'; items: string[] }
	| { kind: 'model_switch'; trigger?: string }
	| { kind: 'refusal'; message?: string }
	| { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number };

export function encodeClaudeStreamPayload(payload: ClaudeStreamPayload): string {
	return JSON.stringify({ [CLAUDE_STREAM_MARKER]: payload });
}

const HIDDEN_TOOL_NAMES = new Set([
	'AskUserQuestion',
	'TodoWrite',
	'TaskCreate',
	'TaskUpdate',
	'TaskGet',
	'TaskList',
]);

export function shouldShowToolInUi(rawName: string): boolean {
	if (!rawName) return false;
	const base = rawName.includes('__') ? rawName.split('__').pop() ?? rawName : rawName;
	return !HIDDEN_TOOL_NAMES.has(base) && !HIDDEN_TOOL_NAMES.has(rawName);
}

export function resolveToolLabel(name: string): string {
	if (name.startsWith('mcp__')) {
		const parts = name.split('__').filter(Boolean);
		return parts.slice(1).join(' · ') || name;
	}
	return name;
}

export interface ClaudeMessageMeta {
	timeline: Array<{ type: string; content?: string; tool?: unknown }>;
	toolCalls: Array<{ id: string; name: string; label: string; done: boolean }>;
	thinking?: string;
	thinkingDurationMs?: number;
	usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
	sessionId?: string;
	suggestions?: string[];
}

const CLAUDE_META_RE = /<claude_meta>[\s\S]*?<\/claude_meta>/i;
const NEXT_TAG_BLOCK_RE = /<next>([\s\S]*?)<\/next>/gi;
const NEXT_TAG_RE = /<\s*\/?\s*next\s*>/gi;

/** 移除落库元数据块，供 textOutput 使用 */
export function stripClaudeMessageMeta(content: string): string {
	if (!content) return '';
	return content.replace(CLAUDE_META_RE, '').trimEnd();
}

/** 移除 `<next>` 建议块，供 textOutput 使用 */
export function stripNextTags(text: string): string {
	if (!text) return '';
	let result = text.replace(NEXT_TAG_BLOCK_RE, '');
	const openIdx = result.lastIndexOf('<next>');
	if (openIdx >= 0 && !result.slice(openIdx).includes('</next>')) {
		result = result.slice(0, openIdx);
	}
	return result.replace(NEXT_TAG_RE, '').trim();
}

/** 从正文提取 `<next>` 建议项，写入 claude_meta.suggestions */
export function extractNextSuggestions(text: string): string[] {
	if (!text) return [];
	const suggestions: string[] = [];
	const re = /<next>([\s\S]*?)<\/next>/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const block = match[1].trim();
		if (!block) continue;
		const lines = block
			.split(/\r?\n/)
			.map((line) => line.replace(/^[\s\-•*]+/, '').trim())
			.filter(Boolean);
		if (lines.length > 0) suggestions.push(...lines);
		else suggestions.push(block);
	}
	return suggestions;
}

export function embedClaudeMessageMeta(markdown: string, meta: ClaudeMessageMeta): string {
	const clean = stripClaudeMessageMeta(markdown);
	const hasTools = !!meta.toolCalls?.length;
	const hasTimeline = !!meta.timeline?.length;
	const hasThinking = !!meta.thinking?.trim();
	const hasDuration = meta.thinkingDurationMs !== undefined;
	const hasUsage = !!meta.usage;
	const hasSession = !!meta.sessionId;
	const hasSuggestions = !!meta.suggestions?.length;
	if (
		!hasTools
		&& !hasTimeline
		&& !hasThinking
		&& !hasDuration
		&& !hasUsage
		&& !hasSession
		&& !hasSuggestions
	) {
		return clean;
	}

	const payload: ClaudeMessageMeta = {
		timeline: meta.timeline,
		toolCalls: meta.toolCalls,
	};
	if (hasThinking) payload.thinking = meta.thinking;
	if (hasDuration) payload.thinkingDurationMs = meta.thinkingDurationMs;
	if (hasUsage) payload.usage = meta.usage;
	if (hasSession) payload.sessionId = meta.sessionId;
	if (hasSuggestions) payload.suggestions = meta.suggestions;
	return `${clean}\n<claude_meta>${JSON.stringify(payload)}</claude_meta>`;
}
