import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeStreamAssembler } from '../dist/nodes/ClaudeAgent/lib/streamAssembler.js';
import { findUnexpectedBuiltinTools, getExpectedBuiltinTools } from '../dist/nodes/ClaudeAgent/lib/permissionPresets.js';

function createCollector(options) {
	const payloads = [];
	const assembler = new ClaudeStreamAssembler(
		{
			onBegin: async () => undefined,
			onStructured: async (jsonContent) => {
				payloads.push(JSON.parse(jsonContent).__claude__);
			},
			onEnd: async () => undefined,
		},
		options,
	);
	return { assembler, payloads };
}

function toolsOf(payloads, kind) {
	return payloads.filter((p) => p?.kind === kind);
}

test('并行工具按 tool_use_id 配对：content_block_stop 不发 tool_end', async () => {
	const { assembler, payloads } = createCollector();

	await assembler.consume({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'call_a', name: 'mcp__matrees__searchWorld' },
		},
	});
	await assembler.consume({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 1,
			content_block: { type: 'tool_use', id: 'call_b', name: 'mcp__matrees__getEntity' },
		},
	});
	// 旧 bug：content_block_stop 会误关第一个 pending 工具
	await assembler.consume({
		type: 'stream_event',
		event: { type: 'content_block_stop', index: 0 },
	});
	await assembler.consume({
		type: 'stream_event',
		event: { type: 'content_block_stop', index: 1 },
	});

	assert.equal(toolsOf(payloads, 'tool_end').length, 0, '入参流完不应发 tool_end');
	assert.equal(toolsOf(payloads, 'tool_start').length, 2);

	await assembler.consume({
		type: 'user',
		message: {
			content: [
				{ type: 'tool_result', tool_use_id: 'call_b', content: 'ok-b' },
				{ type: 'tool_result', tool_use_id: 'call_a', content: 'ok-a', is_error: true },
			],
		},
	});

	const ends = toolsOf(payloads, 'tool_end');
	assert.equal(ends.length, 2);
	const byId = Object.fromEntries(ends.map((e) => [e.callId, e]));
	assert.equal(byId.call_b.ok, true);
	assert.equal(byId.call_a.ok, false);
	assert.ok(byId.call_a.error);
});

test('is_error 透传为 tool_end.ok=false', async () => {
	const { assembler, payloads } = createCollector();

	await assembler.consume({
		type: 'assistant',
		message: {
			content: [
				{
					type: 'tool_use',
					id: 'call_fail',
					name: 'mcp__matrees__uploadIllustrationFromUrl',
					input: { url: 'https://example.com/a.png' },
				},
			],
		},
	});

	await assembler.consume({
		type: 'user',
		message: {
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'call_fail',
					is_error: true,
					content: 'hotlink blocked',
				},
			],
		},
	});

	const end = toolsOf(payloads, 'tool_end').at(-1);
	assert.equal(end.ok, false);
	// 用户可见错误须脱敏，不透传协议/英文原文
	assert.equal(end.error, '未成功');
});

test('system/permission_denied 发 tool_end denied', async () => {
	const { assembler, payloads } = createCollector();

	await assembler.consume({
		type: 'system',
		subtype: 'permission_denied',
		tool_use_id: 'call_deny',
		tool_name: 'Bash',
		message: 'not allowed',
	});

	const end = toolsOf(payloads, 'tool_end').at(-1);
	// Bash 为 T4 内部/隐身或防御类：visibility 可能 hidden，不向 UI 发事件
	// 若 name 被判 show 则会有 end；此处断言 assembler meta 中有记录
	const meta = JSON.parse(
		(assembler.getOutput().match(/<claude_meta>([\s\S]*?)<\/claude_meta>/) || [])[1] || '{}',
	);
	const call = (meta.toolCalls || []).find((t) => t.id === 'call_deny');
	assert.ok(call, 'permission_denied 应写入 toolCalls meta');
	assert.equal(call.denied, true);
	assert.equal(call.ok, false);
	// 隐身工具不发流式 tool_end
	if (end) {
		assert.equal(end.denied, true);
		assert.equal(end.ok, false);
	}
});

test('mcp_skills_only allow-list 审计：init 含 Agent/Bash 时发 tools_audit', async () => {
	const expected = getExpectedBuiltinTools('mcp_skills_only');
	assert.ok(Array.isArray(expected));
	assert.ok(expected.includes('Skill'));
	assert.ok(!expected.includes('Bash'));
	assert.ok(!expected.includes('Agent'));

	const unexpected = findUnexpectedBuiltinTools(
		['Skill', 'TaskCreate', 'Agent', 'Bash', 'mcp__matrees__searchWorld'],
		expected,
	);
	assert.deepEqual(unexpected.sort(), ['Agent', 'Bash'].sort());

	const { assembler, payloads } = createCollector({ expectedBuiltinTools: expected });
	await assembler.consume({
		type: 'system',
		subtype: 'init',
		tools: ['Skill', 'TaskCreate', 'Agent', 'Bash', 'mcp__matrees__searchWorld'],
	});
	const audit = payloads.find((p) => p.kind === 'status' && p.phase === 'tools_audit');
	assert.ok(audit);
	assert.match(audit.message, /Agent/);
	assert.match(audit.message, /Bash/);
});

test('step_start 在第二轮 assistant message_start 时发出', async () => {
	const { assembler, payloads } = createCollector();

	await assembler.consume({
		type: 'assistant',
		message: { content: [{ type: 'text', text: '第一段' }] },
	});
	await assembler.consume({
		type: 'stream_event',
		event: { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 1, output_tokens: 1 } } },
	});

	const steps = toolsOf(payloads, 'step_start');
	assert.equal(steps.length, 1);
	assert.equal(steps[0].index, 1);
});

test('Skill / getMemory 隐身：不发 tool_start 流式事件', async () => {
	const { assembler, payloads } = createCollector();

	await assembler.consume({
		type: 'assistant',
		message: {
			content: [
				{ type: 'tool_use', id: 'call_skill', name: 'Skill', input: { skill: 'inspiration-assistant' } },
				{ type: 'tool_use', id: 'call_mem', name: 'mcp__matrees__getMemory', input: { scope: 'user' } },
				{ type: 'tool_use', id: 'call_search', name: 'mcp__matrees__searchWorld', input: { keyword: '佛罗多' } },
			],
		},
	});

	const starts = toolsOf(payloads, 'tool_start');
	assert.equal(starts.length, 1);
	assert.equal(starts[0].name, 'mcp__matrees__searchWorld');
	assert.equal(starts[0].visibility, 'show');
});
