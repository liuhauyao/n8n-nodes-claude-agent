import type { ClaudeModelConfig, StoredSessionRecord } from '../../shared/lib/types';
import { modelConfigSummary } from '../../shared/lib/resolveModelConfig';
import { buildQueryOptions, getHookRuntimeState, type BuildQueryOptionsInput } from './buildQueryOptions';
import { recordAssistantMessageForHooks } from './buildDeclarativeHooks';
import { getExpectedBuiltinTools } from './permissionPresets';
import type { ClaudeStreamAssembler } from './streamAssembler';
import { resolveSessionContinuation } from './sessionContinuation';
import { linkAbortSignal, sanitizeQueryOptionsForSdk } from './queryOptionsSanitize';
import { resolveUserTurnInput, type SdkUserMessageLike } from './userMessageImages';

export type QueryFn = (params: {
	prompt: string | AsyncIterable<SdkUserMessageLike>;
	options?: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export interface RunStatelessTurnInput extends Omit<BuildQueryOptionsInput, 'continuation'> {
	queryFn: QueryFn;
	chatInput: string;
	imageUrls?: string[];
	storedSession?: StoredSessionRecord;
	assembler: ClaudeStreamAssembler;
	abortSignal?: AbortSignal;
}

export interface RunStatelessTurnResult {
	claudeSessionId?: string;
	continuationKind: 'new' | 'resume' | 'fork';
	previousClaudeSessionId?: string;
	lastError?: string;
	refusalMessage?: string;
}

export async function runStatelessTurn(
	input: RunStatelessTurnInput,
): Promise<RunStatelessTurnResult> {
	const continuation = resolveSessionContinuation(input.modelConfig, input.storedSession);
	const queryOptions = buildQueryOptions({
		...input,
		continuation,
	});
	input.assembler.setExpectedBuiltinTools(getExpectedBuiltinTools(input.permissionPreset));
	const abortController = linkAbortSignal(input.abortSignal);
	if (abortController) {
		queryOptions.abortController = abortController;
	}

	const prompt = resolveUserTurnInput(input.chatInput, input.imageUrls ?? []);

	const hookState = getHookRuntimeState(queryOptions);

	let lastError: string | undefined;
	let refusalMessage: string | undefined;
	for await (const message of input.queryFn({
		prompt,
		options: sanitizeQueryOptionsForSdk(queryOptions),
	})) {
		// 先登记助手正文，供 Stop Hook 按「本轮」判定 proposal 标记是否已按增量交付输出
		if (hookState) recordAssistantMessageForHooks(hookState, message);
		await input.assembler.consume(message);
		const record = message as Record<string, unknown>;
		if (record.type === 'result' && record.subtype === 'error') {
			lastError = String(record.result ?? 'Claude agent run failed');
		}
		if (record.type === 'result' && record.stop_reason === 'refusal') {
			refusalMessage = String(record.result ?? 'Claude refused the request');
		}
	}

	const claudeSessionId = input.assembler.getSessionId()
		?? (continuation.kind !== 'new'
			? (continuation.kind === 'resume'
				? continuation.claudeSessionId
				: undefined)
			: undefined);

	return {
		claudeSessionId,
		continuationKind: continuation.kind,
		previousClaudeSessionId: continuation.kind === 'fork'
			? continuation.sourceClaudeSessionId
			: undefined,
		lastError,
		refusalMessage,
	};
}

export function toStoredRecord(modelConfig: ClaudeModelConfig, claudeSessionId: string): StoredSessionRecord {
	return {
		claudeSessionId,
		modelConfig: modelConfigSummary(modelConfig),
	};
}
