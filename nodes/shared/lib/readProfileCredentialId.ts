import type { IExecuteFunctions, ILoadOptionsFunctions } from 'n8n-workflow';

import {
	buildProfileCollectionCredentialPath,
	buildProfileCollectionFieldName,
	buildProfileCredentialFieldName,
	PROFILE_CREDENTIAL_LOAD_OPTIONS_PATH,
} from './evaluateRules';
import { readSelectedCredentialId } from './resolveModelConfig';

type CredentialContext = IExecuteFunctions | ILoadOptionsFunctions;

export type ProfileCredentialRef = {
	credentialId: string;
	fieldPath: string;
};

function readFromCollection(
	ctx: CredentialContext,
	profileIndex: number,
	itemIndex: number,
): ProfileCredentialRef | undefined {
	const collectionName = buildProfileCollectionFieldName(profileIndex);
	try {
		const collection = ctx.getNodeParameter(collectionName, itemIndex, {}) as {
			credential?: string;
		};
		const credentialId = readSelectedCredentialId(
			ctx,
			buildProfileCollectionCredentialPath(profileIndex),
			itemIndex,
		) ?? (typeof collection.credential === 'string' ? collection.credential.trim() : undefined);
		if (credentialId) {
			return {
				credentialId,
				fieldPath: buildProfileCollectionCredentialPath(profileIndex),
			};
		}
	} catch {
		// collection not present (legacy workflow)
	}
	return undefined;
}

function readFromLegacyFlat(
	ctx: CredentialContext,
	profileIndex: number,
	itemIndex: number,
): ProfileCredentialRef | undefined {
	const fieldPath = buildProfileCredentialFieldName(profileIndex);
	const credentialId = readSelectedCredentialId(ctx, fieldPath, itemIndex);
	if (!credentialId) return undefined;
	return { credentialId, fieldPath };
}

/**
 * Resolve the selected Claude Provider credential for a profile.
 * Prefers collection fields (profileN.credential), then legacy flat profileNCredential.
 */
export function readProfileCredentialRef(
	ctx: CredentialContext,
	profileIndex: number,
	itemIndex = 0,
): ProfileCredentialRef | undefined {
	const loadOptionsCtx = ctx as ILoadOptionsFunctions;
	if (typeof loadOptionsCtx.getCurrentNodeParameter === 'function') {
		const relativeId = readSelectedCredentialId(
			ctx,
			PROFILE_CREDENTIAL_LOAD_OPTIONS_PATH,
			itemIndex,
		);
		if (relativeId) {
			return {
				credentialId: relativeId,
				fieldPath: buildProfileCollectionCredentialPath(profileIndex),
			};
		}
	}

	return readFromCollection(ctx, profileIndex, itemIndex) ?? readFromLegacyFlat(ctx, profileIndex, itemIndex);
}
