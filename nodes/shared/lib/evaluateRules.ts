import type { FilterValue } from 'n8n-workflow';
import { executeFilter } from 'n8n-workflow/dist/cjs/node-parameters/filter-parameter';

export function evaluateProfileIndex(
	rules: Array<{ profileIndex: number; conditions: FilterValue }>,
	defaultProfileIndex: number,
	itemIndex: number,
): number {
	for (const rule of rules) {
		if (!rule?.conditions) continue;
		try {
			if (executeFilter(rule.conditions, { itemIndex })) {
				return Number(rule.profileIndex) || defaultProfileIndex;
			}
		} catch {
			// skip invalid rule
		}
	}
	return defaultProfileIndex;
}

export function buildProfileCredentialFieldName(index: number): string {
	return `profile${index}Credential`;
}

export function buildProfileModelOverrideFieldName(index: number): string {
	return `profile${index}ModelOverride`;
}

export function buildProfileDisplayOptions(index: number, numberOfProfiles: number) {
	return {
		show: {
			numberOfProfiles: Array.from({ length: numberOfProfiles - index + 1 }, (_, i) => i + index),
		},
	};
}
