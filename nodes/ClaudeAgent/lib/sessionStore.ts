import { redisGet, redisSetEx, type RedisCredentials } from './redisClient';
import type { StoredSessionRecord } from '../../shared/lib/types';

const SESSION_KEY_PREFIX = 'claude-agent:session:';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

export type { RedisCredentials };

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
