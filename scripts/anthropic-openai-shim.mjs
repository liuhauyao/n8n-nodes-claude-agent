#!/usr/bin/env node
/**
 * Anthropic Messages API → OpenAI Chat Completions 轻量桥接。
 * 供 Claude Agent SDK 对接仅 OpenAI Chat Completions 兼容的上游网关。
 *
 * 上游地址与 Key 由请求头传入（与 n8n Claude Provider openai_compatible_gateway 凭据配合）：
 *   X-Claude-Agent-Upstream-Url
 *   X-Claude-Agent-Upstream-Authorization
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import {
	anthropicToOpenAiRequest,
	extractOpenAiReasoningText,
	extractTextContent,
} from './lib/anthropicOpenAiConvert.mjs';
import {
	createOpenAiStreamToAnthropicTranslator,
	sseEvent,
} from './lib/openAiReasoningConvert.mjs';

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

/** 从 OpenAI Chat Completions 响应或 SSE chunk 提取 token 用量 */
function extractOpenAiUsage(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const usage = raw.usage;
	if (!usage || typeof usage !== 'object') return null;

	const input =
		usage.prompt_tokens ??
		usage.input_tokens ??
		usage.promptTokens ??
		usage.inputTokens;
	const output =
		usage.completion_tokens ??
		usage.output_tokens ??
		usage.completionTokens ??
		usage.outputTokens;

	if (typeof input !== 'number' && typeof output !== 'number') return null;

	return {
		input_tokens: typeof input === 'number' ? input : 0,
		output_tokens: typeof output === 'number' ? output : 0,
	};
}

/** 流式 chunk 可能重复上报，取较大值作为累计量 */
function mergeStreamUsage(current, next) {
	if (!next) return current;
	if (!current) return { ...next };
	return {
		input_tokens: Math.max(current.input_tokens, next.input_tokens),
		output_tokens: Math.max(current.output_tokens, next.output_tokens),
	};
}

function openAiToAnthropicResponse(openAiBody, model) {
	const choice = openAiBody.choices?.[0] ?? {};
	const message = choice.message ?? {};
	const content = [];

	const reasoning = extractOpenAiReasoningText(message);
	if (reasoning) {
		content.push({ type: 'thinking', thinking: reasoning });
	}

	const text =
		typeof message.content === 'string'
			? message.content
			: extractTextContent(message.content);
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

	const translator = createOpenAiStreamToAnthropicTranslator((chunk) => res.write(chunk));

	const reader = Readable.fromWeb(upstreamRes.body);
	let buffer = '';
	let streamUsage = null;

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

			streamUsage = mergeStreamUsage(streamUsage, extractOpenAiUsage(parsed));

			const delta = parsed.choices?.[0]?.delta ?? {};
			translator.processDelta(delta);
		}
	}

	const stopReason = translator.finish();
	const finalUsage = streamUsage ?? { input_tokens: 0, output_tokens: 0 };
	res.write(
		sseEvent('message_delta', {
			type: 'message_delta',
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: {
				input_tokens: finalUsage.input_tokens,
				output_tokens: finalUsage.output_tokens,
			},
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
			jsonResponse(res, 200, {
				ok: true,
				service: 'anthropic-openai-shim',
				image_convert_ok: true,
				reasoning_convert_ok: true,
			});
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
