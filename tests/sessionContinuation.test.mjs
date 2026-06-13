import assert from 'node:assert/strict';
import test from 'node:test';

import {
	isSameProfile,
	resolveSessionContinuation,
	sameModelConfig,
} from '../dist/nodes/ClaudeAgent/lib/sessionContinuation.js';

const base = {
	model: 'deepseek-v4-flash',
	providerType: 'openai_compatible_gateway',
	profileName: 'p1',
	profileIndex: 1,
	version: 1,
	sdkEnv: {},
};

test('sameModelConfig 全字段一致', () => {
	assert.equal(
		sameModelConfig(base, { model: base.model, providerType: base.providerType, profileIndex: 1 }),
		true,
	);
});

test('resolveSessionContinuation 无 stored → new', () => {
	assert.deepEqual(resolveSessionContinuation(base, undefined), { kind: 'new' });
});

test('resolveSessionContinuation legacy → resume', () => {
	assert.deepEqual(
		resolveSessionContinuation(base, {
			claudeSessionId: 'uuid-1',
			modelConfig: { providerType: 'anthropic_direct', profileName: 'legacy', model: '' },
		}),
		{ kind: 'resume', claudeSessionId: 'uuid-1' },
	);
});

test('resolveSessionContinuation 同配置 → resume', () => {
	assert.deepEqual(
		resolveSessionContinuation(base, {
			claudeSessionId: 'uuid-2',
			modelConfig: {
				model: base.model,
				providerType: base.providerType,
				profileName: 'p1',
				profileIndex: 1,
			},
		}),
		{ kind: 'resume', claudeSessionId: 'uuid-2' },
	);
});

test('resolveSessionContinuation 换 model → fork', () => {
	assert.deepEqual(
		resolveSessionContinuation(
			{ ...base, model: 'mimo-v2.5' },
			{
				claudeSessionId: 'uuid-3',
				modelConfig: {
					model: base.model,
					providerType: base.providerType,
					profileName: 'p1',
					profileIndex: 1,
				},
			},
		),
		{ kind: 'fork', sourceClaudeSessionId: 'uuid-3' },
	);
});

test('resolveSessionContinuation 换 profile → fork', () => {
	assert.deepEqual(
		resolveSessionContinuation(
			{ ...base, profileIndex: 2 },
			{
				claudeSessionId: 'uuid-4',
				modelConfig: {
					model: base.model,
					providerType: base.providerType,
					profileName: 'p1',
					profileIndex: 1,
				},
			},
		),
		{ kind: 'fork', sourceClaudeSessionId: 'uuid-4' },
	);
});

test('isSameProfile 仅 model 不同仍为同 Profile', () => {
	assert.equal(
		isSameProfile(
			{ model: 'a', providerType: 'x', profileIndex: 1 },
			{ model: 'b', providerType: 'x', profileIndex: 1 },
		),
		true,
	);
});
