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
	| { kind: 'session'; sessionId: string };

export function encodeClaudeStreamPayload(payload: ClaudeStreamPayload): string {
	return JSON.stringify({ [CLAUDE_STREAM_MARKER]: payload });
}

const HIDDEN_TOOL_NAMES = new Set([
	'AskUserQuestion',
	'TodoWrite',
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

export function embedClaudeMessageMeta(markdown: string, meta: ClaudeMessageMeta): string {
	const payload = JSON.stringify(meta);
	return `${markdown}\n<claude_meta>${payload}</claude_meta>`;
}
