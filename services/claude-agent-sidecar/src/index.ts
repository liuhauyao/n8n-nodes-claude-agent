import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import type { SidecarMessageRequest } from '../../../dist/nodes/ClaudeAgent/lib/sidecarClient';
import { hasUserTurnContent, normalizeImageUrls } from '../../../dist/nodes/ClaudeAgent/lib/userMessageImages';
import type { ClaudeModelConfig } from '../../../dist/nodes/shared/lib/types';
import { loadSidecarConfig } from './config';
import { SessionManager } from './SessionManager';
import { SidecarStreamSink } from './SidecarStreamSink';

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		req.on('end', () => {
			try {
				const text = Buffer.concat(chunks).toString('utf8');
				resolve(JSON.parse(text) as T);
			} catch (error) {
				reject(error);
			}
		});
		req.on('error', reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

function parseSidecarRequest(body: Record<string, unknown>): SidecarMessageRequest {
	const modelConfig = body.modelConfig as ClaudeModelConfig;
	if (!modelConfig?.model) {
		throw new Error('modelConfig.model is required');
	}
	const params = body.params as SidecarMessageRequest['params'];
	if (!params) {
		throw new Error('params is required');
	}
	return {
		chatInput: String(body.chatInput ?? ''),
		imageUrls: normalizeImageUrls(body.imageUrls, String(body.chatInput ?? '')),
		systemMessage: String(body.systemMessage ?? ''),
		modelConfig,
		params,
		useClaudeCodePreset: body.useClaudeCodePreset !== false,
		cwd: String(body.cwd ?? process.cwd()),
		additionalDirectories: Array.isArray(body.additionalDirectories)
			? body.additionalDirectories.map(String)
			: [],
		mcpServers: (body.mcpServers as Record<string, unknown>) ?? {},
		mcpServerNames: Array.isArray(body.mcpServerNames) ? body.mcpServerNames.map(String) : [],
		mcpDisallowedSdk: Array.isArray(body.mcpDisallowedSdk) ? body.mcpDisallowedSdk.map(String) : [],
		mcpAllowedSdk: Array.isArray(body.mcpAllowedSdk) ? body.mcpAllowedSdk.map(String) : [],
		mcpPreApproved: Array.isArray(body.mcpPreApproved) ? body.mcpPreApproved.map(String) : [],
	};
}

async function main(): Promise<void> {
	const config = loadSidecarConfig();
	const manager = new SessionManager(config);
	manager.startIdleEviction();

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
			if (req.method === 'GET' && url.pathname === '/health') {
				sendJson(res, 200, {
					ok: true,
					activeSessions: manager.getActiveSessionCount(),
					pid: process.pid,
				});
				return;
			}

			const sessionMatch = /^\/v1\/sessions\/([^/]+)(?:\/(messages|buffer))?$/.exec(url.pathname);
			if (!sessionMatch) {
				sendJson(res, 404, { error: 'not found' });
				return;
			}

			const businessSessionId = decodeURIComponent(sessionMatch[1]);

			if (req.method === 'DELETE' && !sessionMatch[2]) {
				const aborted = await manager.abortSession(businessSessionId);
				sendJson(res, 200, { aborted });
				return;
			}

			// 断线重连：获取当前轮次已生成文本缓冲
			if (req.method === 'GET' && sessionMatch[2] === 'buffer') {
				const buffer = manager.getSessionBuffer(businessSessionId);
				if (!buffer) {
					sendJson(res, 404, { error: 'session not found' });
					return;
				}
				sendJson(res, 200, buffer);
				return;
			}

			if (req.method === 'POST' && sessionMatch[2] === 'messages') {
				const body = await readJsonBody<Record<string, unknown>>(req);
				const parsed = parseSidecarRequest(body);
				if (!hasUserTurnContent(parsed.chatInput, parsed.imageUrls ?? [])) {
					sendJson(res, 400, { error: 'chatInput is required' });
					return;
				}
				const sessionTtlSeconds = Number(parsed.params.sessionTtlSeconds ?? 604_800);
				const sink = new SidecarStreamSink(res);
				await manager.handleMessage(businessSessionId, parsed, sink, sessionTtlSeconds);
				return;
			}

			sendJson(res, 404, { error: 'not found' });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) {
				sendJson(res, 500, { error: message });
			} else {
				res.end();
			}
		}
	});

	server.listen(config.port, config.host, () => {
		// eslint-disable-next-line no-console
		console.log(`claude-agent-sidecar listening on http://${config.host}:${config.port}`);
	});

	const shutdown = () => {
		manager.stop();
		server.close(() => process.exit(0));
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

void main();
