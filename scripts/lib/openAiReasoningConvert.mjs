/** OpenAI Chat Completions 推理字段 → Anthropic thinking 互转（agnes / DeepSeek 等网关） */

export function isAnthropicThinkingEnabled(thinking) {
	if (!thinking || typeof thinking !== 'object') return false;
	const type = thinking.type;
	return type === 'enabled' || type === 'adaptive';
}

/**
 * Anthropic thinking → OpenAI 扩展（agnes: chat_template_kwargs.enable_thinking）
 */
export function anthropicThinkingToOpenAiExtras(thinking) {
	if (!isAnthropicThinkingEnabled(thinking)) return {};
	return {
		chat_template_kwargs: { enable_thinking: true },
	};
}

/**
 * 从 OpenAI delta / message 提取推理文本（兼容多网关字段名）
 */
export function extractOpenAiReasoningText(source) {
	if (!source || typeof source !== 'object') return '';

	const direct = [
		source.reasoning_content,
		source.reasoning,
		source.thinking,
	].find((value) => typeof value === 'string' && value.length > 0);
	if (direct) return direct;

	const details = source.reasoning_details;
	if (Array.isArray(details)) {
		const joined = details
			.map((item) => {
				if (!item || typeof item !== 'object') return '';
				if (typeof item.text === 'string') return item.text;
				if (typeof item.content === 'string') return item.content;
				return '';
			})
			.join('');
		if (joined) return joined;
	}

	return '';
}

export function sseEvent(event, data) {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 将 OpenAI 流式 delta 转为 Anthropic SSE 事件（含 thinking_delta）
 */
export function createOpenAiStreamToAnthropicTranslator(emit) {
	let thinkingBlockStarted = false;
	let thinkingBlockClosed = false;
	let textBlockStarted = false;
	let thinkingBlockIndex = 0;
	let textBlockIndex = 0;
	const toolBlocks = new Map();

	function ensureThinkingBlock() {
		if (thinkingBlockStarted) return;
		thinkingBlockStarted = true;
		textBlockIndex = 1;
		emit(
			sseEvent('content_block_start', {
				type: 'content_block_start',
				index: thinkingBlockIndex,
				content_block: { type: 'thinking', thinking: '' },
			}),
		);
	}

	function closeThinkingBlock() {
		if (!thinkingBlockStarted || thinkingBlockClosed) return;
		thinkingBlockClosed = true;
		emit(
			sseEvent('content_block_stop', {
				type: 'content_block_stop',
				index: thinkingBlockIndex,
			}),
		);
	}

	function ensureTextBlock() {
		closeThinkingBlock();
		if (textBlockStarted) return;
		emit(
			sseEvent('content_block_start', {
				type: 'content_block_start',
				index: textBlockIndex,
				content_block: { type: 'text', text: '' },
			}),
		);
		textBlockStarted = true;
	}

	function processDelta(delta) {
		if (!delta || typeof delta !== 'object') return;

		const reasoning = extractOpenAiReasoningText(delta);
		if (reasoning) {
			ensureThinkingBlock();
			emit(
				sseEvent('content_block_delta', {
					type: 'content_block_delta',
					index: thinkingBlockIndex,
					delta: { type: 'thinking_delta', thinking: reasoning },
				}),
			);
		}

		if (typeof delta.content === 'string' && delta.content.length > 0) {
			ensureTextBlock();
			emit(
				sseEvent('content_block_delta', {
					type: 'content_block_delta',
					index: textBlockIndex,
					delta: { type: 'text_delta', text: delta.content },
				}),
			);
		}

		for (const toolDelta of delta.tool_calls ?? []) {
			const index = toolDelta.index ?? 0;
			let block = toolBlocks.get(index);
			if (!block) {
				const baseIndex = thinkingBlockStarted ? 1 : 0;
				const occupied = textBlockStarted ? 1 : 0;
				block = {
					blockIndex: baseIndex + occupied + index,
					id: toolDelta.id ?? `toolu_${Date.now()}_${index}`,
					name: toolDelta.function?.name ?? 'tool',
					arguments: '',
					started: false,
				};
				toolBlocks.set(index, block);
			}
			if (toolDelta.id) block.id = toolDelta.id;
			if (toolDelta.function?.name) block.name = toolDelta.function.name;
			if (typeof toolDelta.function?.arguments === 'string') {
				block.arguments += toolDelta.function.arguments;
			}
			if (!block.started) {
				emit(
					sseEvent('content_block_start', {
						type: 'content_block_start',
						index: block.blockIndex,
						content_block: {
							type: 'tool_use',
							id: block.id,
							name: block.name,
							input: {},
						},
					}),
				);
				block.started = true;
			}
			if (toolDelta.function?.arguments) {
				emit(
					sseEvent('content_block_delta', {
						type: 'content_block_delta',
						index: block.blockIndex,
						delta: {
							type: 'input_json_delta',
							partial_json: toolDelta.function.arguments,
						},
					}),
				);
			}
		}
	}

	function finish() {
		closeThinkingBlock();
		if (textBlockStarted) {
			emit(
				sseEvent('content_block_stop', {
					type: 'content_block_stop',
					index: textBlockIndex,
				}),
			);
		}
		for (const block of toolBlocks.values()) {
			if (block.started) {
				emit(
					sseEvent('content_block_stop', {
						type: 'content_block_stop',
						index: block.blockIndex,
					}),
				);
			}
		}
		return toolBlocks.size > 0 ? 'tool_use' : 'end_turn';
	}

	return { processDelta, finish };
}
