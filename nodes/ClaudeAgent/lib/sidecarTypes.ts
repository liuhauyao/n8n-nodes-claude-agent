import type { SessionRuntimeMode } from '../../shared/lib/types';

export interface SidecarDoneMeta {
	output: string;
	textOutput: string;
	claudeSessionId?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		costUsd?: number;
	};
	sessionContinuation: string;
	sessionRuntime: SessionRuntimeMode | 'sidecar' | 'stateless-fallback';
	previousClaudeSessionId?: string;
	model?: string;
	provider?: string;
}

export const SIDECAR_DONE_MARKER = '__sidecar_done__';
