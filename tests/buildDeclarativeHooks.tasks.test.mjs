import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildDeclarativeHooks,
	createHookRuntimeState,
} from '../dist/nodes/ClaudeAgent/lib/buildDeclarativeHooks.js';

async function runStopHook(hooks, state, lastMessage = '') {
	const stopMatcher = hooks.Stop?.[0]?.hooks?.[0];
	assert.ok(stopMatcher, 'Stop hook 应已挂载');
	return stopMatcher(
		{ hook_event_name: 'Stop', last_assistant_message: lastMessage },
		'tool-use-id',
		{ signal: new AbortController().signal },
	);
}

async function runPostToolUse(hooks, payload) {
	const matcher = hooks.PostToolUse?.[0]?.hooks?.[0];
	assert.ok(matcher, 'PostToolUse hook 应已挂载');
	return matcher(payload, 'tool-use-id', { signal: new AbortController().signal });
}

test('TaskCreate PostToolUse 无 tool_response 时用 tool_use_id 登记 taskStatusById', async () => {
	const state = createHookRuntimeState();
	const hooks = buildDeclarativeHooks({ stopHook: { enabled: true, requireAllTasksCompleted: true } }, state);

	await runPostToolUse(hooks, {
		hook_event_name: 'PostToolUse',
		tool_name: 'TaskCreate',
		tool_input: { subject: '步骤一', description: 'desc' },
		tool_response: undefined,
		tool_use_id: 'call_create_1',
	});

	assert.equal(state.taskStatusById.get('call_create_1'), 'pending');

	const blocked = await runStopHook(hooks, state, '正文\n<next>继续</next>');
	// SDK 官方契约：Stop 事件必须顶层 decision:'block' + reason 才会真正阻止 Claude 结束本轮；
	// 仅返回 hookSpecificOutput.additionalContext 不会阻断（这是此前版本从未真正拦截过的根因）。
	assert.equal(blocked.decision, 'block');
	assert.ok(blocked.reason?.includes('TaskUpdate'));
	assert.ok(blocked.hookSpecificOutput?.additionalContext?.includes('TaskUpdate'));
});

test('TaskUpdate PostToolUse 更新 completed 后 Stop Hook 放行', async () => {
	const state = createHookRuntimeState();
	const hooks = buildDeclarativeHooks({ stopHook: { enabled: true, requireAllTasksCompleted: true } }, state);

	await runPostToolUse(hooks, {
		hook_event_name: 'PostToolUse',
		tool_name: 'TaskCreate',
		tool_input: { subject: '步骤一' },
		tool_response: undefined,
		tool_use_id: 'call_create_1',
	});

	await runPostToolUse(hooks, {
		hook_event_name: 'PostToolUse',
		tool_name: 'TaskUpdate',
		tool_input: { taskId: 'call_create_1', status: 'completed' },
		tool_response: {},
		tool_use_id: 'call_update_1',
	});

	assert.equal(state.taskStatusById.get('call_create_1'), 'completed');

	const allowed = await runStopHook(hooks, state, '正文\n<next>继续</next>');
	assert.deepEqual(allowed, {});
});

test('TaskCreated / TaskCompleted SDK 事件同步 taskStatusById', async () => {
	const state = createHookRuntimeState();
	const hooks = buildDeclarativeHooks({ stopHook: { enabled: true, requireAllTasksCompleted: true } }, state);

	const createdMatcher = hooks.TaskCreated?.[0]?.hooks?.[0];
	const completedMatcher = hooks.TaskCompleted?.[0]?.hooks?.[0];
	assert.ok(createdMatcher && completedMatcher);

	await createdMatcher(
		{ hook_event_name: 'TaskCreated', task_id: 'task_real_1', task_subject: '步骤一' },
		'tool-use-id',
		{ signal: new AbortController().signal },
	);
	assert.equal(state.taskStatusById.get('task_real_1'), 'pending');

	await completedMatcher(
		{ hook_event_name: 'TaskCompleted', task_id: 'task_real_1', task_subject: '步骤一' },
		'tool-use-id',
		{ signal: new AbortController().signal },
	);
	assert.equal(state.taskStatusById.get('task_real_1'), 'completed');
});
