import type { AgentPendingQuestion, AgentReplyPayload } from './hitlTypes';

export function formatAskQuestionReply(
	agentReply: AgentReplyPayload,
	pendingQuestion?: AgentPendingQuestion,
): string {
	const humanLines: string[] = [];
	for (const [questionId, answer] of Object.entries(agentReply.answers)) {
		const question = pendingQuestion?.questions.find((q) => q.id === questionId);
		const prompt = question?.prompt ?? questionId;
		const selectedIds = Array.isArray(answer) ? answer : [answer];
		const labels = selectedIds.map((id) => {
			const option = question?.options.find((o) => o.id === id);
			return option?.label ?? id;
		});
		humanLines.push(`${prompt}: ${labels.join(', ')}`);
	}
	const structured = {
		tool: 'AskQuestion',
		callId: agentReply.callId,
		requestId: agentReply.requestId,
		answers: agentReply.answers,
	};
	if (humanLines.length === 0) return JSON.stringify(structured);
	return `${humanLines.join('\n')}\n\n${JSON.stringify(structured)}`;
}
