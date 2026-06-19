import {
	anthropicThinkingToOpenAiExtras,
	extractOpenAiReasoningText,
} from './openAiReasoningConvert.mjs';

export { anthropicThinkingToOpenAiExtras, extractOpenAiReasoningText };

export function extractTextContent(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('');
}

export function anthropicImageSourceToOpenAiUrl(source) {
	if (!source || typeof source !== 'object') return undefined;
	if (source.type === 'url' && typeof source.url === 'string' && source.url.trim()) {
		return source.url.trim();
	}
	if (source.type === 'base64' && typeof source.data === 'string' && source.data.trim()) {
		const mediaType =
			typeof source.media_type === 'string' && source.media_type.trim()
				? source.media_type.trim()
				: 'image/jpeg';
		const data = source.data.trim();
		if (data.startsWith('data:')) return data;
		return `data:${mediaType};base64,${data}`;
	}
	return undefined;
}

export function anthropicImageBlockToOpenAi(block) {
	const url = anthropicImageSourceToOpenAiUrl(block?.source);
	if (!url) return undefined;
	return { type: 'image_url', image_url: { url } };
}

/**
 * Anthropic user content blocks → OpenAI Chat Completions content.
 * Preserves block order (text / image interleaving).
 */
export function anthropicUserContentBlocksToOpenAi(blocks) {
	const openAiBlocks = [];
	for (const block of blocks ?? []) {
		if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
			openAiBlocks.push({ type: 'text', text: block.text });
			continue;
		}
		if (block?.type === 'image') {
			const imageBlock = anthropicImageBlockToOpenAi(block);
			if (imageBlock) openAiBlocks.push(imageBlock);
		}
	}
	if (openAiBlocks.length === 0) return undefined;
	if (openAiBlocks.length === 1 && openAiBlocks[0].type === 'text') {
		return openAiBlocks[0].text;
	}
	return openAiBlocks;
}

export function anthropicSystemToOpenAi(system) {
	if (!system) return [];
	if (typeof system === 'string') {
		return system.trim() ? [{ role: 'system', content: system }] : [];
	}
	if (!Array.isArray(system)) return [];
	const text = system
		.map((block) => (block?.type === 'text' ? block.text : ''))
		.filter(Boolean)
		.join('\n');
	return text ? [{ role: 'system', content: text }] : [];
}

export function anthropicMessagesToOpenAi(messages) {
	const openAi = [];
	for (const message of messages ?? []) {
		const role = message?.role;
		const content = message?.content;

		if (role === 'user') {
			if (typeof content === 'string') {
				openAi.push({ role: 'user', content });
				continue;
			}
			if (Array.isArray(content)) {
				const toolResults = content.filter((block) => block?.type === 'tool_result');
				const other = content.filter((block) => block?.type !== 'tool_result');
				for (const result of toolResults) {
					openAi.push({
						role: 'tool',
						tool_call_id: result.tool_use_id,
						content:
							typeof result.content === 'string'
								? result.content
								: JSON.stringify(result.content ?? ''),
					});
				}
				const openAiContent = anthropicUserContentBlocksToOpenAi(other);
				if (openAiContent !== undefined) {
					openAi.push({ role: 'user', content: openAiContent });
				}
			}
			continue;
		}

		if (role === 'assistant') {
			if (typeof content === 'string') {
				openAi.push({ role: 'assistant', content });
				continue;
			}
			if (Array.isArray(content)) {
				const text = extractTextContent(content);
				const toolUses = content.filter((block) => block?.type === 'tool_use');
				const entry = { role: 'assistant', content: text || null };
				if (toolUses.length > 0) {
					entry.tool_calls = toolUses.map((tool) => ({
						id: tool.id,
						type: 'function',
						function: {
							name: tool.name,
							arguments: JSON.stringify(tool.input ?? {}),
						},
					}));
				}
				openAi.push(entry);
			}
		}
	}

	return openAi;
}

export function anthropicToolsToOpenAi(tools) {
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description ?? '',
			parameters: tool.input_schema ?? { type: 'object', properties: {} },
		},
	}));
}

export function anthropicToOpenAiRequest(body) {
	const messages = [
		...anthropicSystemToOpenAi(body.system),
		...anthropicMessagesToOpenAi(body.messages),
	];
	const openAi = {
		model: body.model,
		messages,
		max_tokens: body.max_tokens,
		stream: Boolean(body.stream),
	};
	const tools = anthropicToolsToOpenAi(body.tools);
	if (tools) openAi.tools = tools;
	if (typeof body.temperature === 'number') openAi.temperature = body.temperature;
	if (typeof body.top_p === 'number') openAi.top_p = body.top_p;
	if (openAi.stream) {
		openAi.stream_options = { include_usage: true };
	}

	const thinkingExtras = anthropicThinkingToOpenAiExtras(body.thinking);
	if (thinkingExtras.chat_template_kwargs) {
		openAi.chat_template_kwargs = thinkingExtras.chat_template_kwargs;
	}

	return openAi;
}
