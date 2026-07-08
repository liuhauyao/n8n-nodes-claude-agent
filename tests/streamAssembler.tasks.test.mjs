import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeStreamAssembler } from '../dist/nodes/ClaudeAgent/lib/streamAssembler.js';

function createCollector() {
	const payloads = [];
	const assembler = new ClaudeStreamAssembler({
		onBegin: async () => undefined,
		onStructured: async (jsonContent) => {
			payloads.push(JSON.parse(jsonContent).__claude__);
		},
		onEnd: async () => undefined,
	});
	return { assembler, payloads };
}

function lastTaskSnapshot(payloads) {
	return payloads.filter((p) => p?.kind === 'task_snapshot').at(-1);
}

test('TaskCreate + TaskUpdate 流式同步 completed 状态', async () => {
	const { assembler, payloads } = createCollector();

	await assembler.consume({
		type: 'assistant',
		message: {
			content: [
				{
					type: 'tool_use',
					id: 'call_create_1',
					name: 'TaskCreate',
					input: {
						subject: '步骤一',
						description: '先做 A',
					},
				},
			],
		},
	});

	let snap = lastTaskSnapshot(payloads);
	assert.ok(snap, 'TaskCreate 后应立即推送 task_snapshot');
	assert.equal(snap.tasks[0].status, 'pending');
	assert.equal(snap.tasks[0].id, 'call_create_1');

	await assembler.consume({
		type: 'user',
		message: {
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'call_create_1',
					content: [{ type: 'text', text: JSON.stringify({ task: { id: 'task_real_1', subject: '步骤一' } }) }],
				},
			],
		},
	});

	snap = lastTaskSnapshot(payloads);
	assert.equal(snap.tasks[0].status, 'pending');
	assert.equal(snap.tasks[0].id, 'task_real_1');

	await assembler.consume({
		type: 'assistant',
		message: {
			content: [
				{
					type: 'tool_use',
					id: 'call_update_1',
					name: 'TaskUpdate',
					input: {
						taskId: 'task_real_1',
						status: 'in_progress',
						activeForm: '正在执行 A',
					},
				},
			],
		},
	});

	snap = lastTaskSnapshot(payloads);
	assert.equal(snap.tasks[0].status, 'in_progress');

	await assembler.consume({
		type: 'assistant',
		message: {
			content: [
				{
					type: 'tool_use',
					id: 'call_update_2',
					name: 'TaskUpdate',
					input: {
						taskId: 'task_real_1',
						status: 'completed',
					},
				},
			],
		},
	});

	snap = lastTaskSnapshot(payloads);
	assert.equal(snap.tasks[0].status, 'completed');

	const metaTasks = assembler.getAgentTasks();
	assert.equal(metaTasks[0].status, 'completed');
});

test('TaskUpdate 使用真实 id 时可迁移 call_* 占位 id', async () => {
	const { assembler, payloads } = createCollector();

	await assembler.consume({
		type: 'assistant',
		message: {
			content: [
				{
					type: 'tool_use',
					id: 'call_create_2',
					name: 'TaskCreate',
					input: { subject: '步骤二', description: 'desc' },
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
					tool_use_id: 'call_create_2',
					content: 'ok',
				},
			],
		},
	});

	assert.equal(assembler.getAgentTasks()[0].id, 'call_create_2');

	await assembler.consume({
		type: 'assistant',
		message: {
			content: [
				{
					type: 'tool_use',
					id: 'call_update_3',
					name: 'TaskUpdate',
					input: { taskId: 'task_real_2', status: 'completed' },
				},
			],
		},
	});

	const snap = lastTaskSnapshot(payloads);
	assert.equal(snap.tasks[0].id, 'task_real_2');
	assert.equal(snap.tasks[0].status, 'completed');
});

test('system task_updated 事件同步 running → in_progress', async () => {
	const { assembler, payloads } = createCollector();

	await assembler.consume({
		type: 'assistant',
		message: {
			content: [
				{
					type: 'tool_use',
					id: 'call_create_3',
					name: 'TaskCreate',
					input: { subject: '步骤三', description: 'desc' },
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
					tool_use_id: 'call_create_3',
					content: [{ type: 'text', text: JSON.stringify({ task: { id: 'task_real_3', subject: '步骤三' } }) }],
				},
			],
		},
	});

	await assembler.consume({
		type: 'system',
		subtype: 'task_updated',
		task_id: 'task_real_3',
		patch: { status: 'running' },
	});

	const snap = lastTaskSnapshot(payloads);
	assert.equal(snap.tasks[0].status, 'in_progress');
});

test('第三方模型经 shim 转发：tool_result.content 为纯文本，真源在同级 tool_use_result（生产 2026-07-07 复现）', async () => {
	const { assembler, payloads } = createCollector();

	await assembler.consume({
		type: 'assistant',
		message: {
			content: [
				{ type: 'tool_use', id: 'call_00_abc', name: 'TaskCreate', input: { subject: '任务一' } },
			],
		},
	});

	// 生产实录：message.content[].content 是人类可读文本（非 JSON），
	// 结构化 TaskCreateOutput 挂在与 message 同级的 tool_use_result 字段
	await assembler.consume({
		type: 'user',
		tool_use_result: { task: { id: '1', subject: '任务一' } },
		message: {
			content: [
				{ tool_use_id: 'call_00_abc', type: 'tool_result', content: 'Task #1 created successfully: 任务一' },
			],
		},
	});

	let snap = lastTaskSnapshot(payloads);
	assert.equal(snap.tasks[0].id, '1', 'taskId 应从 tool_use_result 迁移为 SDK 真实 id "1"，而非误用 tool_use_id');
	assert.equal(snap.tasks[0].status, 'pending');

	// Agent 用真实 SDK id "1" 调用 TaskUpdate（与 tool_use_id 完全无关）
	await assembler.consume({
		type: 'assistant',
		message: {
			content: [
				{ type: 'tool_use', id: 'call_00_upd', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
			],
		},
	});

	snap = lastTaskSnapshot(payloads);
	assert.equal(snap.tasks[0].status, 'completed', 'TaskUpdate 用真实 id "1" 应能命中已注册的任务并标记完成');
	assert.equal(assembler.getAgentTasks()[0].status, 'completed');
});

test('多任务场景：纯文本 tool_result 依旧能各自正确迁移 id（不依赖仅剩 1 个任务的兜底）', async () => {
	const { assembler } = createCollector();

	for (const [callId, taskId, subject] of [
		['call_a', '1', '任务A'],
		['call_b', '2', '任务B'],
		['call_c', '3', '任务C'],
	]) {
		await assembler.consume({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id: callId, name: 'TaskCreate', input: { subject } }] },
		});
		await assembler.consume({
			type: 'user',
			tool_use_result: { task: { id: taskId, subject } },
			message: {
				content: [{ tool_use_id: callId, type: 'tool_result', content: `Task #${taskId} created successfully: ${subject}` }],
			},
		});
	}

	assert.deepEqual(
		assembler.getAgentTasks().map((t) => t.id),
		['1', '2', '3'],
		'三个任务都应迁移为各自的真实 SDK id，而不是全部停留在 call_* 占位 id',
	);

	await assembler.consume({
		type: 'assistant',
		message: { content: [{ type: 'tool_use', id: 'call_upd2', name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }] },
	});

	const tasks = assembler.getAgentTasks();
	assert.equal(tasks.find((t) => t.id === '2').status, 'completed');
	assert.equal(tasks.find((t) => t.id === '1').status, 'pending');
});
