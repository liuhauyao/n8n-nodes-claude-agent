import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildUserMessageContent,
	extractImageUrlsFromMarkdown,
	hasUserTurnContent,
	normalizeImageUrls,
	resolveUserTurnInput,
	stripImageMarkdown,
} from '../dist/nodes/ClaudeAgent/lib/userMessageImages.js';

test('extractImageUrlsFromMarkdown 解析用户上传链接', () => {
	const content = '你好\n\n[用户上传图片](https://oss.example.com/a.png)';
	assert.deepEqual(extractImageUrlsFromMarkdown(content), ['https://oss.example.com/a.png']);
});

test('stripImageMarkdown 移除图片 markdown 保留正文', () => {
	const content = '描述一下\n\n[用户上传图片1](https://oss.example.com/a.png)';
	assert.equal(stripImageMarkdown(content), '描述一下');
});

test('buildUserMessageContent 图文混合为 content blocks', () => {
	const blocks = buildUserMessageContent('参考这张图', ['https://oss.example.com/a.png']);
	assert.equal(Array.isArray(blocks), true);
	assert.equal(blocks[0].type, 'text');
	assert.equal(blocks[1].type, 'image');
	assert.equal(blocks[1].source.url, 'https://oss.example.com/a.png');
});

test('resolveUserTurnInput 无图时返回纯文本 prompt', () => {
	const prompt = resolveUserTurnInput('hello', []);
	assert.equal(prompt, 'hello');
});

test('resolveUserTurnInput 有图时返回 AsyncIterable', () => {
	const prompt = resolveUserTurnInput('看图', ['https://oss.example.com/a.png']);
	assert.equal(typeof prompt[Symbol.asyncIterator], 'function');
});

test('hasUserTurnContent 纯图片消息有效', () => {
	assert.equal(
		hasUserTurnContent('[用户上传图片](https://oss.example.com/a.png)', ['https://oss.example.com/a.png']),
		true,
	);
	assert.equal(hasUserTurnContent('   ', []), false);
});

test('normalizeImageUrls 合并 body 与 markdown', () => {
	assert.deepEqual(
		normalizeImageUrls(['https://oss.example.com/b.png'], '[用户上传图片](https://oss.example.com/a.png)'),
		['https://oss.example.com/b.png', 'https://oss.example.com/a.png'],
	);
});
