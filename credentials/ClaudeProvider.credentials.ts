import type {
	ICredentialDataDecryptedObject,
	ICredentialType,
	IDataObject,
	ILoadOptionsFunctions,
	INodeProperties,
} from 'n8n-workflow';

import { listModels, modelsToOptions } from '../nodes/shared/lib/modelCatalog';
import { readProviderCredentials } from '../nodes/shared/lib/buildSdkEnv';
import { PROVIDER_TYPE_OPTIONS } from '../nodes/shared/lib/types';

const DIRECT_AND_GATEWAY: Array<(typeof PROVIDER_TYPE_OPTIONS)[number]['value']> = [
	'anthropic_direct',
	'anthropic_gateway',
];

function providerFields(): INodeProperties[] {
	return [
		{
			displayName: 'Profile Name',
			name: 'profileName',
			type: 'string',
			default: '',
			description: 'Display label for this provider profile in Model Selector output',
		},
		{
			displayName: 'Provider Type',
			name: 'providerType',
			type: 'options',
			options: PROVIDER_TYPE_OPTIONS,
			default: 'anthropic_direct',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				show: {
					providerType: ['anthropic_direct', 'anthropic_gateway', 'foundry', 'aws_platform'],
				},
			},
		},
		{
			displayName: 'Auth Token',
			name: 'authToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Optional Authorization bearer token (ANTHROPIC_AUTH_TOKEN)',
			displayOptions: {
				show: {
					providerType: ['anthropic_direct', 'anthropic_gateway'],
				},
			},
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://your-litellm.example.com or https://api.deepseek.com/anthropic',
			description:
				'ANTHROPIC_BASE_URL for Claude Code SDK. Model list uses GET {baseUrl}/v1/models per Anthropic LLM gateway docs.',
			displayOptions: {
				show: {
					providerType: ['anthropic_gateway'],
				},
			},
		},
		{
			displayName: 'Enable Tool Search on Gateway',
			name: 'enableToolSearch',
			type: 'boolean',
			default: false,
			description: 'Set ENABLE_TOOL_SEARCH=true when your proxy forwards tool_reference blocks',
			displayOptions: {
				show: {
					providerType: ['anthropic_gateway'],
				},
			},
		},
		{
			displayName: 'AWS Region',
			name: 'region',
			type: 'string',
			default: 'us-east-1',
			displayOptions: {
				show: {
					providerType: ['bedrock', 'aws_platform'],
				},
			},
		},
		{
			displayName: 'AWS Access Key ID',
			name: 'accessKeyId',
			type: 'string',
			default: '',
			displayOptions: {
				show: {
					providerType: ['bedrock'],
				},
			},
		},
		{
			displayName: 'AWS Secret Access Key',
			name: 'secretAccessKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				show: {
					providerType: ['bedrock'],
				},
			},
		},
		{
			displayName: 'AWS Session Token',
			name: 'sessionToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				show: {
					providerType: ['bedrock'],
				},
			},
		},
		{
			displayName: 'Google Cloud Project ID',
			name: 'projectId',
			type: 'string',
			default: '',
			displayOptions: {
				show: {
					providerType: ['vertex'],
				},
			},
		},
		{
			displayName: 'Vertex Region',
			name: 'region',
			type: 'string',
			default: 'us-east5',
			displayOptions: {
				show: {
					providerType: ['vertex'],
				},
			},
		},
		{
			displayName: 'Service Account JSON',
			name: 'credentialsJson',
			type: 'string',
			typeOptions: { password: true, rows: 4 },
			default: '',
			displayOptions: {
				show: {
					providerType: ['vertex'],
				},
			},
		},
		{
			displayName: 'Foundry Endpoint',
			name: 'endpoint',
			type: 'string',
			default: '',
			displayOptions: {
				show: {
					providerType: ['foundry'],
				},
			},
		},
		{
			displayName: 'AWS Workspace ID',
			name: 'workspaceId',
			type: 'string',
			default: '',
			displayOptions: {
				show: {
					providerType: ['aws_platform'],
				},
			},
		},
		{
			displayName: 'Default Model',
			name: 'defaultModel',
			type: 'options',
			default: '',
			typeOptions: {
				loadOptionsMethod: 'getModels',
			},
		},
		{
			displayName: 'Custom Model ID',
			name: 'customModel',
			type: 'string',
			default: '',
			description: 'Optional override when the provider does not expose a models list API (e.g. Bedrock/Vertex)',
		},
	];
}

async function getModels(this: ILoadOptionsFunctions) {
	try {
		const raw = await this.getCredentials('claudeProvider');
		const credentials = readProviderCredentials(raw as IDataObject);
		const models = await listModels(credentials.providerType, credentials);
		return modelsToOptions(models);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [
			{
				name: `Could not load models: ${message}`,
				value: '__claude_agent__:credential_models_error',
				description: message,
			},
		];
	}
}

export class ClaudeProvider implements ICredentialType {
	name = 'claudeProvider';

	displayName = 'Claude Provider';

	documentationUrl = 'https://code.claude.com/docs/en/agent-sdk/overview';

	/** Nodes that register credentialTest.claudeProviderCredentialTest */
	supportedNodes = ['claudeAgent', 'claudeModelSelector'];

	properties: INodeProperties[] = providerFields();

	methods = {
		loadOptions: {
			getModels,
		},
	};

}
