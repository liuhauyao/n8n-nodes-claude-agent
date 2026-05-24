import type { ILoadOptionsFunctions, INodeListSearchResult, INodePropertyOptions } from 'n8n-workflow';

import { readProviderCredentials } from './buildSdkEnv';
import { tryLoadProfileProviderCredentials } from './loadProfileCredentials';
import { listModels, modelsToOptions } from './modelCatalog';

/** Internal sentinel — never used as a real model id. */
export const LOAD_OPTIONS_PLACEHOLDER_PREFIX = '__claude_agent__:';

export const EMPTY_MODEL_OPTION: INodePropertyOptions = {
	name: '— Use credential default or upstream —',
	value: '',
};

export function sanitizeModelOverrideValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.startsWith(LOAD_OPTIONS_PLACEHOLDER_PREFIX)) {
		return undefined;
	}
	return trimmed;
}

function placeholderOption(name: string, suffix: string, description?: string): INodePropertyOptions {
	return {
		name,
		value: `${LOAD_OPTIONS_PLACEHOLDER_PREFIX}${suffix}`,
		description,
	};
}

async function loadProfileModelOptions(
	this: ILoadOptionsFunctions,
	profileIndex: number,
	filter?: string,
): Promise<INodePropertyOptions[]> {
	const raw = await tryLoadProfileProviderCredentials(this, profileIndex, 0);
	if (!raw) {
		return [
			placeholderOption(
				'Select Claude Provider Credential first',
				`no_cred_${profileIndex}`,
			),
		];
	}

	try {
		const credentials = readProviderCredentials(raw);
		const models = await listModels(credentials.providerType, credentials);
		let options = [EMPTY_MODEL_OPTION, ...modelsToOptions(models)];
		if (filter?.trim()) {
			const needle = filter.trim().toLowerCase();
			options = options.filter((option) => {
				if (!option.value) return true;
				return option.name.toLowerCase().includes(needle)
					|| String(option.value).toLowerCase().includes(needle);
			});
		}
		return options;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [
			placeholderOption(
				`Could not load models: ${message}`,
				`error_${profileIndex}`,
				message,
			),
		];
	}
}

export function createGetProfileModels(profileIndex: number) {
	return async function getProfileModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		return await loadProfileModelOptions.call(this, profileIndex);
	};
}

/** resourceLocator searchListMethod — must be registered on methods.listSearch (not loadOptions). */
export function createSearchProfileModels(profileIndex: number) {
	return async function searchProfileModels(
		this: ILoadOptionsFunctions,
		filter?: string,
	): Promise<INodeListSearchResult> {
		const options = await loadProfileModelOptions.call(this, profileIndex, filter);
		return {
			results: options.filter(
				(option) => Boolean(option.value) && !String(option.value).startsWith(LOAD_OPTIONS_PLACEHOLDER_PREFIX),
			),
		};
	};
}

export function buildProfileModelLoadOptionsMethods(maxProfiles: number) {
	const methods: Record<string, ReturnType<typeof createGetProfileModels>> = {};
	for (let index = 1; index <= maxProfiles; index++) {
		methods[`getProfile${index}Models`] = createGetProfileModels(index);
	}
	return methods;
}

export function buildProfileModelListSearchMethods(maxProfiles: number) {
	const methods: Record<string, ReturnType<typeof createSearchProfileModels>> = {};
	for (let index = 1; index <= maxProfiles; index++) {
		methods[`searchProfile${index}Models`] = createSearchProfileModels(index);
	}
	return methods;
}
