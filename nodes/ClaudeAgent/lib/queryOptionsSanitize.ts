/** 从 buildQueryOptions 结果中剥离内部字段，供 SDK query() 使用 */
export function sanitizeQueryOptionsForSdk(
	queryOptions: Record<string, unknown>,
): Record<string, unknown> {
	const { __hookRuntimeState: _ignored, ...sdkOptions } = queryOptions as Record<string, unknown> & {
		__hookRuntimeState?: unknown;
	};
	return sdkOptions;
}

export function linkAbortSignal(signal?: AbortSignal): AbortController | undefined {
	if (!signal) return undefined;
	const controller = new AbortController();
	if (signal.aborted) {
		controller.abort(signal.reason);
		return controller;
	}
	signal.addEventListener('abort', () => {
		controller.abort(signal.reason);
	}, { once: true });
	return controller;
}
