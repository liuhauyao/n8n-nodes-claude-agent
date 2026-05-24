import {
	NodeConnectionTypes,
	NodeOperationError,
	type FilterValue,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { buildSdkEnv, readProviderCredentials } from '../shared/lib/buildSdkEnv';
import {
	buildProfileCredentialFieldName,
	buildProfileDisplayOptions,
	buildProfileModelOverrideFieldName,
	evaluateProfileIndex,
} from '../shared/lib/evaluateRules';
import { buildModelConfigFromCredentials } from '../shared/lib/resolveModelConfig';
import { claudeProviderCredentialTest } from '../shared/lib/claudeProviderCredentialTest';
import { CLAUDE_MODEL_CONFIG_FIELD } from '../shared/lib/types';

const MAX_PROFILES = 10;

function buildProfileProperties(): INodeProperties[] {
	const properties: INodeProperties[] = [];
	for (let index = 1; index <= MAX_PROFILES; index++) {
		properties.push(
			{
				displayName: `Profile ${index} Credential`,
				name: buildProfileCredentialFieldName(index),
				type: 'credentialsSelect',
				default: '',
				required: true,
				displayOptions: buildProfileDisplayOptions(index, MAX_PROFILES),
				typeOptions: {
					credentialTypes: ['claudeProvider'],
				},
			},
			{
				displayName: `Profile ${index} Model Override`,
				name: buildProfileModelOverrideFieldName(index),
				type: 'string',
				default: '',
				displayOptions: buildProfileDisplayOptions(index, MAX_PROFILES),
				description: 'Optional model id override for this profile',
			},
		);
	}
	return properties;
}

export class ClaudeModelSelector implements INodeType {
	methods = {
		credentialTest: {
			claudeProviderCredentialTest,
		},
	};

	description: INodeTypeDescription = {
		displayName: 'Claude Model Selector',
		name: 'claudeModelSelector',
		icon: 'file:claude.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["numberOfProfiles"]}} profiles',
		description:
			'Route to a Claude Provider credential and model using rules (Main output carries claudeModelConfig for Claude Agent)',
		defaults: {
			name: 'Claude Model Selector',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'claudeProvider',
				testedBy: 'claudeProviderCredentialTest',
			},
		],
		properties: [
			{
				displayName: 'Number of Profiles',
				name: 'numberOfProfiles',
				type: 'number',
				default: 2,
				typeOptions: {
					minValue: 1,
					maxValue: MAX_PROFILES,
				},
			},
			...buildProfileProperties(),
			{
				displayName: 'Rules',
				name: 'rules',
				placeholder: 'Add Rule',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				default: {},
				options: [
					{
						displayName: 'Rule',
						name: 'rule',
						values: [
							{
								displayName: 'Profile Index',
								name: 'profileIndex',
								type: 'number',
								default: 1,
								typeOptions: { minValue: 1, maxValue: MAX_PROFILES },
							},
							{
								displayName: 'Conditions',
								name: 'conditions',
								type: 'filter',
								default: {},
								typeOptions: {
									filter: {
										caseSensitive: true,
										typeValidation: 'strict',
										version: 2,
									},
								},
							},
						],
					},
				],
			},
			{
				displayName: 'Default Profile Index',
				name: 'defaultProfileIndex',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 1, maxValue: MAX_PROFILES },
				description: 'Used when no rule matches',
			},
			{
				displayName: 'Output Field Name',
				name: 'outputFieldName',
				type: 'string',
				default: CLAUDE_MODEL_CONFIG_FIELD,
				description: 'JSON field written onto each output item for Claude Agent (fromSelector mode)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const numberOfProfiles = Number(this.getNodeParameter('numberOfProfiles', 0, 2));
		const defaultProfileIndex = Number(this.getNodeParameter('defaultProfileIndex', 0, 1));
		const outputFieldName = String(this.getNodeParameter('outputFieldName', 0, CLAUDE_MODEL_CONFIG_FIELD));

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const rulesRaw = this.getNodeParameter('rules.rule', itemIndex, []) as Array<{
					profileIndex: number;
					conditions: FilterValue;
				}>;
				const profileIndex = evaluateProfileIndex(
					rulesRaw ?? [],
					defaultProfileIndex,
					itemIndex,
				);
				if (profileIndex < 1 || profileIndex > numberOfProfiles) {
					throw new NodeOperationError(
						this.getNode(),
						`Selected profile index ${profileIndex} is out of range (1-${numberOfProfiles})`,
						{ itemIndex },
					);
				}

				const modelOverride = String(
					this.getNodeParameter(buildProfileModelOverrideFieldName(profileIndex), itemIndex, ''),
				).trim() || undefined;

				const modelConfig = await buildModelConfigFromCredentials(this, {
					credentialFieldName: buildProfileCredentialFieldName(profileIndex),
					modelOverride,
					itemIndex,
					profileIndex,
				});

				returnData.push({
					json: {
						...items[itemIndex].json,
						[outputFieldName]: modelConfig,
						selectedProfileIndex: profileIndex,
						selectedModel: modelConfig.model,
						selectedProvider: modelConfig.providerType,
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (error instanceof NodeOperationError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				throw new NodeOperationError(this.getNode(), message, { itemIndex });
			}
		}

		return [returnData];
	}
}

/** Exported for tests */
export function buildModelConfigFromRaw(
	raw: IDataObject,
	modelOverride?: string,
	profileIndex?: number,
) {
	const config = buildSdkEnv(readProviderCredentials(raw), modelOverride);
	if (profileIndex !== undefined) config.profileIndex = profileIndex;
	return config;
}
