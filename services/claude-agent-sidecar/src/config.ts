export interface SidecarConfig {
	host: string;
	port: number;
	idleTimeoutMs: number;
	maxSessions: number;
	messageTimeoutMs: number;
	redis: {
		host: string;
		port: number;
		user?: string;
		password?: string;
		database?: number;
	};
}

export function loadSidecarConfig(): SidecarConfig {
	const idleTimeoutMs = Number(process.env.SIDECAR_IDLE_TIMEOUT_MS ?? 1_800_000);
	return {
		host: process.env.CLAUDE_AGENT_SIDECAR_HOST?.trim() || '127.0.0.1',
		port: Number(process.env.CLAUDE_AGENT_SIDECAR_PORT ?? 18_790),
		idleTimeoutMs,
		maxSessions: Number(process.env.SIDECAR_MAX_SESSIONS ?? 64),
		messageTimeoutMs: Number(process.env.SIDECAR_MESSAGE_TIMEOUT_MS ?? 600_000),
		redis: {
			host: process.env.REDIS_HOST?.trim() || '127.0.0.1',
			port: Number(process.env.REDIS_PORT ?? 6379),
			user: process.env.REDIS_USER?.trim() || undefined,
			password: process.env.REDIS_PASSWORD?.trim() || undefined,
			database: process.env.REDIS_DB ? Number(process.env.REDIS_DB) : undefined,
		},
	};
}

export function liveSessionTtlSeconds(idleTimeoutMs: number): number {
	return Math.ceil(idleTimeoutMs / 1000) + 300;
}
