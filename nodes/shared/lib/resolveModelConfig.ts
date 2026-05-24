import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';

import { buildSdkEnv, readProviderCredentials } from './buildSdkEnv';
import type { ClaudeModelConfig } from './types';
import { CLAUDE_MODEL_CONFIG_FIELD } from './types';

type CredentialContext = IExecuteFunctions | ILoadOptionsFunctions;

type CredentialsSelectValue =
	| string
	| {
			id?: string;
			name?: string;
			value?: string;
	  };

export async function loadClaudeProviderCredentials(
	ctx: CredentialContext,
	credentialFieldName?: string,
	itemIndex = 0,
): Promise<ICredentialDataDecryptedObject> {
	if (credentialFieldName) {
		const selection = ctx.getNodeParameter(credentialFieldName, itemIndex, '') as CredentialsSelectValue;
		const credentialId =
			typeof selection === 'object' && selection !== null
				? selection.id ?? selection.value
				: undefined;
		if (credentialId) {
			const helpers = (ctx as unknown as { helpers?: { httpRequest?: unknown; request?: unknown } }).helpers;
			const getDecrypted = (helpers as { getDecryptedCredentials?: (id: string, type: string) => Promise<ICredentialDataDecryptedObject> })
				?.getDecryptedCredentials;
			if (typeof getDecrypted === 'function') {
				return getDecrypted.call(helpers, credentialId, 'claudeProvider');
			}
		}
	}
	return ctx.getCredentials('claudeProvider', itemIndex);
}

export async function buildModelConfigFromCredentials(
	ctx: CredentialContext,
	options: {
		credentialFieldName?: string;
		modelOverride?: string;
		itemIndex?: number;
		profileIndex?: number;
	},
): Promise<ClaudeModelConfig> {
	const raw = await loadClaudeProviderCredentials(
		ctx,
		options.credentialFieldName,
		options.itemIndex ?? 0,
	);
	const config = buildSdkEnv(readProviderCredentials(raw as IDataObject), options.modelOverride);
	if (options.profileIndex !== undefined) {
		config.profileIndex = options.profileIndex;
	}
	return config;
}

export async function resolveModelConfigForAgent(
	ctx: IExecuteFunctions,
	itemIndex: number,
	itemJson: IDataObject,
	options: {
		modelConfigSource: 'fromSelector' | 'fromCredential' | 'fromInput';
		outputFieldName?: string;
		credentialFieldName?: string;
		modelOverride?: string;
		providerMapJson?: string;
	},
): Promise<ClaudeModelConfig> {
	const outputField = options.outputFieldName?.trim() || CLAUDE_MODEL_CONFIG_FIELD;

	if (options.modelConfigSource === 'fromSelector') {
		const fromItem = itemJson[outputField];
		if (fromItem && typeof fromItem === 'object' && !Array.isArray(fromItem)) {
			const config = fromItem as ClaudeModelConfig;
			if (config.version === 1 && config.sdkEnv && config.model) {
				return config;
			}
		}
		throw new Error(
			`Missing or invalid ${outputField} on input item. Connect Claude Model Selector upstream or change Model Config Source.`,
		);
	}

	if (options.modelConfigSource === 'fromCredential') {
		return buildModelConfigFromCredentials(ctx, {
			modelOverride: options.modelOverride,
			itemIndex,
		});
	}

	const modelFromInput =
		(typeof itemJson.inferenceModel === 'string' && itemJson.inferenceModel)
		|| (typeof itemJson.model === 'string' && itemJson.model)
		|| options.modelOverride;
	const providerFromInput =
		(typeof itemJson.inferenceModelProvider === 'string' && itemJson.inferenceModelProvider)
		|| (typeof itemJson.modelProvider === 'string' && itemJson.modelProvider)
		|| '';

	const providerMap = parseProviderMap(options.providerMapJson);
	const mappedCredentialField = providerMap[providerFromInput.toLowerCase()];
	if (mappedCredentialField) {
		return buildModelConfigFromCredentials(ctx, {
			credentialFieldName: mappedCredentialField,
			modelOverride: modelFromInput || undefined,
			itemIndex,
		});
	}

	return buildModelConfigFromCredentials(ctx, {
		modelOverride: modelFromInput || undefined,
		itemIndex,
	});
}

function parseProviderMap(raw?: string): Record<string, string> {
	const trimmed = raw?.trim();
	if (!trimmed) return {};
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Provider map must be a JSON object');
		}
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value === undefined || value === null) continue;
			result[key.toLowerCase()] = String(value);
		}
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Provider Map JSON is invalid: ${message}`);
	}
}

export function modelConfigSummary(config: ClaudeModelConfig): Pick<
	ClaudeModelConfig,
	'providerType' | 'profileName' | 'model' | 'profileIndex'
> {
	return {
		providerType: config.providerType,
		profileName: config.profileName,
		model: config.model,
		profileIndex: config.profileIndex,
	};
}
