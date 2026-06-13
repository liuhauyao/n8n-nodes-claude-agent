import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	anthropicThinkingToOpenAiExtras,
	extractOpenAiReasoningText,
	createOpenAiStreamToAnthropicTranslator,
} from '../scripts/lib/openAiReasoningConvert.mjs';
import { anthropicToOpenAiRequest } from '../scripts/lib/anthropicOpenAiConvert.mjs';

describe('openAiReasoningConvert', () => {
	it('maps Anthropic thinking enabled to agnes chat_template_kwargs', () => {
		assert.deepEqual(
			anthropicThinkingToOpenAiExtras({ type: 'enabled', budget_tokens: 2048 }),
			{ chat_template_kwargs: { enable_thinking: true } },
		);
	});

	it('ignores disabled thinking', () => {
		assert.deepEqual(anthropicThinkingToOpenAiExtras({ type: 'disabled' }), {});
		assert.deepEqual(anthropicThinkingToOpenAiExtras(undefined), {});
	});

	it('extracts reasoning_content and reasoning fields', () => {
		assert.equal(
			extractOpenAiReasoningText({ reasoning_content: 'step one' }),
			'step one',
		);
		assert.equal(extractOpenAiReasoningText({ reasoning: 'step two' }), 'step two');
		assert.equal(extractOpenAiReasoningText({ content: 'ignore' }), '');
	});

	it('extracts reasoning_details array', () => {
		assert.equal(
			extractOpenAiReasoningText({
				reasoning_details: [{ text: 'a' }, { content: 'b' }],
			}),
			'ab',
		);
	});

	it('forwards thinking in anthropicToOpenAiRequest', () => {
		const req = anthropicToOpenAiRequest({
			model: 'agnes-2.0-flash',
			max_tokens: 512,
			thinking: { type: 'enabled', budget_tokens: 2048 },
			messages: [{ role: 'user', content: 'hello' }],
		});
		assert.deepEqual(req.chat_template_kwargs, { enable_thinking: true });
	});

	it('streams reasoning before text as thinking_delta', () => {
		const events = [];
		const translator = createOpenAiStreamToAnthropicTranslator((chunk) => events.push(chunk));

		translator.processDelta({ reasoning_content: 'think ' });
		translator.processDelta({ reasoning_content: 'more' });
		translator.processDelta({ content: 'answer' });
		translator.finish();

		const joined = events.join('');
		assert.match(joined, /content_block_start.*"type":"thinking"/s);
		assert.match(joined, /thinking_delta.*"thinking":"think "/);
		assert.match(joined, /thinking_delta.*"thinking":"more"/);
		assert.match(joined, /text_delta.*"text":"answer"/);
		assert.match(joined, /content_block_stop.*"index":0/s);
		assert.match(joined, /content_block_stop.*"index":1/s);
	});
});
