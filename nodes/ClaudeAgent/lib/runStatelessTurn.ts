import type { ClaudeModelConfig, StoredSessionRecord } from '../../shared/lib/types';
import { modelConfigSummary } from '../../shared/lib/resolveModelConfig';
import { buildQueryOptions, type BuildQueryOptionsInput } from './buildQueryOptions';
import type { ClaudeStreamAssembler } from './streamAssembler';
import { resolveSessionContinuation } from './sessionContinuation';
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
}

export interface RunStatelessTurnResult {
	claudeSessionId?: string;
	continuationKind: 'new' | 'resume' | 'fork';
	previousClaudeSessionId?: string;
	lastError?: string;
}

export async function runStatelessTurn(
	input: RunStatelessTurnInput,
): Promise<RunStatelessTurnResult> {
	const continuation = resolveSessionContinuation(input.modelConfig, input.storedSession);
	const queryOptions = buildQueryOptions({
		...input,
		continuation,
	});

	const prompt = resolveUserTurnInput(input.chatInput, input.imageUrls ?? []);

	let lastError: string | undefined;
	for await (const message of input.queryFn({
		prompt,
		options: queryOptions,
	})) {
		await input.assembler.consume(message);
		const record = message as Record<string, unknown>;
		if (record.type === 'result' && record.subtype === 'error') {
			lastError = String(record.result ?? 'Claude agent run failed');
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
	};
}

export function toStoredRecord(modelConfig: ClaudeModelConfig, claudeSessionId: string): StoredSessionRecord {
	return {
		claudeSessionId,
		modelConfig: modelConfigSummary(modelConfig),
	};
}
