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

	let snap = lastTaskSnapshot(payloads);
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
