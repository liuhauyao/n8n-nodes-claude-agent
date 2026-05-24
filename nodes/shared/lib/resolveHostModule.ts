import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const hostRequire = createRequire(__filename);

function getPackageRoot(): string {
	return join(__dirname, '../../../../');
}

function getCommunityNodesRoot(): string {
	return join(getPackageRoot(), '../..');
}

/** Resolve n8n runtime modules (e.g. n8n-workflow filter helpers) bundled with the n8n process. */
function getN8nRuntimeSearchPaths(): string[] {
	const paths: string[] = [];
	const seeds = [
		process.cwd(),
		getCommunityNodesRoot(),
		dirname(process.execPath),
		join(dirname(process.execPath), '../lib/node_modules'),
		join(dirname(process.execPath), '../lib/node_modules/n8n/node_modules'),
	];

	for (const seed of seeds) {
		for (const moduleId of ['n8n/package.json', 'n8n-workflow/package.json']) {
			try {
				const resolved = hostRequire.resolve(moduleId, { paths: [seed] });
				const moduleRoot = dirname(resolved);
				paths.push(moduleRoot);
				if (moduleId === 'n8n/package.json') {
					paths.push(join(moduleRoot, 'node_modules'));
				}
			} catch {
				// try next seed
			}
		}
	}

	return [...new Set(paths)];
}

function getModuleSearchPaths(): string[] {
	const packageRoot = getPackageRoot();
	const nodesRoot = getCommunityNodesRoot();
	return [
		...getN8nRuntimeSearchPaths(),
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
