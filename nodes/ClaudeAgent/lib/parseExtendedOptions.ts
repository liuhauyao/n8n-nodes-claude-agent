import type { ToolSearchMode } from './readNodeParameters';

export function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function parseJsonArray(raw: string | undefined): unknown[] | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		return Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function buildOutputFormatOption(
	schemaJson: string | undefined,
	schemaName: string | undefined,
): Record<string, unknown> | undefined {
	const schema = parseJsonObject(schemaJson);
	if (!schema) return undefined;
	const name = schemaName?.trim() || 'output';
	return {
		type: 'json_schema',
		json_schema: {
			name,
			strict: true,
			schema,
		},
	};
}

export function applyToolSearchEnv(
	sdkEnv: Record<string, string>,
	toolSearchMode: ToolSearchMode,
): Record<string, string> {
	if (toolSearchMode === 'unset') return sdkEnv;
	return {
		...sdkEnv,
		ENABLE_TOOL_SEARCH: toolSearchMode,
	};
}
