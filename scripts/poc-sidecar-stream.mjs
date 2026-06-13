#!/usr/bin/env node
/**
 * Phase B POC：Sidecar 三轮对话 + 换 model
 *
 * 终端 1：npm run build && npm run sidecar
 * 终端 2：node scripts/poc-sidecar-stream.mjs
 */

const sidecarUrl = (process.env.CLAUDE_AGENT_SIDECAR_URL || 'http://127.0.0.1:18790').replace(/\/+$/, '');
const sessionId = process.env.POC_SESSION_ID || `poc-${Date.now()}`;
const modelA = process.env.POC_MODEL_A?.trim() || 'claude-sonnet-4-20250514';
const modelB = process.env.POC_MODEL_B?.trim() || modelA;

const baseParams = {
	sessionId,
	sessionTtlSeconds: 3600,
	settingSources: ['project'],
	hasWorkspaceConfig: false,
	permissionPreset: 'plan_only',
	maxTurns: 4,
	useClaudeCodePreset: false,
	strictMcpConfig: false,
};

function modelConfig(model) {
	return {
		version: 1,
		model,
		providerType: 'anthropic_direct',
		profileName: 'poc',
		profileIndex: 1,
		sdkEnv: {},
	};
}

async function postMessage(label, chatInput, model) {
	const body = {
		chatInput,
		systemMessage: 'You are concise. Remember user facts across turns.',
		modelConfig: modelConfig(model),
		params: baseParams,
		useClaudeCodePreset: false,
		cwd: process.env.POC_CWD || process.cwd(),
		additionalDirectories: [],
		mcpServers: {},
		mcpServerNames: [],
		mcpDisallowedSdk: [],
		mcpAllowedSdk: [],
		mcpPreApproved: [],
	};

	console.log(`\n=== ${label} (${model}) ===`);
	const res = await fetch(`${sidecarUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
		body: JSON.stringify(body),
	});
	if (!res.ok || !res.body) {
		throw new Error(`HTTP ${res.status}`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let doneMeta;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const parts = buffer.split('\n\n');
		buffer = parts.pop() ?? '';
		for (const part of parts) {
			const line = part.split('\n').find((l) => l.startsWith('data: '));
			if (!line) continue;
			const json = JSON.parse(line.slice(6));
			if (json.__sidecar_done__) {
				doneMeta = json.__sidecar_done__;
				continue;
			}
			const payload = json.__claude__;
			if (payload?.kind === 'text' && payload.text) process.stdout.write(payload.text);
		}
	}
	console.log('\nmeta:', doneMeta);
	return doneMeta;
}

async function main() {
	const health = await fetch(`${sidecarUrl}/health`).then((r) => r.json());
	console.log('health:', health);

	await postMessage('turn-1', 'My favorite color is cobalt. Reply OK.', modelA);
	await postMessage('turn-2', 'What is my favorite color?', modelA);
	await postMessage('turn-3-model-switch', 'Say the color again in one word.', modelB);
	console.log('\nPOC sidecar complete.');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
