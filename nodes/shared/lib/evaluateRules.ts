import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { FilterValue } from 'n8n-workflow';

type ExecuteFilterFn = (filter: FilterValue, options: { itemIndex: number }) => boolean;

const hostRequire = createRequire(__filename);

let cachedExecuteFilter: ExecuteFilterFn | undefined;

function getN8nWorkflowRoot(): string {
	const seeds = [
		join(dirname(process.execPath), '../lib/node_modules/n8n/node_modules'),
		join(dirname(process.execPath), '../lib/node_modules'),
		process.cwd(),
	];
	for (const seed of seeds) {
		try {
			return dirname(hostRequire.resolve('n8n-workflow/package.json', { paths: [seed] }));
		} catch {
			// try next seed
		}
	}
	throw new Error(
		'Cannot resolve n8n-workflow from the n8n runtime. '
			+ 'Claude Model Selector must run inside a self-hosted n8n process.',
	);
}

function getExecuteFilter(): ExecuteFilterFn {
	if (!cachedExecuteFilter) {
		const wfRoot = getN8nWorkflowRoot();
		const mod = hostRequire(join(wfRoot, 'dist/cjs/node-parameters/filter-parameter.js')) as {
			executeFilter: ExecuteFilterFn;
		};
		cachedExecuteFilter = mod.executeFilter;
	}
	return cachedExecuteFilter;
}

export function evaluateProfileIndex(
	rules: Array<{ profileIndex: number; conditions: FilterValue }>,
	defaultProfileIndex: number,
	itemIndex: number,
): number {
	const executeFilter = getExecuteFilter();
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

/** Legacy flat parameter: profile1Credential */
export function buildProfileCredentialFieldName(index: number): string {
	return `profile${index}Credential`;
}

/** Legacy flat parameter: profile1ModelOverride */
export function buildProfileModelOverrideFieldName(index: number): string {
	return `profile${index}ModelOverride`;
}

/** Collection parameter: profile1 */
export function buildProfileCollectionFieldName(index: number): string {
	return `profile${index}`;
}

export function buildProfileCollectionCredentialPath(index: number): string {
	return `${buildProfileCollectionFieldName(index)}.credential`;
}

export function buildProfileCollectionModelPath(index: number): string {
	return `${buildProfileCollectionFieldName(index)}.modelOverride`;
}

/** Relative path for loadOptions on profile1.modelOverride → profile1.credential */
export const PROFILE_CREDENTIAL_LOAD_OPTIONS_PATH = '&credential';

export function buildProfileDisplayOptions(index: number, maxProfiles: number) {
	return {
		show: {
			numberOfProfiles: Array.from({ length: maxProfiles - index + 1 }, (_, i) => i + index),
		},
	};
}

export function buildProfileCredentialDisplayOptions(index: number, maxProfiles: number) {
	return buildProfileDisplayOptions(index, maxProfiles);
}
