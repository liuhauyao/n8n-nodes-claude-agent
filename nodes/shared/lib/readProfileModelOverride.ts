import type { IExecuteFunctions, ILoadOptionsFunctions } from 'n8n-workflow';

import {
	buildProfileCollectionFieldName,
	buildProfileCollectionModelPath,
	buildProfileModelOverrideFieldName,
} from './evaluateRules';
import { sanitizeModelOverrideValue } from './loadProfileModelOptions';

type ParameterContext = IExecuteFunctions | ILoadOptionsFunctions;

type ResourceLocatorValue = {
	mode?: string;
	value?: string;
	cachedResultName?: string;
};

function readModelValue(raw: unknown): string | undefined {
	if (typeof raw === 'string') {
		return sanitizeModelOverrideValue(raw);
	}
	if (raw && typeof raw === 'object') {
		const locator = raw as ResourceLocatorValue;
		if (typeof locator.value === 'string') {
			return sanitizeModelOverrideValue(locator.value);
		}
	}
	return undefined;
}

export function readProfileModelOverride(
	ctx: ParameterContext,
	profileIndex: number,
	itemIndex = 0,
): string | undefined {
	const collectionName = buildProfileCollectionFieldName(profileIndex);
	try {
		const collection = ctx.getNodeParameter(collectionName, itemIndex, {}) as {
			modelOverride?: unknown;
		};
		const fromCollection = readModelValue(collection.modelOverride);
		if (fromCollection) return fromCollection;
	} catch {
		// legacy workflow
	}

	try {
		return readModelValue(
			ctx.getNodeParameter(buildProfileModelOverrideFieldName(profileIndex), itemIndex, ''),
		);
	} catch {
		return undefined;
	}
}

export function readProfileModelOverridePath(profileIndex: number): string {
	return buildProfileCollectionModelPath(profileIndex);
}
