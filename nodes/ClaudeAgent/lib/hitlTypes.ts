import type { AskQuestionItem } from './askTodoProtocol';

export type AgentRunMode = 'new_turn' | 'continue_hitl';
export type AgentStatus = 'finished' | 'awaiting_input' | 'error';

export interface AgentQuestionOption {
	id: string;
	label: string;
}

export interface AgentQuestionItem {
	id: string;
	prompt: string;
	options: AgentQuestionOption[];
	allowMultiple?: boolean;
}

export interface AgentPendingQuestion {
	callId: string;
	title?: string;
	requestId: string;
	questions: AgentQuestionItem[];
}

export interface AgentReplyPayload {
	requestId: string;
	callId: string;
	answers: Record<string, string | string[]>;
}

export interface AgentHitlPendingRecord {
	provider: 'cursor' | 'claude';
	agentId: string;
	runId: string;
	requestId: string;
	callId: string;
	pendingQuestion: AgentPendingQuestion;
	executionId: string;
	segmentIndex: number;
	createdAt: number;
}

export function toAgentPendingQuestion(
	callId: string,
	requestId: string,
	title: string | undefined,
	questions: AskQuestionItem[],
): AgentPendingQuestion {
	return {
		callId,
		title,
		requestId,
		questions: questions.map((q) => ({
			id: q.id,
			prompt: q.prompt,
			options: q.options.map((o) => ({ id: o.id, label: o.label })),
			allowMultiple: q.allowMultiple,
		})),
	};
}

export function parseAgentReply(raw: unknown): AgentReplyPayload | null {
	if (!raw) return null;
	let record: Record<string, unknown>;
	if (typeof raw === 'string') {
		try {
			record = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return null;
		}
	} else if (typeof raw === 'object' && !Array.isArray(raw)) {
		record = raw as Record<string, unknown>;
	} else {
		return null;
	}
	const nested = record.agentReply;
	if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
		record = nested as Record<string, unknown>;
	}
	const requestId = typeof record.requestId === 'string' ? record.requestId : '';
	const callId = typeof record.callId === 'string' ? record.callId : '';
	const answersRaw = record.answers;
	if (!requestId || !callId || !answersRaw || typeof answersRaw !== 'object' || Array.isArray(answersRaw)) {
		return null;
	}
	return {
		requestId,
		callId,
		answers: answersRaw as Record<string, string | string[]>,
	};
}
