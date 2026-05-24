import { defineConfig } from 'eslint/config';
import pluginPkg from '@n8n/eslint-plugin-community-nodes';

/** Claude Agent 社区节点：使用不含 Cloud 限制的规则集 */
const rec = pluginPkg.configs.recommendedWithoutN8nCloudSupport;

export default defineConfig(
	{
		ignores: [
			'node_modules/**',
			'nodes/**',
			'credentials/**',
			'eslint.config.mjs',
			'scripts/**',
			'package.json',
			'package-lock.json',
			'dist/**/*.map',
			'dist/**/*.d.ts',
		],
	},
	{
		files: ['dist/**/*.js'],
		...rec,
		rules: {
			...rec.rules,
			'no-console': 'error',
		},
	},
);
