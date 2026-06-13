import { importHostModule } from '../../shared/lib/resolveHostModule';

export type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

let sdkPromise: Promise<ClaudeSdkModule> | undefined;

export async function loadClaudeSdk(): Promise<ClaudeSdkModule> {
	if (!sdkPromise) {
		sdkPromise = importHostModule<ClaudeSdkModule>('@anthropic-ai/claude-agent-sdk').catch((error: unknown) => {
			sdkPromise = undefined;
			throw formatClaudeSdkLoadError(error);
		});
	}
	return sdkPromise;
}

function formatClaudeSdkLoadError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('Cannot resolve "@anthropic-ai/claude-agent-sdk"')) {
		return new Error(
			'@anthropic-ai/claude-agent-sdk is not installed in ~/.n8n/nodes. '
				+ 'Add "@anthropic-ai/claude-agent-sdk" and the matching "@anthropic-ai/claude-agent-sdk-linux-x64" '
				+ '(or your platform binary) to ~/.n8n/nodes/package.json, run npm install, then restart n8n. '
				+ 'See n8n-nodes-claude-sdk-agent README → Host dependencies.',
		);
	}
	return error instanceof Error ? error : new Error(message);
}
