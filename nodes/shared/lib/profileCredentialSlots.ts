export const MAX_PROFILE_CREDENTIAL_SLOTS = 10;

/** Native n8n node credential slot (triggers model loadOptions refresh on change). */
export function buildProfileCredentialSlotName(index: number): string {
	return `claudeProviderProfile${index}`;
}

export function buildProfileCredentialSlotDisplayName(index: number): string {
	return `Profile ${index} · Claude Provider`;
}
