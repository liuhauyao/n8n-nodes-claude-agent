import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildUtf8GuardCanUseTool,
	containsUtf8ReplacementChar,
	shouldGuardMcpToolInput,
	UTF8_REPLACEMENT_CHAR,
	UTF8_REPLACEMENT_DENY_MESSAGE,
} from '../dist/nodes/ClaudeAgent/lib/utf8ReplacementGuard.js';

test('containsUtf8ReplacementChar 检测字符串与嵌套对象', () => {
	assert.equal(containsUtf8ReplacementChar('意识上传'), false);
	assert.equal(containsUtf8ReplacementChar(`将${UTF8_REPLACEMENT_CHAR}识上传`), true);
	assert.equal(
		containsUtf8ReplacementChar({
			content: { type: 'doc', content: [{ type: 'text', text: `专猎逃${UTF8_REPLACEMENT_CHAR}实验体` }] },
		}),
		true,
	);
});

test('shouldGuardMcpToolInput 仅匹配写提案类 MCP 工具', () => {
	assert.equal(shouldGuardMcpToolInput('mcp__matrees__createDefinitionProposal'), true);
	assert.equal(shouldGuardMcpToolInput('mcp__matrees__updateEventProposal'), true);
	assert.equal(shouldGuardMcpToolInput('mcp__matrees__keywordSearchWorld'), false);
	assert.equal(shouldGuardMcpToolInput('Read'), false);
});

test('buildUtf8GuardCanUseTool 乱码时 deny 并允许重试', async () => {
	const guard = buildUtf8GuardCanUseTool({ maxDenials: 2 });
	const clean = await guard('mcp__matrees__createDefinitionProposal', {
		title: '测试',
		content: { type: 'doc', content: [] },
	});
	assert.deepEqual(clean, { behavior: 'allow' });

	const dirty = await guard('mcp__matrees__createDefinitionProposal', {
		title: '伊甸计划',
		content: { type: 'doc', content: [{ type: 'text', text: `将${UTF8_REPLACEMENT_CHAR}识上传` }] },
	});
	assert.equal(dirty.behavior, 'deny');
	assert.equal(dirty.message, UTF8_REPLACEMENT_DENY_MESSAGE);

	const search = await guard('mcp__matrees__semanticSearchWorld', {
		query: `检${UTF8_REPLACEMENT_CHAR}索`,
	});
	assert.deepEqual(search, { behavior: 'allow' });
});

test('buildUtf8GuardCanUseTool 超过 maxDenials 后换提示', async () => {
	const guard = buildUtf8GuardCanUseTool({ maxDenials: 1 });
	const dirtyInput = { content: `x${UTF8_REPLACEMENT_CHAR}y` };
	await guard('mcp__matrees__updateDefinitionProposal', dirtyInput);
	const second = await guard('mcp__matrees__updateDefinitionProposal', dirtyInput);
	assert.equal(second.behavior, 'deny');
	assert.match(second.message, /多次重试/);
});
