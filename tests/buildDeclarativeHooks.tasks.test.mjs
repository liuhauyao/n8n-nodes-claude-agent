import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildDeclarativeHooks,
	createHookRuntimeState,
	recordAssistantMessageForHooks,
	resetHookRuntimeStateForNextTurn,
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

/** 模拟一条助手消息完整流式输出（按行 flush，最后一次 final=true） */
async function runMessageDisplay(hooks, messageId, lines) {
	const matcher = hooks.MessageDisplay?.[0]?.hooks?.[0];
	assert.ok(matcher, 'MessageDisplay hook 应已挂载');
	for (const [index, delta] of lines.entries()) {
		await matcher(
			{
				hook_event_name: 'MessageDisplay',
				turn_id: 'turn-1',
				message_id: messageId,
				index,
				final: index === lines.length - 1,
				delta,
			},
			'tool-use-id',
			{ signal: new AbortController().signal },
		);
	}
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

test('TaskCreate 纯文本 tool_response（第三方模型 shim 转发）不产生孤儿 pending 项（2026-07-07 生产复现）', async () => {
	const state = createHookRuntimeState();
	const hooks = buildDeclarativeHooks({ stopHook: { enabled: true, requireAllTasksCompleted: true, maxBlocks: 3 } }, state);

	// 生产实录：tool_response 是人类可读文本而非结构化 JSON
	await runPostToolUse(hooks, {
		hook_event_name: 'PostToolUse',
		tool_name: 'TaskCreate',
		tool_input: { subject: '任务一' },
		tool_response: 'Task #1 created successfully: 任务一',
		tool_use_id: 'call_00_abc',
	});

	// Agent 用 SDK 真实 id "1"（而非 tool_use_id）调用 TaskUpdate
	await runPostToolUse(hooks, {
		hook_event_name: 'PostToolUse',
		tool_name: 'TaskUpdate',
		tool_input: { taskId: '1', status: 'completed' },
		tool_response: 'Updated task #1 status',
		tool_use_id: 'call_00_upd',
	});

	// 修复前：taskStatusById 里 call_00_abc 永远停在 pending（孤儿项），Stop Hook 永远拦截
	const allowed = await runStopHook(hooks, state, '正文\n<next>继续</next>');
	assert.deepEqual(allowed, {}, 'taskId 应正确迁移为 "1"，不应残留 tool_use_id 孤儿 pending 项导致误拦截');
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

const WRITE_TOOLS = ['writeDefinitionProposal'];

test('写工具 PostToolUse 记录 proposalId；正文错 ID 时 Stop 子集校验拦截', async () => {
	const state = createHookRuntimeState();
	const hooks = buildDeclarativeHooks({
		stopHook: {
			enabled: true,
			requireProposalCreatedOnToolSuccess: true,
			requireProposalIdsSubsetOfToolResults: true,
			proposalWriteTools: WRITE_TOOLS,
			maxBlocks: 3,
		},
	}, state);

	await runPostToolUse(hooks, {
		hook_event_name: 'PostToolUse',
		tool_name: 'mcp__matrees__writeDefinitionProposal',
		tool_input: { operate: 'create' },
		tool_response: {
			proposalId: '2082760430044221440',
			definitionId: '2082760430044221441',
			proposalCreatedTag:
				'<proposal_created proposalId="2082760430044221440" entityType="definition" operateType="create" title="后室档案与技术"/>',
		},
		tool_use_id: 'call_write_1',
	});

	assert.ok(state.proposalIdsFromWriteTools.has('2082760430044221440'));

	const blocked = await runStopHook(
		hooks,
		state,
		'说明\n<proposal_created proposalId="2082760430044221442" entityType="definition" operateType="create" title="后室档案与技术"/>\n<next>继续</next>',
	);
	assert.equal(blocked.decision, 'block');
	assert.ok(blocked.reason?.includes('2082760430044221442'));
});

test('正文 proposalId 与写工具结果一致时 Stop 子集校验放行', async () => {
	const state = createHookRuntimeState();
	const hooks = buildDeclarativeHooks({
		stopHook: {
			enabled: true,
			requireProposalCreatedOnToolSuccess: true,
			requireProposalIdsSubsetOfToolResults: true,
			proposalWriteTools: WRITE_TOOLS,
		},
	}, state);

	await runPostToolUse(hooks, {
		hook_event_name: 'PostToolUse',
		tool_name: 'writeDefinitionProposal',
		tool_response: JSON.stringify({
			proposalId: '2082760430044221440',
			proposalCreatedTag:
				'<proposal_created proposalId="2082760430044221440" entityType="definition" operateType="create" title="t"/>',
		}),
		tool_use_id: 'call_write_2',
	});

	const allowed = await runStopHook(
		hooks,
		state,
		'说明\n<proposal_created proposalId="2082760430044221440" entityType="definition" operateType="create" title="t"/>\n<next>继续</next>',
	);
	assert.deepEqual(allowed, {});
});

function buildProposalStopHooks(state) {
	return buildDeclarativeHooks({
		stopHook: {
			enabled: true,
			requireNextTag: true,
			requireProposalCreatedOnToolSuccess: true,
			requireProposalIdsSubsetOfToolResults: true,
			proposalWriteTools: WRITE_TOOLS,
			maxBlocks: 3,
		},
	}, state);
}

async function recordWriteToolSuccess(hooks, proposalId) {
	await runPostToolUse(hooks, {
		hook_event_name: 'PostToolUse',
		tool_name: 'mcp__matrees__writeDefinitionProposal',
		tool_input: { operate: 'create' },
		tool_response: {
			proposalId,
			proposalCreatedTag: `<proposal_created proposalId="${proposalId}" entityType="definition" operateType="create" title="t"/>`,
		},
		tool_use_id: `call_${proposalId}`,
	});
}

test('标记按增量交付输出在中间步骤、收尾消息只做总结时 Stop Hook 放行（生产 #153884 重复输出根因）', async () => {
	const state = createHookRuntimeState();
	const hooks = buildProposalStopHooks(state);

	// 契约要求「完成一个输出一个」：每次写工具成功后立刻在当前步骤正文输出对应标记
	for (const pid of ['1001', '1002', '1003']) {
		await recordWriteToolSuccess(hooks, pid);
		await runMessageDisplay(hooks, `msg_${pid}`, [
			`已创建条目 ${pid}。\n`,
			`<proposal_created proposalId="${pid}" entityType="definition" operateType="create" title="t"/>\n`,
		]);
	}

	// 收尾消息只有总结与快捷建议，不再重复汇总标记
	await runMessageDisplay(hooks, 'msg_final', ['本轮共创建 3 个提案。\n', '<next>继续补充</next>\n']);

	const allowed = await runStopHook(hooks, state, '本轮共创建 3 个提案。\n<next>继续补充</next>');
	assert.deepEqual(
		allowed,
		{},
		'修复前只看 last_assistant_message，会误判「缺少 <proposal_created> 标记」并反复 block，迫使模型汇总重发标记与 <next>',
	);
});

test('本轮任一助手正文都未输出标记时 Stop Hook 仍拦截', async () => {
	const state = createHookRuntimeState();
	const hooks = buildProposalStopHooks(state);

	await recordWriteToolSuccess(hooks, '1001');
	await runMessageDisplay(hooks, 'msg_1', ['已创建条目，但忘了输出标记。\n']);

	const blocked = await runStopHook(hooks, state, '已创建条目。\n<next>继续</next>');
	assert.equal(blocked.decision, 'block');
	assert.ok(blocked.reason?.includes('<proposal_created>'));
});

test('SDK assistant 消息路径同样登记标记事实（sidecar / stateless 不依赖 MessageDisplay）', async () => {
	const state = createHookRuntimeState();
	const hooks = buildProposalStopHooks(state);

	await recordWriteToolSuccess(hooks, '1001');
	recordAssistantMessageForHooks(state, {
		type: 'assistant',
		message: {
			content: [
				{ type: 'text', text: '已创建条目。\n<proposal_created proposalId="1001" entityType="definition" operateType="create" title="t"/>' },
				{ type: 'tool_use', id: 'call_x', name: 'other', input: {} },
			],
		},
	});

	const allowed = await runStopHook(hooks, state, '总结。\n<next>继续</next>');
	assert.deepEqual(allowed, {});
});

test('每轮重置后不残留上一轮的标记事实', async () => {
	const state = createHookRuntimeState();
	const hooks = buildProposalStopHooks(state);

	recordAssistantMessageForHooks(state, {
		type: 'assistant',
		message: {
			content: [{ type: 'text', text: '<proposal_created proposalId="1001" entityType="definition" operateType="create" title="t"/>' }],
		},
	});
	assert.equal(state.assistantBodySawProposalTag, true);

	resetHookRuntimeStateForNextTurn(state);
	assert.equal(state.assistantBodySawProposalTag, false);
	assert.equal(state.assistantBodyProposalIds.size, 0);

	// 新一轮写工具成功但全程未输出标记 → 应拦截，而非被上一轮事实放行
	await recordWriteToolSuccess(hooks, '2002');
	const blocked = await runStopHook(hooks, state, '总结。\n<next>继续</next>');
	assert.equal(blocked.decision, 'block');
	assert.ok(blocked.reason?.includes('<proposal_created>'));
});

test('中间步骤手拼的幻觉 proposalId 也纳入子集校验', async () => {
	const state = createHookRuntimeState();
	const hooks = buildProposalStopHooks(state);

	await recordWriteToolSuccess(hooks, '1001');
	await runMessageDisplay(hooks, 'msg_1', [
		'已创建两个条目。\n',
		'<proposal_created proposalId="1001" entityType="definition" operateType="create" title="t"/>\n',
		'<proposal_created proposalId="9999" entityType="definition" operateType="create" title="t"/>\n',
	]);

	const blocked = await runStopHook(hooks, state, '总结。\n<next>继续</next>');
	assert.equal(blocked.decision, 'block');
	assert.ok(blocked.reason?.includes('9999'));
});
