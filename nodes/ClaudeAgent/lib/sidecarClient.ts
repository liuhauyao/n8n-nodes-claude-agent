import type { ClaudeModelConfig } from '../../shared/lib/types';
import type { ClaudeAgentRunParams } from './readNodeParameters';
import { CLAUDE_STREAM_MARKER, type ClaudeStreamPayload } from './claudeStreamProtocol';
import { SIDECAR_DONE_MARKER, type SidecarDoneMeta } from './sidecarTypes';

export interface SidecarMessageRequest {
	chatInput: string;
	imageUrls?: string[];
	systemMessage: string;
	modelConfig: ClaudeModelConfig;
	params: ClaudeAgentRunParams;
	useClaudeCodePreset: boolean;
	cwd: string;
	additionalDirectories: string[];
	mcpServers: Record<string, unknown>;
	mcpServerNames: string[];
	mcpDisallowedSdk: string[];
	mcpAllowedSdk: string[];
	mcpPreApproved: string[];
	/** 模型上下文窗口大小（tokens），0 或 undefined 表示未配置，由后管 AI 模型配置传入 */
	contextWindowSize?: number;
}

export interface SidecarMessageResponseMeta {
	sessionContinuation?: string;
	sessionRuntime?: string;
	previousClaudeSessionId?: string;
	claudeSessionId?: string;
	model?: string;
	provider?: string;
}

const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:18790';

export function normalizeSidecarUrl(raw?: string): string {
	const trimmed = raw?.trim() || process.env.CLAUDE_AGENT_SIDECAR_URL?.trim() || DEFAULT_SIDECAR_URL;
	return trimmed.replace(/\/+$/, '');
}

export function isSidecarUnavailableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	return msg.includes('fetch failed')
		|| msg.includes('econnrefused')
		|| msg.includes('network')
		|| msg.includes('sidecar')
		|| msg.includes('503')
		|| msg.includes('502');
}

export async function postSidecarMessage(
	sidecarUrl: string,
	businessSessionId: string,
	body: SidecarMessageRequest,
	signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
	const url = `${normalizeSidecarUrl(sidecarUrl)}/v1/sessions/${encodeURIComponent(businessSessionId)}/messages`;
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok || !response.body) {
		throw new Error(`Sidecar request failed: HTTP ${response.status} ${response.statusText}`.trim());
	}
	return response.body;
}

export async function deleteSidecarSession(
	sidecarUrl: string,
	businessSessionId: string,
): Promise<void> {
	const url = `${normalizeSidecarUrl(sidecarUrl)}/v1/sessions/${encodeURIComponent(businessSessionId)}`;
	await fetch(url, { method: 'DELETE' }).catch(() => undefined);
}

export function encodeSidecarSseLine(payload: ClaudeStreamPayload): string {
	return `data: ${JSON.stringify({ [CLAUDE_STREAM_MARKER]: payload })}\n\n`;
}

export async function* readSidecarSsePayloads(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ClaudeStreamPayload> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split('\n\n');
			buffer = parts.pop() ?? '';
			for (const part of parts) {
				const line = part.split('\n').find((l) => l.startsWith('data: '));
				if (!line) continue;
				const json = line.slice(6).trim();
				if (!json) continue;
				try {
					const parsed = JSON.parse(json) as Record<string, ClaudeStreamPayload>;
					const payload = parsed[CLAUDE_STREAM_MARKER];
					if (payload) yield payload;
				} catch {
					// 跳过 malformed SSE 行
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export interface SidecarStreamResult {
	done?: SidecarDoneMeta;
}

export async function consumeSidecarStream(
	stream: ReadableStream<Uint8Array>,
	onStructured: (jsonContent: string) => void | Promise<void>,
): Promise<SidecarStreamResult> {
	const result: SidecarStreamResult = {};
	for await (const payload of readSidecarSsePayloads(stream)) {
		await onStructured(JSON.stringify({ [CLAUDE_STREAM_MARKER]: payload }));
	}
	return result;
}

export async function* readSidecarSseEvents(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<
	| { type: 'payload'; payload: ClaudeStreamPayload }
	| { type: 'done'; meta: SidecarDoneMeta }
> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split('\n\n');
			buffer = parts.pop() ?? '';
			for (const part of parts) {
				const line = part.split('\n').find((l) => l.startsWith('data: '));
				if (!line) continue;
				const json = line.slice(6).trim();
				if (!json) continue;
				try {
					const parsed = JSON.parse(json) as Record<string, unknown>;
					if (parsed[SIDECAR_DONE_MARKER]) {
						yield { type: 'done', meta: parsed[SIDECAR_DONE_MARKER] as SidecarDoneMeta };
						continue;
					}
					const payload = parsed[CLAUDE_STREAM_MARKER] as ClaudeStreamPayload | undefined;
					if (payload) yield { type: 'payload', payload };
				} catch {
					// 跳过 malformed SSE 行
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export async function consumeSidecarStreamWithMeta(
	stream: ReadableStream<Uint8Array>,
	onStructured: (jsonContent: string) => void | Promise<void>,
): Promise<SidecarDoneMeta | undefined> {
	let doneMeta: SidecarDoneMeta | undefined;
	for await (const event of readSidecarSseEvents(stream)) {
		if (event.type === 'payload') {
			await onStructured(JSON.stringify({ [CLAUDE_STREAM_MARKER]: event.payload }));
		} else {
			doneMeta = event.meta;
		}
	}
	return doneMeta;
}
