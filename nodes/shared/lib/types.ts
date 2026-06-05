export type ProviderType =
	| 'anthropic_direct'
	| 'anthropic_gateway'
	| 'openai_compatible_gateway'
	| 'bedrock'
	| 'vertex'
	| 'foundry'
	| 'aws_platform';

/** 内置 shim 默认监听地址（与 scripts/anthropic-openai-shim.mjs 一致） */
export const DEFAULT_OPENAI_SHIM_BASE_URL = 'http://127.0.0.1:18789';

export interface ModelEntry {
	id: string;
	name: string;
	description?: string;
}

export interface ClaudeProviderCredentials {
	providerType: ProviderType;
	profileName?: string;
	apiKey?: string;
	authToken?: string;
	baseUrl?: string;
	/** OpenAI 兼容上游时，Anthropic↔OpenAI shim 的 Base URL */
	shimBaseUrl?: string;
	enableToolSearch?: boolean;
	region?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
	projectId?: string;
	credentialsJson?: string;
	endpoint?: string;
	workspaceId?: string;
	defaultModel?: string;
	customModel?: string;
}

export interface ClaudeModelConfig {
	version: 1;
	providerType: ProviderType;
	profileName: string;
	model: string;
	sdkEnv: Record<string, string>;
	profileIndex?: number;
}

export interface StoredSessionRecord {
	claudeSessionId: string;
	modelConfig: Pick<ClaudeModelConfig, 'providerType' | 'profileName' | 'model' | 'profileIndex'>;
}

export const CLAUDE_MODEL_CONFIG_FIELD = 'claudeModelConfig';

export const PROVIDER_TYPE_OPTIONS: Array<{ name: string; value: ProviderType; description?: string }> = [
	{
		name: 'Anthropic Direct',
		value: 'anthropic_direct',
		description: 'Official api.anthropic.com with ANTHROPIC_API_KEY',
	},
	{
		name: 'Anthropic Gateway (LiteLLM / compatible proxy)',
		value: 'anthropic_gateway',
		description: 'ANTHROPIC_BASE_URL + API key',
	},
	{
		name: 'OpenAI Compatible Gateway (Agnes / etc.)',
		value: 'openai_compatible_gateway',
		description:
			'Upstream OpenAI Chat Completions + local anthropic-openai-shim (no LiteLLM)',
	},
	{ name: 'Amazon Bedrock', value: 'bedrock' },
	{ name: 'Google Vertex AI', value: 'vertex' },
	{ name: 'Microsoft Foundry', value: 'foundry' },
	{ name: 'Claude Platform on AWS', value: 'aws_platform' },
];
