import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	IWorkflowExecuteAdditionalData,
} from 'n8n-workflow';

import { buildSdkEnv, readProviderCredentials } from './buildSdkEnv';
import { CLAUDE_PROVIDER_BASE_TYPE } from './claudeProviderCredentialTypes';
import { findClaudeProviderCredentialById } from './listClaudeProviderCredentials';
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

function parseCredentialId(selection: CredentialsSelectValue | undefined): string | undefined {
	if (typeof selection === 'string') {
		const trimmed = selection.trim();
		return trimmed || undefined;
	}
	if (selection && typeof selection === 'object') {
		const id = selection.id ?? selection.value;
		return typeof id === 'string' && id.trim() ? id.trim() : undefined;
	}
	return undefined;
}

function getAdditionalData(ctx: CredentialContext): IWorkflowExecuteAdditionalData {
	const candidate = ctx as CredentialContext & { additionalData?: IWorkflowExecuteAdditionalData };
	if (candidate.additionalData?.credentialsHelper) {
		return candidate.additionalData;
	}
	throw new Error('Unable to access n8n credential services in this context.');
}

function hasCredentialAuth(decrypted: ICredentialDataDecryptedObject): boolean {
	const apiKey = decrypted.apiKey;
	const authToken = decrypted.authToken;
	const apiKeyText = typeof apiKey === 'string' ? apiKey.trim() : '';
	const authTokenText = typeof authToken === 'string' ? authToken.trim() : '';
	return Boolean(apiKeyText || authTokenText);
}

function readCredentialSelection(
	ctx: CredentialContext,
	credentialFieldName: string,
	itemIndex: number,
): CredentialsSelectValue | undefined {
	const loadOptionsCtx = ctx as ILoadOptionsFunctions;
	if (typeof loadOptionsCtx.getCurrentNodeParameter === 'function') {
		const current = loadOptionsCtx.getCurrentNodeParameter(credentialFieldName);
		if (current !== undefined && current !== null && current !== '') {
			return current as CredentialsSelectValue;
		}
	}

	if (credentialFieldName.includes('.')) {
		try {
			const [collectionName, nestedName] = credentialFieldName.split('.', 2);
			const collection = ctx.getNodeParameter(collectionName, itemIndex, {}) as Record<string, unknown>;
			const nested = collection[nestedName];
			if (nested !== undefined && nested !== null && nested !== '') {
				return nested as CredentialsSelectValue;
			}
		} catch {
			// fall through
		}
	}

	try {
		return ctx.getNodeParameter(credentialFieldName, itemIndex, '') as CredentialsSelectValue;
	} catch {
		return undefined;
	}
}

export function readSelectedCredentialId(
	ctx: CredentialContext,
	credentialFieldName: string,
	itemIndex = 0,
): string | undefined {
	return parseCredentialId(readCredentialSelection(ctx, credentialFieldName, itemIndex));
}

async function decryptClaudeProviderCredential(
	ctx: CredentialContext,
	credentialId: string,
): Promise<ICredentialDataDecryptedObject> {
	const credentialMeta = await findClaudeProviderCredentialById(credentialId);
	if (!credentialMeta) {
		throw new Error(`Claude Provider credential "${credentialId}" was not found.`);
	}

	const additionalData = getAdditionalData(ctx);
	const decrypted = await additionalData.credentialsHelper.getDecrypted(
		additionalData,
		{ id: credentialMeta.id, name: credentialMeta.name },
		credentialMeta.type || CLAUDE_PROVIDER_BASE_TYPE,
		'internal',
	);

	if (!hasCredentialAuth(decrypted)) {
		throw new Error(
			`Credential "${credentialMeta.name}" has no API Key. Open the credential, save a valid key, then re-select Profile Credential.`,
		);
	}

	return decrypted;
}

export async function loadClaudeProviderCredentialsById(
	ctx: CredentialContext,
	credentialId: string,
): Promise<ICredentialDataDecryptedObject> {
	return await decryptClaudeProviderCredential(ctx, credentialId);
}

export async function loadClaudeProviderCredentials(
	ctx: CredentialContext,
	credentialFieldName?: string,
	itemIndex = 0,
): Promise<ICredentialDataDecryptedObject> {
	if (credentialFieldName) {
		const credentialId = readSelectedCredentialId(ctx, credentialFieldName, itemIndex);
		if (credentialId) {
			return await decryptClaudeProviderCredential(ctx, credentialId);
		}
		throw new Error(
			`Claude Provider credential is not configured for "${credentialFieldName}". Select a credential first.`,
		);
	}
	try {
		return await ctx.getCredentials('claudeProvider', itemIndex);
	} catch {
		throw new Error(
			'Claude Provider credential is not configured. Select a credential on Profile Credential.',
		);
	}
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
