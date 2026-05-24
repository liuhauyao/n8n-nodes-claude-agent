import type { ModelEntry, ProviderType } from './types';

/** Last-resort execution default only — never used to populate model dropdowns. */
const EXECUTION_DEFAULT_MODEL = 'claude-sonnet-4-20250514';

type ProviderAuth = {
	apiKey?: string;
	authToken?: string;
	baseUrl?: string;
	defaultModel?: string;
	customModel?: string;
};

/**
 * Anthropic / Claude Code gateway auth (see LLM gateway configuration):
 * - ANTHROPIC_AUTH_TOKEN → Authorization: Bearer
 * - ANTHROPIC_API_KEY → x-api-key (when no auth token)
 */
function buildAnthropicRequestHeaders(credentials: ProviderAuth): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'anthropic-version': '2023-06-01',
	};
	const authToken = credentials.authToken?.trim();
	const apiKey = credentials.apiKey?.trim();
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`;
	} else if (apiKey) {
		headers['x-api-key'] = apiKey;
	} else {
		throw new Error(
			'API Key or Auth Token is required. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN on the credential.',
		);
	}
	return headers;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, '');
}

function isAnthropicSubpathBase(baseUrl: string): boolean {
	try {
		return normalizeBaseUrl(baseUrl).endsWith('/anthropic');
	} catch {
		return false;
	}
}

function configuredModelsFromCredential(credentials: ProviderAuth): ModelEntry[] {
	const ids = [credentials.customModel, credentials.defaultModel]
		.map((value) => value?.trim())
		.filter((value): value is string => Boolean(value));
	const unique = [...new Set(ids)];
	return unique.map((id) => ({ id, name: `${id} (credential)` }));
}

function mergeConfiguredModels(models: ModelEntry[], credentials: ProviderAuth): ModelEntry[] {
	const merged = [...models];
	for (const entry of configuredModelsFromCredential(credentials)) {
		if (!merged.some((model) => model.id === entry.id)) {
			merged.unshift(entry);
		}
	}
	return merged;
}

function parseModelsResponse(body: unknown): ModelEntry[] {
	if (!body || typeof body !== 'object') {
		throw new Error('Models API returned invalid JSON');
	}
	const record = body as Record<string, unknown>;
	const rawList = Array.isArray(record.data)
		? record.data
		: Array.isArray(record.models)
			? record.models
			: null;
	if (!rawList) {
		throw new Error('Models API response missing data/models array');
	}
	const models = rawList
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return null;
			const model = entry as Record<string, unknown>;
			const id = typeof model.id === 'string' ? model.id.trim() : '';
			if (!id) return null;
			const displayName =
				(typeof model.display_name === 'string' && model.display_name.trim())
				|| (typeof model.displayName === 'string' && model.displayName.trim())
				|| '';
			return {
				id,
				name: displayName ? `${displayName} (${id})` : id,
			} satisfies ModelEntry;
		})
		.filter((entry): entry is ModelEntry => entry !== null)
		.sort((a, b) => a.name.localeCompare(b.name));
	if (models.length === 0) {
		throw new Error('Models API returned an empty list');
	}
	return models;
}

async function fetchModelsFromUrl(url: string, headers: Record<string, string>): Promise<ModelEntry[]> {
	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(`${url} → ${response.status} ${response.statusText}`);
	}
	return parseModelsResponse(await response.json());
}

/**
 * Anthropic official: GET {ANTHROPIC_BASE_URL}/v1/models (LLM gateway + Models API docs).
 * Some Anthropic-compat gateways (Messages under …/anthropic) expose the same key on GET {origin}/v1/models.
 */
async function fetchAnthropicCompatibleModels(credentials: ProviderAuth, baseUrl?: string): Promise<ModelEntry[]> {
	const headers = buildAnthropicRequestHeaders(credentials);
	const errors: string[] = [];
	const attempts: string[] = [];

	const root = normalizeBaseUrl(baseUrl ?? 'https://api.anthropic.com');
	attempts.push(`${root}/v1/models`);

	if (baseUrl && isAnthropicSubpathBase(baseUrl)) {
		try {
			const originUrl = `${new URL(root).origin}/v1/models`;
			if (!attempts.includes(originUrl)) {
				attempts.push(originUrl);
			}
		} catch {
			// ignore invalid URL
		}
	}

	for (const url of attempts) {
		try {
			return await fetchModelsFromUrl(url, headers);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}

	const configured = configuredModelsFromCredential(credentials);
	if (configured.length > 0) {
		return configured;
	}

	throw new Error(errors.join(' | '));
}

/**
 * Anthropic gateway connectivity check when GET /v1/models is unavailable.
 * Uses POST /v1/messages (Anthropic Messages API — required by LLM gateway spec).
 */
export async function verifyAnthropicGatewayConnection(
	credentials: ProviderAuth,
): Promise<void> {
	const baseUrl = credentials.baseUrl?.trim();
	if (!baseUrl) {
		throw new Error('Base URL is required for Anthropic gateway provider');
	}
	const headers = buildAnthropicRequestHeaders(credentials);
	const model =
		credentials.customModel?.trim()
		|| credentials.defaultModel?.trim()
		|| EXECUTION_DEFAULT_MODEL;
	const url = `${normalizeBaseUrl(baseUrl)}/v1/messages`;
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			...headers,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model,
			max_tokens: 1,
			messages: [{ role: 'user', content: 'ping' }],
		}),
	});
	if (response.status === 401 || response.status === 403) {
		throw new Error(
			`API key rejected by gateway (${response.status}). Re-enter a valid key (not the Base URL).`,
		);
	}
	if (response.status === 400 || response.status === 404 || response.status === 422) {
		return;
	}
	if (!response.ok) {
		throw new Error(`${url} → ${response.status} ${response.statusText}`);
	}
}

export async function listModels(
	providerType: ProviderType,
	credentials: ProviderAuth,
): Promise<ModelEntry[]> {
	if (providerType === 'anthropic_direct') {
		const models = await fetchAnthropicCompatibleModels(credentials);
		return mergeConfiguredModels(models, credentials);
	}
	if (providerType === 'anthropic_gateway') {
		if (!credentials.baseUrl?.trim()) {
			throw new Error('Base URL is required for Anthropic gateway provider');
		}
		const models = await fetchAnthropicCompatibleModels(credentials, credentials.baseUrl);
		return mergeConfiguredModels(models, credentials);
	}
	throw new Error(
		`Provider type "${providerType}" does not expose the Anthropic Models API. Set Default Model or Custom Model ID on the credential.`,
	);
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
	return EXECUTION_DEFAULT_MODEL;
}

export function modelsToOptions(models: ModelEntry[]): Array<{ name: string; value: string; description?: string }> {
	return models.map((m) => ({
		name: m.name,
		value: m.id,
		description: m.description,
	}));
}
