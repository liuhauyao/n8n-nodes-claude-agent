#!/usr/bin/env node
/**
 * Phase A POC：Stateless resume / forkSession + 换 model
 *
 * 用法：
 *   npm run build
 *   ANTHROPIC_API_KEY=... node scripts/poc-resume-fork.mjs
 *
 * 可选环境变量：
 *   POC_MODEL_A / POC_MODEL_B — 两轮使用的 model id
 *   POC_CWD — 工作目录
 */

import { loadClaudeSdk } from '../dist/nodes/ClaudeAgent/lib/loadClaudeSdk.js';
import { runStatelessTurn, toStoredRecord } from '../dist/nodes/ClaudeAgent/lib/runStatelessTurn.js';
import { ClaudeStreamAssembler } from '../dist/nodes/ClaudeAgent/lib/streamAssembler.js';

const modelA = process.env.POC_MODEL_A?.trim() || 'claude-sonnet-4-20250514';
const modelB = process.env.POC_MODEL_B?.trim() || modelA;
const cwd = process.env.POC_CWD?.trim() || process.cwd();

const baseModelConfig = {
	version: 1,
	model: modelA,
	providerType: 'anthropic_direct',
	profileName: 'poc',
	profileIndex: 1,
	sdkEnv: {},
};

function makeAssembler(label) {
	return new ClaudeStreamAssembler({
		onBegin: async () => process.stdout.write(`\n--- ${label} begin ---\n`),
		onStructured: async (json) => {
			try {
				const parsed = JSON.parse(json);
				const payload = parsed.__claude__;
				if (payload?.kind === 'text' && payload.text) {
					process.stdout.write(payload.text);
				}
			} catch {
				// ignore
			}
		},
		onEnd: async () => process.stdout.write(`\n--- ${label} end ---\n`),
	});
}

async function runTurn(label, queryFn, chatInput, modelConfig, storedSession) {
	const assembler = makeAssembler(label);
	await assembler.begin();
	const turn = await runStatelessTurn({
		queryFn,
		chatInput,
		modelConfig,
		storedSession,
		assembler,
		cwd,
		settingSources: ['project'],
		hasWorkspaceConfig: false,
		systemMessage: 'You are a concise assistant. Remember facts the user tells you.',
		useClaudeCodePreset: false,
		mcpServers: {},
		mcpServerNames: [],
		mcpDisallowedSdk: [],
		mcpAllowedSdk: [],
		mcpPreApproved: [],
		permissionPreset: 'plan_only',
		strictMcpConfig: false,
		maxTurns: 4,
	});
	await assembler.end();
	console.log('\ncontinuation:', turn.continuationKind, 'session:', turn.claudeSessionId);
	return {
		turn,
		record: turn.claudeSessionId ? toStoredRecord(modelConfig, turn.claudeSessionId) : undefined,
		text: assembler.getTextOutput(),
	};
}

async function main() {
	const { query: queryFn } = await loadClaudeSdk();

	const r1 = await runTurn(
		'turn-1-new',
		queryFn,
		'My secret codeword is AURORA-42. Reply OK only.',
		baseModelConfig,
		undefined,
	);
	if (!r1.record) throw new Error('turn 1 missing session id');

	const r2 = await runTurn(
		'turn-2-resume',
		queryFn,
		'What is my secret codeword?',
		baseModelConfig,
		r1.record,
	);
	if (!r2.text.includes('AURORA')) {
		console.warn('WARN: resume may have lost context');
	}

	const r3 = await runTurn(
		'turn-3-fork-model',
		queryFn,
		'Repeat the codeword again.',
		{ ...baseModelConfig, model: modelB },
		r1.record,
	);
	console.log('fork continuation:', r3.turn.continuationKind);
	if (!r3.text.includes('AURORA')) {
		console.warn('WARN: fork may have lost context');
	}

	console.log('\nPOC complete.');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
