import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IDataObject,
	INodeCredentialTestResult,
} from 'n8n-workflow';

import { readProviderCredentials } from './buildSdkEnv';
import { listModels } from './modelCatalog';
import type { ProviderType } from './types';

const DIRECT_AND_GATEWAY: ProviderType[] = ['anthropic_direct', 'anthropic_gateway'];

export async function claudeProviderCredentialTest(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
): Promise<INodeCredentialTestResult> {
	const parsed = readProviderCredentials((credential.data ?? {}) as IDataObject);
	if (DIRECT_AND_GATEWAY.includes(parsed.providerType)) {
		if (!parsed.apiKey?.trim() && !parsed.authToken?.trim()) {
			return {
				status: 'Error',
				message: 'API Key or Auth Token is required for Anthropic direct/gateway providers',
			};
		}
		if (parsed.providerType === 'anthropic_gateway' && !parsed.baseUrl?.trim()) {
			return {
				status: 'Error',
				message: 'Base URL is required for Anthropic gateway provider',
			};
		}
		try {
			const models = await listModels(parsed.providerType, parsed);
			return {
				status: 'OK',
				message: `Connected. ${models.length} model(s) available.`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				status: 'Error',
				message: `Connection failed: ${message}`,
			};
		}
	}
	if (!parsed.defaultModel?.trim() && !parsed.customModel?.trim()) {
		return {
			status: 'Error',
			message: 'Default Model or Custom Model ID is required for this provider type',
		};
	}
	return {
		status: 'OK',
		message: `Provider profile "${parsed.profileName || parsed.providerType}" configured.`,
	};
}
