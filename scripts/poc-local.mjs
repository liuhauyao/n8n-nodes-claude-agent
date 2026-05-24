/**
 * Local Claude Agent SDK smoke test.
 *
 * Required env:
 *   ANTHROPIC_API_KEY
 *   POC_CWD
 *
 * Optional:
 *   POC_QUERY
 *   POC_SYSTEM_MESSAGE
 *   POC_MODEL
 *   ANTHROPIC_BASE_URL
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;
const cwd = process.env.POC_CWD?.trim();
const userQuery = process.env.POC_QUERY ?? 'List the top-level files in this directory using Glob.';
const systemMessage = process.env.POC_SYSTEM_MESSAGE?.trim() ?? '';
const model = process.env.POC_MODEL?.trim() || process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-20250514';

if (!apiKey || !cwd) {
	console.error('Missing ANTHROPIC_API_KEY or POC_CWD');
	process.exit(1);
}

const prompt = [systemMessage, userQuery].filter(Boolean).join('\n\n---\n\n');

for await (const message of query({
	prompt,
	options: {
		cwd,
		model,
		includePartialMessages: true,
		allowedTools: ['Glob', 'Read'],
		settingSources: ['project'],
		env: {
			...process.env,
			ANTHROPIC_API_KEY: apiKey,
			ANTHROPIC_MODEL: model,
		},
	},
})) {
	const record = message;
	if (record.type === 'stream_event') {
		const event = record.event;
		if (event?.type === 'content_block_delta') {
			const delta = event.delta;
			if (delta?.type === 'text_delta' && delta.text) {
				process.stdout.write(delta.text);
			}
		}
	}
	if (record.type === 'result') {
		process.stdout.write('\n\n--- result ---\n');
		process.stdout.write(JSON.stringify({
			subtype: record.subtype,
			session_id: record.session_id,
			result: record.result?.slice?.(0, 500),
		}, null, 2));
		process.stdout.write('\n');
		if (record.subtype === 'error') process.exit(2);
	}
}
