import type { ModelEntry, ProviderType } from './types';

export const STATIC_MODEL_CATALOG: Record<ProviderType, ModelEntry[]> = {
	anthropic_direct: [
		{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
		{ id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
		{ id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
		{ id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
	],
	anthropic_gateway: [
		{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (gateway)' },
		{ id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet (gateway)' },
	],
	bedrock: [
		{ id: 'anthropic.claude-3-7-sonnet-20250219-v1:0', name: 'Claude 3.7 Sonnet (Bedrock)' },
		{ id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2 (Bedrock)' },
		{ id: 'anthropic.claude-3-5-haiku-20241022-v1:0', name: 'Claude 3.5 Haiku (Bedrock)' },
	],
	vertex: [
		{ id: 'claude-3-7-sonnet@20250219', name: 'Claude 3.7 Sonnet (Vertex)' },
		{ id: 'claude-3-5-sonnet@20241022', name: 'Claude 3.5 Sonnet (Vertex)' },
	],
	foundry: [
		{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (Foundry)' },
	],
	aws_platform: [
		{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (AWS Platform)' },
	],
};

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, '');
}

async function fetchAnthropicModels(apiKey: string, baseUrl?: string): Promise<ModelEntry[]> {
	const root = normalizeBaseUrl(baseUrl ?? 'https://api.anthropic.com');
	const response = await fetch(`${root}/v1/models`, {
		headers: {
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		},
	});
	if (!response.ok) {
		throw new Error(`Models API ${response.status}: ${response.statusText}`);
	}
	const body = (await response.json()) as { data?: Array<{ id?: string; display_name?: string }> };
	const models = (body.data ?? [])
		.filter((m) => m?.id)
		.map((m) => ({
			id: m.id!,
			name: m.display_name ? `${m.display_name} (${m.id})` : m.id!,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (models.length === 0) {
		throw new Error('Models API returned an empty list');
	}
	return models;
}

export function resolveModelId(
	credentials: { defaultModel?: string; customModel?: string },
	override?: string,
): string {
	const trimmedOverride = override?.trim();
	if (trimmedOverride) return trimmedOverride;
	const custom = credentials.customModel?.trim();
	if (custom) return custom;
	const fallback = credentials.defaultModel?.trim();
	if (fallback) return fallback;
	return STATIC_MODEL_CATALOG.anthropic_direct[0]?.id ?? 'claude-sonnet-4-20250514';
}

export async function listModels(
	providerType: ProviderType,
	credentials: {
		apiKey?: string;
		baseUrl?: string;
		defaultModel?: string;
		customModel?: string;
	},
): Promise<ModelEntry[]> {
	const staticList = STATIC_MODEL_CATALOG[providerType] ?? STATIC_MODEL_CATALOG.anthropic_direct;
	try {
		if (
			(providerType === 'anthropic_direct' || providerType === 'anthropic_gateway')
			&& credentials.apiKey?.trim()
		) {
			const dynamic = await fetchAnthropicModels(
				credentials.apiKey.trim(),
				providerType === 'anthropic_gateway' ? credentials.baseUrl : undefined,
			);
			return dynamic;
		}
	} catch {
		// fall through to static catalog
	}
	const custom = credentials.customModel?.trim();
	if (custom && !staticList.some((m) => m.id === custom)) {
		return [{ id: custom, name: `${custom} (custom)` }, ...staticList];
	}
	return staticList;
}

export function modelsToOptions(models: ModelEntry[]): Array<{ name: string; value: string; description?: string }> {
	return models.map((m) => ({
		name: m.name,
		value: m.id,
		description: m.description,
	}));
}
