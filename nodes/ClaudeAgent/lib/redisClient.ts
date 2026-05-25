import { createConnection, type Socket } from 'node:net';

export interface RedisCredentials {
	host: string;
	port: number;
	user?: string;
	password?: string;
	database?: number;
}

function encodeCommand(...parts: string[]): Buffer {
	const lines = [`*${parts.length}`];
	for (const part of parts) {
		lines.push(`$${Buffer.byteLength(part, 'utf8')}`, part);
	}
	return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

function isCompleteResponse(buffer: Buffer): boolean {
	const text = buffer.toString('utf8');
	if (text.startsWith('+') || text.startsWith('-')) {
		return text.includes('\r\n');
	}
	if (text.startsWith('$')) {
		const match = /^\$(-?\d+)\r\n/.exec(text);
		if (!match) return false;
		const length = Number.parseInt(match[1], 10);
		if (length < 0) return true;
		const headerLength = match[0].length;
		return buffer.length >= headerLength + length + 2;
	}
	return false;
}

async function readFullResponse(socket: Socket): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			const buffer = Buffer.concat(chunks);
			if (isCompleteResponse(buffer)) {
				socket.off('data', onData);
				resolve(buffer);
			}
		};
		socket.on('data', onData);
		socket.once('error', reject);
		socket.once('end', () => reject(new Error('Redis connection closed unexpectedly')));
	});
}

function parseBulkString(buffer: Buffer): string | null {
	const text = buffer.toString('utf8');
	if (text.startsWith('$')) {
		const match = /^\$(-?\d+)\r\n/.exec(text);
		if (!match) throw new Error('Invalid Redis bulk string response');
		const length = Number.parseInt(match[1], 10);
		if (length < 0) return null;
		const headerLength = match[0].length;
		return buffer.toString('utf8', headerLength, headerLength + length);
	}
	if (text.startsWith('+')) {
		const lineEnd = text.indexOf('\r\n');
		return lineEnd >= 0 ? text.slice(1, lineEnd) : text.slice(1);
	}
	if (text.startsWith('-')) {
		const lineEnd = text.indexOf('\r\n');
		const message = lineEnd >= 0 ? text.slice(1, lineEnd) : text.slice(1);
		throw new Error(`Redis error: ${message}`);
	}
	throw new Error(`Unsupported Redis response: ${text.slice(0, 1)}`);
}

async function runCommand(
	credentials: RedisCredentials,
	...parts: string[]
): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({
			host: credentials.host,
			port: credentials.port,
		});

		socket.once('error', reject);

		socket.once('connect', () => {
			void (async () => {
				try {
					if (credentials.password) {
						if (credentials.user) {
							socket.write(encodeCommand('AUTH', credentials.user, credentials.password));
						} else {
							socket.write(encodeCommand('AUTH', credentials.password));
						}
						parseBulkString(await readFullResponse(socket));
					}
					if (credentials.database !== undefined && credentials.database > 0) {
						socket.write(encodeCommand('SELECT', String(credentials.database)));
						parseBulkString(await readFullResponse(socket));
					}
					socket.write(encodeCommand(...parts));
					resolve(parseBulkString(await readFullResponse(socket)));
				} catch (error) {
					reject(error);
				} finally {
					socket.end();
				}
			})().catch(reject);
		});
	});
}

export async function redisGet(credentials: RedisCredentials, key: string): Promise<string | null> {
	return runCommand(credentials, 'GET', key);
}

export async function redisSetEx(
	credentials: RedisCredentials,
	key: string,
	value: string,
	ttlSeconds: number,
): Promise<void> {
	await runCommand(credentials, 'SET', key, value, 'EX', String(ttlSeconds));
}

export async function redisDel(credentials: RedisCredentials, key: string): Promise<void> {
	await runCommand(credentials, 'DEL', key);
}
