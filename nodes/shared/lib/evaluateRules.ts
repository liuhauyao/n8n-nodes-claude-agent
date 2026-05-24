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
