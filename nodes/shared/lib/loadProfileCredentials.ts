import type { ICredentialDataDecryptedObject, IDataObject } from 'n8n-workflow';
import type { IExecuteFunctions, ILoadOptionsFunctions } from 'n8n-workflow';

import {
	buildProfileCredentialSlotDisplayName,
	buildProfileCredentialSlotName,
} from './profileCredentialSlots';
import { readProfileCredentialRef } from './readProfileCredentialId';
import { loadClaudeProviderCredentialsById } from './resolveModelConfig';

type CredentialContext = IExecuteFunctions | ILoadOptionsFunctions;

/**
 * Load decrypted Claude Provider data for a profile.
 * Prefers collection / legacy parameter credential id; falls back to native node credential slot.
 */
export async function loadProfileProviderCredentials(
	ctx: CredentialContext,
	profileIndex: number,
	itemIndex = 0,
): Promise<ICredentialDataDecryptedObject> {
	const legacyRef = readProfileCredentialRef(ctx, profileIndex, itemIndex);
	if (legacyRef) {
		return await loadClaudeProviderCredentialsById(ctx, legacyRef.credentialId);
	}

	const slotName = buildProfileCredentialSlotName(profileIndex);
	try {
		return await ctx.getCredentials(slotName, itemIndex);
	} catch {
		throw new Error(
			`Profile ${profileIndex} Claude Provider credential is not configured. `
				+ `Expand Profile ${profileIndex} and select a Claude Provider credential.`,
		);
	}
}

export async function tryLoadProfileProviderCredentials(
	ctx: CredentialContext,
	profileIndex: number,
	itemIndex = 0,
): Promise<ICredentialDataDecryptedObject | undefined> {
	try {
		return await loadProfileProviderCredentials(ctx, profileIndex, itemIndex);
	} catch {
		return undefined;
	}
}

export function asCredentialDataObject(
	raw: ICredentialDataDecryptedObject,
): IDataObject {
	return raw as IDataObject;
}

export function buildMissingCredentialMessage(profileIndex: number): string {
	return `Select ${buildProfileCredentialSlotDisplayName(profileIndex)} credential first.`;
}
