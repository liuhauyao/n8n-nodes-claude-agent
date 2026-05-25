import { redisDel, redisGet, redisSetEx, type RedisCredentials } from './redisClient';
import type { AgentHitlPendingRecord } from './hitlTypes';

const PENDING_KEY_PREFIX = 'agent:hitl:pending:';
const DEFAULT_PENDING_TTL_SECONDS = 60 * 60 * 24;

export async function getHitlPending(
	credentials: RedisCredentials,
	sessionId: string,
): Promise<AgentHitlPendingRecord | undefined> {
	if (!sessionId) return undefined;
	const value = await redisGet(credentials, `${PENDING_KEY_PREFIX}${sessionId}`);
	if (!value) return undefined;
	try {
		return JSON.parse(value) as AgentHitlPendingRecord;
	} catch {
		return undefined;
	}
}

export async function setHitlPending(
	credentials: RedisCredentials,
	sessionId: string,
	record: AgentHitlPendingRecord,
	ttlSeconds = DEFAULT_PENDING_TTL_SECONDS,
): Promise<void> {
	if (!sessionId) return;
	await redisSetEx(
		credentials,
		`${PENDING_KEY_PREFIX}${sessionId}`,
		JSON.stringify(record),
		ttlSeconds,
	);
}

export async function clearHitlPending(
	credentials: RedisCredentials,
	sessionId: string,
): Promise<void> {
	if (!sessionId) return;
	await redisDel(credentials, `${PENDING_KEY_PREFIX}${sessionId}`);
}
