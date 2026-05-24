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
	buildProfileCollectionFieldName,
	buildProfileDisplayOptions,
	evaluateProfileIndex,
} from '../shared/lib/evaluateRules';
import { getClaudeProviderCredentials } from '../shared/lib/loadClaudeProviderCredentialOptions';
import { buildProfileModelListSearchMethods, buildProfileModelLoadOptionsMethods } from '../shared/lib/loadProfileModelOptions';
import {
	asCredentialDataObject,
	loadProfileProviderCredentials,
} from '../shared/lib/loadProfileCredentials';
import { MAX_PROFILE_CREDENTIAL_SLOTS } from '../shared/lib/profileCredentialSlots';
import { readProfileModelOverride } from '../shared/lib/readProfileModelOverride';
import { CLAUDE_MODEL_CONFIG_FIELD } from '../shared/lib/types';

const MAX_PROFILES = MAX_PROFILE_CREDENTIAL_SLOTS;

/**
 * Per-profile collection keeps credential + model together in the UI (n8n renders collections inline).
 * Model uses resourceLocator + loadOptionsDependsOn on credential — n8n reloads the list when
 * credential changes (same pattern as Anthropic Chat Model + credentials, but credential is in-collection).
 * Native description.credentials slots are NOT used — they always render at the top of the panel,
 * separated from parameters (see Notion node: inline type "credentials" is for repositioning only).
 */
function buildProfileCollectionProperties(): INodeProperties[] {
	const properties: INodeProperties[] = [];
	for (let index = 1; index <= MAX_PROFILES; index++) {
		const collectionName = buildProfileCollectionFieldName(index);
		properties.push({
			displayName: `Profile ${index}`,
			name: collectionName,
			type: 'collection',
			placeholder: 'Configure Profile',
			default: {
				credential: '',
				modelOverride: {
					mode: 'list',
					value: '',
					cachedResultName: '',
				},
			},
			displayOptions: buildProfileDisplayOptions(index, MAX_PROFILES),
			options: [
				{
					displayName: 'Claude Provider Credential',
					name: 'credential',
					type: 'options',
					default: '',
					noDataExpression: true,
					description:
						'Claude Provider credentials from your n8n instance (required at runtime). Changing this reloads the model list below.',
					typeOptions: {
						loadOptionsMethod: 'getClaudeProviderCredentials',
					},
				},
				{
					displayName: 'Model',
					name: 'modelOverride',
					type: 'resourceLocator',
					default: {
						mode: 'list',
						value: '',
						cachedResultName: '',
					},
					required: false,
					noDataExpression: true,
					description:
						'Optional. Loaded from GET {baseUrl}/v1/models for the credential above; leave empty to use upstream inferenceModel or credential default.',
					typeOptions: {
						loadOptionsDependsOn: ['&credential'],
					},
					modes: [
						{
							displayName: 'From List',
							name: 'list',
							type: 'list',
							placeholder: 'Select a model…',
							typeOptions: {
								searchListMethod: `searchProfile${index}Models`,
								searchable: true,
							},
						},
						{
							displayName: 'ID',
							name: 'id',
							type: 'string',
							placeholder: 'model-id',
						},
					],
				},
			],
		});
	}
	return properties;
}

export class ClaudeModelSelector implements INodeType {
	methods = {
		loadOptions: {
			getClaudeProviderCredentials,
			...buildProfileModelLoadOptionsMethods(MAX_PROFILES),
		},
		listSearch: {
			...buildProfileModelListSearchMethods(MAX_PROFILES),
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
		properties: [
			{
				displayName: 'Number of Profiles',
				name: 'numberOfProfiles',
				type: 'number',
				default: 2,
				description:
					'How many provider credentials this node can route across. Use 1 for a single gateway; use 2+ with Rules to pick Profile 2…N.',
				typeOptions: {
					minValue: 1,
					maxValue: MAX_PROFILES,
				},
			},
			...buildProfileCollectionProperties(),
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

				const itemJson = items[itemIndex].json;
				const itemModel =
					(typeof itemJson.inferenceModel === 'string' && itemJson.inferenceModel.trim())
					|| (typeof itemJson.modelName === 'string' && itemJson.modelName.trim())
					|| '';

				const modelOverride =
					readProfileModelOverride(this, profileIndex, itemIndex)
					|| itemModel
					|| undefined;

				const raw = await loadProfileProviderCredentials(this, profileIndex, itemIndex);
				const modelConfig = buildModelConfigFromRaw(
					asCredentialDataObject(raw),
					modelOverride,
					profileIndex,
				);

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
