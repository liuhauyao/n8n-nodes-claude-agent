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
	| { kind: 'ask_question'; callId: string; title?: string; questions: unknown[] }
	| { kind: 'awaiting_input'; requestId: string }
	| { kind: 'todo_update'; items: Array<{ id: string; content: string; status: string }> }
	| {
			kind: 'hitl_checkpoint';
			executionId: string;
			resumeUrl: string;
			pendingQuestion: {
				callId: string;
				title?: string;
				requestId: string;
				questions: Array<{
					id: string;
					prompt: string;
					options: Array<{ id: string; label: string }>;
					allowMultiple?: boolean;
				}>;
			};
			segmentIndex: number;
			requestId: string;
			callId: string;
	  };

export interface AgentMetaTodoItem {
	id: string;
	content: string;
	status: string;
}

export interface AgentMetaPendingQuestion {
	callId: string;
	title?: string;
	requestId: string;
	questions: Array<{
		id: string;
		prompt: string;
		options: Array<{ id: string; label: string }>;
		allowMultiple?: boolean;
	}>;
}

export function encodeClaudeStreamPayload(payload: ClaudeStreamPayload): string {
	return JSON.stringify({ [CLAUDE_STREAM_MARKER]: payload });
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
	todos?: AgentMetaTodoItem[];
	pendingQuestion?: AgentMetaPendingQuestion | null;
}

export function embedClaudeMessageMeta(markdown: string, meta: ClaudeMessageMeta): string {
	const payload = JSON.stringify(meta);
	return `${markdown}\n<claude_meta>${payload}</claude_meta>`;
}
