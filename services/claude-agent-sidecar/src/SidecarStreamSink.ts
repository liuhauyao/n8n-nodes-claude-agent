import type { ServerResponse } from 'node:http';

import { encodeClaudeStreamPayload, type ClaudeStreamPayload } from '../../../dist/nodes/ClaudeAgent/lib/claudeStreamProtocol';
import { SIDECAR_DONE_MARKER, type SidecarDoneMeta } from '../../../dist/nodes/ClaudeAgent/lib/sidecarTypes';
import { ClaudeStreamAssembler } from '../../../dist/nodes/ClaudeAgent/lib/streamAssembler';

export class SidecarStreamSink {
	private readonly assembler: ClaudeStreamAssembler;
	private ended = false;

	constructor(private readonly res: ServerResponse) {
		this.assembler = new ClaudeStreamAssembler({
			onBegin: async () => undefined,
			onStructured: async (jsonContent) => {
				this.writeRaw(jsonContent);
			},
			onEnd: async () => undefined,
		});
	}

	async begin(): Promise<void> {
		if (!this.res.headersSent) {
			this.res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			});
		}
		await this.assembler.begin();
	}

	getAssembler(): ClaudeStreamAssembler {
		return this.assembler;
	}

	async consumeSdkMessage(message: unknown): Promise<void> {
		await this.assembler.consume(message);
	}

	async finish(meta: Omit<SidecarDoneMeta, 'output' | 'textOutput' | 'usage'> & {
		claudeSessionId?: string;
	}): Promise<void> {
		if (this.ended) return;
		this.ended = true;
		const done: SidecarDoneMeta = {
			output: this.assembler.getOutput(),
			textOutput: this.assembler.getTextOutput(),
			usage: this.assembler.getUsage(),
			claudeSessionId: meta.claudeSessionId ?? this.assembler.getSessionId(),
			sessionContinuation: meta.sessionContinuation,
			sessionRuntime: meta.sessionRuntime,
			previousClaudeSessionId: meta.previousClaudeSessionId,
			model: meta.model,
			provider: meta.provider,
		};
		this.writeLine({ [SIDECAR_DONE_MARKER]: done });
		this.res.end();
	}

	async fail(message: string): Promise<void> {
		if (this.ended) return;
		await this.emit({ kind: 'status', phase: 'error', message });
		await this.finish({
			sessionContinuation: 'error',
			sessionRuntime: 'sidecar',
		});
	}

	async emit(payload: ClaudeStreamPayload): Promise<void> {
		this.writeRaw(encodeClaudeStreamPayload(payload));
	}

	private writeRaw(jsonContent: string): void {
		this.res.write(`data: ${jsonContent}\n\n`);
	}

	private writeLine(payload: Record<string, unknown>): void {
		this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
	}
}
