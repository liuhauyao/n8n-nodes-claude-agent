/**
 * 校验根目录 package.json 符合 n8n 社区节点规范（无 runtime dependencies、无 lifecycle scripts）。
 */
import { ESLint } from 'eslint';
import { defineConfig } from 'eslint/config';
import pluginPkg from '@n8n/eslint-plugin-community-nodes';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rec = pluginPkg.configs.recommendedWithoutN8nCloudSupport;

const eslint = new ESLint({
	cwd: root,
	allowInlineConfig: false,
	overrideConfigFile: true,
	overrideConfig: defineConfig(rec),
});

const results = await eslint.lintFiles([join(root, 'package.json')]);
const errCount = results.reduce((n, r) => n + r.errorCount + r.fatalErrorCount, 0);
if (errCount > 0) {
	const formatter = await eslint.loadFormatter('stylish');
	process.stdout.write(await formatter.format(results));
	process.exit(1);
}
