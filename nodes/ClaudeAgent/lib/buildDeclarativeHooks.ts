/** 声明式 Hooks JSON → SDK programmatic hooks（无 eval） */
import type { HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export interface DeclarativePreToolUseConfig {
	maxCallsPerTurn?: number;
	perToolMaxCalls?: Record<string, number>;
}

export interface DeclarativePostToolUseConfig {
	logToOutput?: boolean;
}

export interface DeclarativeHooksConfig {
	preToolUse?: DeclarativePreToolUseConfig;
	postToolUse?: DeclarativePostToolUseConfig;
}

export interface HookRuntimeState {
	toolCallCount: number;
	perToolCounts: Map<string, number>;
	postToolLogs: Array<{ tool: string; ok: boolean; error?: string }>;
}

export function parseHooksJson(raw: string | undefined): DeclarativeHooksConfig | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as DeclarativeHooksConfig;
		if (!parsed || typeof parsed !== 'object') return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function createHookRuntimeState(): HookRuntimeState {
	return {
		toolCallCount: 0,
		perToolCounts: new Map(),
		postToolLogs: [],
	};
}

export function buildDeclarativeHooks(
	config: DeclarativeHooksConfig | undefined,
	state: HookRuntimeState,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
	if (!config?.preToolUse && !config?.postToolUse) return undefined;

	const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
	const preConfig = config.preToolUse;

	if (preConfig) {
		const maxCallsPerTurn = preConfig.maxCallsPerTurn;
		const perToolMaxCalls = preConfig.perToolMaxCalls ?? {};

		hooks.PreToolUse = [
			{
				hooks: [
					async (input: HookInput): Promise<HookJSONOutput> => {
						const toolName = String((input as { tool_name?: unknown }).tool_name ?? '');
						state.toolCallCount += 1;

						if (typeof maxCallsPerTurn === 'number' && maxCallsPerTurn > 0) {
							if (state.toolCallCount > maxCallsPerTurn) {
								return {
									hookSpecificOutput: {
										hookEventName: 'PreToolUse',
										permissionDecision: 'deny',
										permissionDecisionReason: `Tool call limit exceeded (${maxCallsPerTurn} per turn)`,
									},
								};
							}
						}

						for (const [pattern, limit] of Object.entries(perToolMaxCalls)) {
							if (typeof limit !== 'number' || limit <= 0) continue;
							if (!matchesToolPattern(toolName, pattern)) continue;
							const current = (state.perToolCounts.get(pattern) ?? 0) + 1;
							state.perToolCounts.set(pattern, current);
							if (current > limit) {
								return {
									hookSpecificOutput: {
										hookEventName: 'PreToolUse',
										permissionDecision: 'deny',
										permissionDecisionReason: `Tool "${toolName}" call limit exceeded (${limit} per turn)`,
									},
								};
							}
						}

						return {
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								permissionDecision: 'allow',
							},
						};
					},
				],
			},
		];
	}

	if (config.postToolUse?.logToOutput) {
		hooks.PostToolUse = [
			{
				hooks: [
					async (input: HookInput): Promise<HookJSONOutput> => {
						state.postToolLogs.push({
							tool: String((input as { tool_name?: unknown }).tool_name ?? ''),
							ok: true,
						});
						return {};
					},
				],
			},
		];
	}

	return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function matchesToolPattern(toolName: string, pattern: string): boolean {
	if (pattern === toolName) return true;
	if (pattern.endsWith('*')) {
		return toolName.startsWith(pattern.slice(0, -1));
	}
	return toolName.includes(pattern);
}
