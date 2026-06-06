import type { ClaudeProviderCredentials, ClaudeModelConfig } from './types';
import { DEFAULT_OPENAI_SHIM_BASE_URL } from './types';
import { resolveModelId } from './modelCatalog';

function setEnv(target: Record<string, string>, key: string, value: string | undefined): void {
	const trimmed = value?.trim();
	if (trimmed) {
		target[key] = trimmed;
	}
}

export function buildSdkEnv(
	credentials: ClaudeProviderCredentials,
	modelOverride?: string,
): ClaudeModelConfig {
	const model = resolveModelId(credentials, modelOverride);
	const profileName = credentials.profileName?.trim() || credentials.providerType;
	const sdkEnv: Record<string, string> = {};

	switch (credentials.providerType) {
		case 'anthropic_direct':
			setEnv(sdkEnv, 'ANTHROPIC_API_KEY', credentials.apiKey);
			setEnv(sdkEnv, 'ANTHROPIC_AUTH_TOKEN', credentials.authToken);
			setEnv(sdkEnv, 'ANTHROPIC_MODEL', model);
			break;
		case 'anthropic_gateway':
			setEnv(sdkEnv, 'ANTHROPIC_API_KEY', credentials.apiKey);
			setEnv(sdkEnv, 'ANTHROPIC_AUTH_TOKEN', credentials.authToken);
			setEnv(sdkEnv, 'ANTHROPIC_BASE_URL', credentials.baseUrl);
			setEnv(sdkEnv, 'ANTHROPIC_MODEL', model);
			if (credentials.enableToolSearch) {
				sdkEnv.ENABLE_TOOL_SEARCH = 'true';
			}
			break;
		case 'openai_compatible_gateway': {
			const upstream = credentials.baseUrl?.trim();
			const upstreamKey = credentials.authToken?.trim() || credentials.apiKey?.trim();
			if (!upstream) {
				throw new Error('Upstream Base URL is required for OpenAI compatible gateway');
			}
			if (!upstreamKey) {
				throw new Error('API Key or Auth Token is required for OpenAI compatible upstream');
			}
			const shimBase = credentials.shimBaseUrl?.trim() || DEFAULT_OPENAI_SHIM_BASE_URL;
			const upstreamAuth = upstreamKey.startsWith('Bearer ') ? upstreamKey : `Bearer ${upstreamKey}`;
			setEnv(sdkEnv, 'ANTHROPIC_BASE_URL', shimBase);
			setEnv(sdkEnv, 'ANTHROPIC_AUTH_TOKEN', 'shim-local');
			setEnv(sdkEnv, 'ANTHROPIC_MODEL', model);
			// Claude SDK expects "Name: Value" lines, not JSON (see ANTHROPIC_CUSTOM_HEADERS env docs)
			setEnv(
				sdkEnv,
				'ANTHROPIC_CUSTOM_HEADERS',
				[
					`X-Claude-Agent-Upstream-Url: ${upstream.replace(/\/+$/, '')}`,
					`X-Claude-Agent-Upstream-Authorization: ${upstreamAuth}`,
				].join('\n'),
			);
			break;
		}
		case 'bedrock':
			sdkEnv.CLAUDE_CODE_USE_BEDROCK = '1';
			setEnv(sdkEnv, 'AWS_REGION', credentials.region);
			setEnv(sdkEnv, 'AWS_ACCESS_KEY_ID', credentials.accessKeyId);
			setEnv(sdkEnv, 'AWS_SECRET_ACCESS_KEY', credentials.secretAccessKey);
			setEnv(sdkEnv, 'AWS_SESSION_TOKEN', credentials.sessionToken);
			setEnv(sdkEnv, 'ANTHROPIC_MODEL', model);
			break;
		case 'vertex':
			sdkEnv.CLAUDE_CODE_USE_VERTEX = '1';
			setEnv(sdkEnv, 'ANTHROPIC_VERTEX_PROJECT_ID', credentials.projectId);
			setEnv(sdkEnv, 'CLOUD_ML_REGION', credentials.region);
			if (credentials.credentialsJson?.trim()) {
				sdkEnv.GOOGLE_APPLICATION_CREDENTIALS_JSON = credentials.credentialsJson.trim();
			}
			setEnv(sdkEnv, 'ANTHROPIC_MODEL', model);
			break;
		case 'foundry':
			sdkEnv.CLAUDE_CODE_USE_FOUNDRY = '1';
			setEnv(sdkEnv, 'ANTHROPIC_FOUNDRY_ENDPOINT', credentials.endpoint);
			setEnv(sdkEnv, 'ANTHROPIC_API_KEY', credentials.apiKey);
			setEnv(sdkEnv, 'ANTHROPIC_MODEL', model);
			break;
		case 'aws_platform':
			sdkEnv.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1';
			setEnv(sdkEnv, 'ANTHROPIC_AWS_WORKSPACE_ID', credentials.workspaceId);
			setEnv(sdkEnv, 'ANTHROPIC_AWS_API_KEY', credentials.apiKey);
			setEnv(sdkEnv, 'AWS_REGION', credentials.region);
			setEnv(sdkEnv, 'ANTHROPIC_MODEL', model);
			break;
		default:
			throw new Error(`Unsupported provider type: ${credentials.providerType as string}`);
	}

	if (!sdkEnv.ANTHROPIC_MODEL) {
		sdkEnv.ANTHROPIC_MODEL = model;
	}

	return {
		version: 1,
		providerType: credentials.providerType,
		profileName,
		model,
		sdkEnv,
	};
}

export function mergeSdkEnvWithProcess(
	sdkEnv: Record<string, string>,
): Record<string, string | undefined> {
	return {
		...process.env,
		...sdkEnv,
		CLAUDE_AGENT_SDK_CLIENT_APP: sdkEnv.CLAUDE_AGENT_SDK_CLIENT_APP ?? 'n8n-nodes-claude-sdk-agent',
	};
}

export function readProviderCredentials(raw: Record<string, unknown>): ClaudeProviderCredentials {
	const providerType = String(raw.providerType ?? 'anthropic_direct') as ClaudeProviderCredentials['providerType'];
	return {
		providerType,
		profileName: raw.profileName ? String(raw.profileName) : undefined,
		apiKey: raw.apiKey ? String(raw.apiKey) : undefined,
		authToken: raw.authToken ? String(raw.authToken) : undefined,
		baseUrl: raw.baseUrl ? String(raw.baseUrl) : undefined,
		shimBaseUrl: raw.shimBaseUrl ? String(raw.shimBaseUrl) : undefined,
		enableToolSearch: Boolean(raw.enableToolSearch),
		region: raw.region ? String(raw.region) : undefined,
		accessKeyId: raw.accessKeyId ? String(raw.accessKeyId) : undefined,
		secretAccessKey: raw.secretAccessKey ? String(raw.secretAccessKey) : undefined,
		sessionToken: raw.sessionToken ? String(raw.sessionToken) : undefined,
		projectId: raw.projectId ? String(raw.projectId) : undefined,
		credentialsJson: raw.credentialsJson ? String(raw.credentialsJson) : undefined,
		endpoint: raw.endpoint ? String(raw.endpoint) : undefined,
		workspaceId: raw.workspaceId ? String(raw.workspaceId) : undefined,
		defaultModel: raw.defaultModel ? String(raw.defaultModel) : undefined,
		customModel: raw.customModel ? String(raw.customModel) : undefined,
	};
}
