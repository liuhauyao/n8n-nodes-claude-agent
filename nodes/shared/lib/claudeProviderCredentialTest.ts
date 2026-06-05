import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IDataObject,
	INodeCredentialTestResult,
} from 'n8n-workflow';

import { readProviderCredentials } from './buildSdkEnv';
import {
	listModels,
	verifyAnthropicGatewayConnection,
	verifyOpenAiCompatibleShimConnection,
} from './modelCatalog';
import type { ProviderType } from './types';

const DIRECT_AND_GATEWAY: ProviderType[] = ['anthropic_direct', 'anthropic_gateway'];

function validateApiKeyShape(apiKey: string): string | undefined {
	const trimmed = apiKey.trim();
	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		return 'API Key field contains a URL. Paste your provider API key (e.g. sk-...), not the Base URL.';
	}
	if (trimmed.length > 0 && trimmed.length < 20) {
		return 'API Key looks too short. Paste the full key from your provider console.';
	}
	return undefined;
}

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
		if (parsed.apiKey?.trim()) {
			const shapeError = validateApiKeyShape(parsed.apiKey);
			if (shapeError) {
				return { status: 'Error', message: shapeError };
			}
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
				message: `Connected. ${models.length} model(s) from GET /v1/models.`,
			};
		} catch (listError) {
			if (parsed.providerType === 'anthropic_gateway') {
				try {
					await verifyAnthropicGatewayConnection(parsed);
					const hint =
						parsed.customModel?.trim() || parsed.defaultModel?.trim()
							? ''
							: ' Gateway has no /v1/models — set Custom Model ID for the model picker.';
					return {
						status: 'OK',
						message: `Connected via POST /v1/messages.${hint}`,
					};
				} catch (verifyError) {
					const listMessage = listError instanceof Error ? listError.message : String(listError);
					const verifyMessage =
						verifyError instanceof Error ? verifyError.message : String(verifyError);
					return {
						status: 'Error',
						message:
							`${verifyMessage} (Models API: ${listMessage})`,
					};
				}
			}
			const message = listError instanceof Error ? listError.message : String(listError);
			return {
				status: 'Error',
				message: `Could not load models: ${message}`,
			};
		}
	}
	if (parsed.providerType === 'openai_compatible_gateway') {
		if (!parsed.apiKey?.trim() && !parsed.authToken?.trim()) {
			return {
				status: 'Error',
				message: 'API Key or Auth Token is required for OpenAI compatible upstream',
			};
		}
		if (!parsed.baseUrl?.trim()) {
			return {
				status: 'Error',
				message: 'Upstream Base URL is required (e.g. https://apihub.agnes-ai.com/v1)',
			};
		}
		const keyForShape = parsed.apiKey?.trim() || parsed.authToken?.trim() || '';
		const shapeError = validateApiKeyShape(keyForShape);
		if (shapeError) {
			return { status: 'Error', message: shapeError };
		}

		try {
			const models = await listModels(parsed.providerType, parsed);
			await verifyOpenAiCompatibleShimConnection(parsed);
			return {
				status: 'OK',
				message: `Connected. ${models.length} upstream model(s); shim inference OK.`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { status: 'Error', message };
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
