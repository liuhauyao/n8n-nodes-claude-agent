import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	anthropicImageBlockToOpenAi,
	anthropicImageSourceToOpenAiUrl,
	anthropicMessagesToOpenAi,
	anthropicToOpenAiRequest,
	anthropicUserContentBlocksToOpenAi,
} from '../scripts/lib/anthropicOpenAiConvert.mjs';

describe('anthropicOpenAiConvert', () => {
	it('maps Anthropic url image to OpenAI image_url', () => {
		const block = {
			type: 'image',
			source: { type: 'url', url: 'https://example.com/a.png' },
		};
		assert.deepEqual(anthropicImageBlockToOpenAi(block), {
			type: 'image_url',
			image_url: { url: 'https://example.com/a.png' },
		});
	});

	it('maps Anthropic base64 image to data URL', () => {
		const url = anthropicImageSourceToOpenAiUrl({
			type: 'base64',
			media_type: 'image/png',
			data: 'abc123',
		});
		assert.equal(url, 'data:image/png;base64,abc123');
	});

	it('preserves text + image block order for user messages', () => {
		const openAi = anthropicMessagesToOpenAi([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'describe this' },
					{
						type: 'image',
						source: { type: 'url', url: 'https://example.com/a.png' },
					},
				],
			},
		]);
		assert.deepEqual(openAi, [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'describe this' },
					{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
				],
			},
		]);
	});

	it('uses string content when only text blocks are present', () => {
		assert.equal(
			anthropicUserContentBlocksToOpenAi([{ type: 'text', text: 'hello' }]),
			'hello',
		);
	});

	it('maps image-only user turn to image_url array', () => {
		const openAi = anthropicMessagesToOpenAi([
			{
				role: 'user',
				content: [
					{
						type: 'image',
						source: { type: 'url', url: 'https://example.com/a.png' },
					},
				],
			},
		]);
		assert.deepEqual(openAi, [
			{
				role: 'user',
				content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
			},
		]);
	});

	it('keeps tool_result separate from multimodal user content', () => {
		const openAi = anthropicMessagesToOpenAi([
			{
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_1',
						content: '{"ok":true}',
					},
					{ type: 'text', text: 'next step' },
					{
						type: 'image',
						source: { type: 'url', url: 'https://example.com/b.png' },
					},
				],
			},
		]);
		assert.deepEqual(openAi, [
			{ role: 'tool', tool_call_id: 'toolu_1', content: '{"ok":true}' },
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'next step' },
					{ type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
				],
			},
		]);
	});

	it('builds full chat/completions request with images', () => {
		const req = anthropicToOpenAiRequest({
			model: 'agnes-2.0-flash',
			max_tokens: 1024,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'what is in the image?' },
						{
							type: 'image',
							source: {
								type: 'url',
								url: 'http://oss.matrees.cn/dev/feedbackImage/1.png',
							},
						},
					],
				},
			],
		});
		assert.equal(req.model, 'agnes-2.0-flash');
		assert.deepEqual(req.messages[0].content, [
			{ type: 'text', text: 'what is in the image?' },
			{
				type: 'image_url',
				image_url: { url: 'http://oss.matrees.cn/dev/feedbackImage/1.png' },
			},
		]);
	});
});
