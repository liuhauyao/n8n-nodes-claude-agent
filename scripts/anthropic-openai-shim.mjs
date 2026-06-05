#!/usr/bin/env node
/**
 * Anthropic Messages API → OpenAI Chat Completions 轻量桥接。
 * 供 Claude Agent SDK 对接 Agnes 等仅 OpenAI 兼容的上游。
 *
 * 上游地址与 Key 由请求头传入（与 n8n Claude Provider openai_compatible_gateway 凭据配合）：
 *   X-Claude-Agent-Upstream-Url
 *   X-Claude-Agent-Upstream-Authorization
 */
import http from 'node:http';
import { Readable } from 'node:stream';

const HOST = process.env.CLAUDE_AGENT_SHIM_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CLAUDE_AGENT_SHIM_PORT ?? '18789');

const UPSTREAM_URL_HEADER = 'x-claude-agent-upstream-url';
const UPSTREAM_AUTH_HEADER = 'x-claude-agent-upstream-authorization';

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function jsonResponse(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(payload),
	});
	res.end(payload);
}

function resolveUpstream(req) {
	const upstreamUrl = req.headers[UPSTREAM_URL_HEADER];
	const upstreamAuth = req.headers[UPSTREAM_AUTH_HEADER];
	if (!upstreamUrl || !upstreamAuth) {
		return {
			error: `Missing ${UPSTREAM_URL_HEADER} or ${UPSTREAM_AUTH_HEADER} request headers`,
		};
	}
	return {
		baseUrl: String(upstreamUrl).trim().replace(/\/+$/, ''),
		auth: String(upstreamAuth).trim(),
	};
}

function extractTextContent(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('');
}

function anthropicSystemToOpenAi(system) {
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

function anthropicMessagesToOpenAi(messages) {
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
				const text = extractTextContent(other);
				if (text) openAi.push({ role: 'user', content: text });
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
			continue;
		}
	}

	return openAi;
}

function anthropicToolsToOpenAi(tools) {
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

function anthropicToOpenAiRequest(body) {
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
	return openAi;
}

function mapStopReason(finishReason) {
	switch (finishReason) {
		case 'tool_calls':
			return 'tool_use';
		case 'length':
			return 'max_tokens';
		default:
			return 'end_turn';
	}
}

function openAiToAnthropicResponse(openAiBody, model) {
	const choice = openAiBody.choices?.[0] ?? {};
	const message = choice.message ?? {};
	const content = [];

	const text = typeof message.content === 'string' ? message.content : '';
	if (text) content.push({ type: 'text', text });

	for (const toolCall of message.tool_calls ?? []) {
		let input = {};
		try {
			input = JSON.parse(toolCall.function?.arguments ?? '{}');
		} catch {
			input = {};
		}
		content.push({
			type: 'tool_use',
			id: toolCall.id,
			name: toolCall.function?.name ?? 'tool',
			input,
		});
	}

	return {
		id: openAiBody.id ?? `msg_${Date.now()}`,
		type: 'message',
		role: 'assistant',
		model: openAiBody.model ?? model,
		content: content.length > 0 ? content : [{ type: 'text', text: '' }],
		stop_reason: mapStopReason(choice.finish_reason),
		stop_sequence: null,
		usage: {
			input_tokens: openAiBody.usage?.prompt_tokens ?? 0,
			output_tokens: openAiBody.usage?.completion_tokens ?? 0,
		},
	};
}

function sseEvent(event, data) {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function pipeOpenAiStreamToAnthropic(upstreamRes, res, model) {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
	});

	const messageId = `msg_${Date.now()}`;
	res.write(
		sseEvent('message_start', {
			type: 'message_start',
			message: {
				id: messageId,
				type: 'message',
				role: 'assistant',
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		}),
	);

	let textBlockStarted = false;
	let textBlockIndex = 0;
	const toolBlocks = new Map();

	const reader = Readable.fromWeb(upstreamRes.body);
	let buffer = '';

	for await (const chunk of reader) {
		buffer += chunk.toString('utf8');
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data:')) continue;
			const payload = trimmed.slice(5).trim();
			if (payload === '[DONE]') continue;
			let parsed;
			try {
				parsed = JSON.parse(payload);
			} catch {
				continue;
			}

			const delta = parsed.choices?.[0]?.delta ?? {};
			if (typeof delta.content === 'string' && delta.content.length > 0) {
				if (!textBlockStarted) {
					res.write(
						sseEvent('content_block_start', {
							type: 'content_block_start',
							index: textBlockIndex,
							content_block: { type: 'text', text: '' },
						}),
					);
					textBlockStarted = true;
				}
				res.write(
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
					block = {
						blockIndex: textBlockStarted ? textBlockIndex + 1 + index : index,
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
					res.write(
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
					res.write(
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
	}

	if (textBlockStarted) {
		res.write(
			sseEvent('content_block_stop', {
				type: 'content_block_stop',
				index: textBlockIndex,
			}),
		);
	}
	for (const block of toolBlocks.values()) {
		if (block.started) {
			res.write(
				sseEvent('content_block_stop', {
					type: 'content_block_stop',
					index: block.blockIndex,
				}),
			);
		}
	}

	const stopReason = toolBlocks.size > 0 ? 'tool_use' : 'end_turn';
	res.write(
		sseEvent('message_delta', {
			type: 'message_delta',
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: { output_tokens: 0 },
		}),
	);
	res.write(sseEvent('message_stop', { type: 'message_stop' }));
	res.end();
}

async function proxyModels(upstream, res) {
	const url = `${upstream.baseUrl}/models`;
	const response = await fetch(url, {
		headers: {
			Accept: 'application/json',
			Authorization: upstream.auth,
		},
	});
	if (!response.ok) {
		jsonResponse(res, response.status, {
			error: `Upstream models ${url} → ${response.status}`,
		});
		return;
	}
	const body = await response.json();
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function handleMessages(req, res, rawBody) {
	const upstream = resolveUpstream(req);
	if (upstream.error) {
		jsonResponse(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: upstream.error } });
		return;
	}

	let anthropicBody;
	try {
		anthropicBody = JSON.parse(rawBody);
	} catch {
		jsonResponse(res, 400, {
			type: 'error',
			error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
		});
		return;
	}

	const openAiBody = anthropicToOpenAiRequest(anthropicBody);
	const url = `${upstream.baseUrl}/chat/completions`;
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			Authorization: upstream.auth,
		},
		body: JSON.stringify(openAiBody),
	});

	if (!openAiBody.stream) {
		const text = await response.text();
		if (!response.ok) {
			res.writeHead(response.status, { 'Content-Type': 'application/json' });
			res.end(text);
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			jsonResponse(res, 502, {
				type: 'error',
				error: { type: 'api_error', message: 'Upstream returned invalid JSON' },
			});
			return;
		}
		jsonResponse(res, 200, openAiToAnthropicResponse(parsed, anthropicBody.model));
		return;
	}

	if (!response.ok) {
		const text = await response.text();
		res.writeHead(response.status, { 'Content-Type': 'application/json' });
		res.end(text);
		return;
	}

	await pipeOpenAiStreamToAnthropic(response, res, anthropicBody.model);
}

function handleCountTokens(res, rawBody) {
	let body;
	try {
		body = JSON.parse(rawBody);
	} catch {
		jsonResponse(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
		return;
	}
	const text = JSON.stringify(body.messages ?? '') + JSON.stringify(body.system ?? '');
	jsonResponse(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
}

const server = http.createServer(async (req, res) => {
	try {
		const path = (req.url ?? '').split('?')[0];
		if (req.method === 'GET' && path === '/health') {
			jsonResponse(res, 200, { ok: true, service: 'anthropic-openai-shim' });
			return;
		}

		if (req.method === 'GET' && path === '/v1/models') {
			const upstream = resolveUpstream(req);
			if (upstream.error) {
				jsonResponse(res, 400, { error: upstream.error });
				return;
			}
			await proxyModels(upstream, res);
			return;
		}

		if (req.method === 'POST' && path === '/v1/messages') {
			const rawBody = await readBody(req);
			await handleMessages(req, res, rawBody);
			return;
		}

		if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
			const rawBody = await readBody(req);
			handleCountTokens(res, rawBody);
			return;
		}

		jsonResponse(res, 404, { error: 'Not found' });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		jsonResponse(res, 500, {
			type: 'error',
			error: { type: 'api_error', message },
		});
	}
});

server.listen(PORT, HOST, () => {
	process.stdout.write(
		`[anthropic-openai-shim] listening on http://${HOST}:${PORT}\n`,
	);
});
