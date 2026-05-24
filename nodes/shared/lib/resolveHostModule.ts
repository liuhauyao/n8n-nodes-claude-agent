import { createRequire } from 'node:module';
import { join } from 'node:path';

const hostRequire = createRequire(__filename);

function getPackageRoot(): string {
	return join(__dirname, '../../../../');
}

function getCommunityNodesRoot(): string {
	return join(getPackageRoot(), '../..');
}

function getModuleSearchPaths(): string[] {
	const packageRoot = getPackageRoot();
	const nodesRoot = getCommunityNodesRoot();
	return [
		nodesRoot,
		join(nodesRoot, 'node_modules'),
		packageRoot,
		join(packageRoot, 'node_modules'),
	];
}

export function resolveHostModule<T = unknown>(moduleId: string): T {
	const paths = getModuleSearchPaths();
	for (const base of paths) {
		try {
			const resolved = hostRequire.resolve(moduleId, { paths: [base] });
			return hostRequire(resolved) as T;
		} catch {
			// try next search root
		}
	}
	throw new Error(
		`Cannot resolve "${moduleId}" from the n8n community nodes directory. `
			+ 'Install host dependencies in ~/.n8n/nodes/package.json (see README).',
	);
}

export async function importHostModule<T = unknown>(moduleId: string): Promise<T> {
	const paths = getModuleSearchPaths();
	for (const base of paths) {
		try {
			const resolved = hostRequire.resolve(moduleId, { paths: [base] });
			return (await import(resolved)) as T;
		} catch {
			// try next search root
		}
	}
	throw new Error(
		`Cannot resolve "${moduleId}" from the n8n community nodes directory. `
			+ 'Install host dependencies in ~/.n8n/nodes/package.json (see README).',
	);
}
