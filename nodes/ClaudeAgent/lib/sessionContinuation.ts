import type { ClaudeModelConfig, StoredSessionRecord } from '../../shared/lib/types';

export type SessionContinuation =
	| { kind: 'new' }
	| { kind: 'resume'; claudeSessionId: string }
	| { kind: 'fork'; sourceClaudeSessionId: string };

export type ModelConfigIdentity = Pick<
	ClaudeModelConfig,
	'model' | 'providerType' | 'profileIndex'
>;

/** 同 Profile 仅 model 字符串变化（Sidecar 可用 setModel，无需 fork） */
export function isSameProfile(
	a: ModelConfigIdentity,
	b: ModelConfigIdentity,
): boolean {
	return a.providerType === b.providerType && a.profileIndex === b.profileIndex;
}

export function sameModelConfig(
	a: ModelConfigIdentity,
	b: ModelConfigIdentity,
): boolean {
	return (
		a.model === b.model
		&& a.providerType === b.providerType
		&& a.profileIndex === b.profileIndex
	);
}

export function resolveSessionContinuation(
	current: ClaudeModelConfig,
	stored: StoredSessionRecord | undefined,
): SessionContinuation {
	if (!stored?.claudeSessionId) return { kind: 'new' };
	if (!stored.modelConfig?.model) {
		return { kind: 'resume', claudeSessionId: stored.claudeSessionId };
	}
	if (sameModelConfig(current, stored.modelConfig)) {
		return { kind: 'resume', claudeSessionId: stored.claudeSessionId };
	}
	return { kind: 'fork', sourceClaudeSessionId: stored.claudeSessionId };
}
