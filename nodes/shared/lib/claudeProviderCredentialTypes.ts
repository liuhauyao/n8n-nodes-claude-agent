/** Credential type stored in credentials_entity.type */
export const CLAUDE_PROVIDER_BASE_TYPE = 'claudeProvider';

export const CLAUDE_PROVIDER_PROFILE_TYPE_PREFIX = 'claudeProviderProfile';

export function isClaudeProviderCredentialType(type: string): boolean {
	return type === CLAUDE_PROVIDER_BASE_TYPE || type.startsWith(CLAUDE_PROVIDER_PROFILE_TYPE_PREFIX);
}

export function buildClaudeProviderTypeInClause(): { clause: string; params: string[] } {
	const slots = Array.from({ length: 10 }, (_, i) => `${CLAUDE_PROVIDER_PROFILE_TYPE_PREFIX}${i + 1}`);
	return {
		clause: `type IN (${[CLAUDE_PROVIDER_BASE_TYPE, ...slots].map(() => '?').join(', ')})`,
		params: [CLAUDE_PROVIDER_BASE_TYPE, ...slots],
	};
}
