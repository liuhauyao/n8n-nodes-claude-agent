import { ClaudeProvider } from './ClaudeProvider.credentials';

import {
	buildProfileCredentialSlotDisplayName,
	buildProfileCredentialSlotName,
} from '../nodes/shared/lib/profileCredentialSlots';

export function createClaudeProviderProfileCredentialClass(index: number) {
	class ProfileCredential extends ClaudeProvider {
		name = buildProfileCredentialSlotName(index);

		displayName = buildProfileCredentialSlotDisplayName(index);

		/** Same fields / test as Claude Provider; slot name differs per profile. */
		extends = ['claudeProvider'];
	}
	return ProfileCredential;
}
