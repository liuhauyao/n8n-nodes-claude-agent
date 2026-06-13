import { redisDel, redisGet, redisSetEx, type RedisCredentials } from './redisClient';
import type { IDataObject } from 'n8n-workflow';
import type { LiveSessionMeta, StoredSessionRecord } from '../../shared/lib/types';

const SESSION_KEY_PREFIX = 'claude-agent:session:';
const LIVE_SESSION_KEY_PREFIX = 'claude-agent:live:';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

export type { RedisCredentials };

export function readRedisCredentials(raw: IDataObject): RedisCredentials {
	return {
		host: String(raw.host ?? 'localhost'),
		port: Number(raw.port ?? 6379),
		user: raw.user ? String(raw.user) : undefined,
		password: raw.password ? String(raw.password) : undefined,
		database: raw.database !== undefined ? Number(raw.database) : 0,
	};
}

export async function getStoredSession(
	credentials: RedisCredentials,
	sessionId: string,
): Promise<StoredSessionRecord | undefined> {
	if (!sessionId) return undefined;
	const value = await redisGet(credentials, `${SESSION_KEY_PREFIX}${sessionId}`);
	if (!value) return undefined;
	try {
		return JSON.parse(value) as StoredSessionRecord;
	} catch {
		return { claudeSessionId: value, modelConfig: { providerType: 'anthropic_direct', profileName: 'legacy', model: '' } };
	}
}

export async function setStoredSession(
	credentials: RedisCredentials,
	sessionId: string,
	record: StoredSessionRecord,
	ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
	if (!sessionId || !record.claudeSessionId) return;
	await redisSetEx(
		credentials,
		`${SESSION_KEY_PREFIX}${sessionId}`,
		JSON.stringify(record),
		ttlSeconds,
	);
}

export async function getLiveSessionMeta(
	credentials: RedisCredentials,
	sessionId: string,
): Promise<LiveSessionMeta | undefined> {
	if (!sessionId) return undefined;
	const value = await redisGet(credentials, `${LIVE_SESSION_KEY_PREFIX}${sessionId}`);
	if (!value) return undefined;
	try {
		return JSON.parse(value) as LiveSessionMeta;
	} catch {
		return undefined;
	}
}

export async function setLiveSessionMeta(
	credentials: RedisCredentials,
	sessionId: string,
	record: LiveSessionMeta,
	ttlSeconds: number,
): Promise<void> {
	if (!sessionId) return;
	await redisSetEx(
		credentials,
		`${LIVE_SESSION_KEY_PREFIX}${sessionId}`,
		JSON.stringify(record),
		ttlSeconds,
	);
}

export async function deleteLiveSessionMeta(
	credentials: RedisCredentials,
	sessionId: string,
): Promise<void> {
	if (!sessionId) return;
	await redisDel(credentials, `${LIVE_SESSION_KEY_PREFIX}${sessionId}`);
}
