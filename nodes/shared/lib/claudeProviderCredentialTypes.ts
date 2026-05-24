/** Credential type stored in credentials_entity.type */
export const CLAUDE_PROVIDER_BASE_TYPE = 'claudeProvider';

export const CLAUDE_PROVIDER_PROFILE_TYPE_PREFIX = 'claudeProviderProfile';

export function isClaudeProviderCredentialType(type: string): boolean {
	return type === CLAUDE_PROVIDER_BASE_TYPE || type.startsWith(CLAUDE_PROVIDER_PROFILE_TYPE_PREFIX);
}

export function getClaudeProviderCredentialTypes(): string[] {
	const slots = Array.from({ length: 10 }, (_, i) => `${CLAUDE_PROVIDER_PROFILE_TYPE_PREFIX}${i + 1}`);
	return [CLAUDE_PROVIDER_BASE_TYPE, ...slots];
}

export function buildClaudeProviderTypeInClause(): { clause: string; params: string[] } {
	const types = getClaudeProviderCredentialTypes();
	return {
		clause: `type IN (${types.map(() => '?').join(', ')})`,
		params: types,
	};
}

export function buildClaudeProviderTypeInClausePostgres(startIndex = 1): {
	clause: string;
	params: string[];
} {
	const types = getClaudeProviderCredentialTypes();
	return {
		clause: `type IN (${types.map((_, index) => `$${startIndex + index}`).join(', ')})`,
		params: types,
	};
}
