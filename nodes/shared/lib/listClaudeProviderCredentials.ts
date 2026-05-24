import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveHostModule } from './resolveHostModule';
import {
	buildClaudeProviderTypeInClause,
	buildClaudeProviderTypeInClausePostgres,
	isClaudeProviderCredentialType,
} from './claudeProviderCredentialTypes';

export type ClaudeProviderCredentialListItem = {
	id: string;
	name: string;
	type: string;
};

type SqliteDatabase = {
	all: (
		sql: string,
		params: unknown[],
		callback: (error: Error | null, rows: ClaudeProviderCredentialListItem[]) => void,
	) => void;
	close: (callback?: (error: Error | null) => void) => void;
};

type Sqlite3Module = {
	Database: new (
		filename: string,
		mode?: number,
		callback?: (error: Error | null) => void,
	) => SqliteDatabase;
	OPEN_READONLY: number;
};

type PgPool = {
	query: (
		sql: string,
		params?: unknown[],
	) => Promise<{ rows: ClaudeProviderCredentialListItem[] }>;
	end: () => Promise<void>;
};

type PgModule = {
	Pool: new (config: Record<string, unknown>) => PgPool;
};

function usesPostgres(): boolean {
	return process.env.DB_TYPE === 'postgresdb';
}

function getSqliteDatabasePath(): string {
	if (process.env.DB_SQLITE_DATABASE) {
		return process.env.DB_SQLITE_DATABASE;
	}
	const userFolder = process.env.N8N_USER_FOLDER ?? join(homedir(), '.n8n');
	return join(userFolder, 'database.sqlite');
}

function getCredentialsTableName(): string {
	const prefix = process.env.DB_TABLE_PREFIX ?? '';
	return `${prefix}credentials_entity`;
}

function querySqlite(
	sql: string,
	params: unknown[] = [],
): Promise<ClaudeProviderCredentialListItem[]> {
	return new Promise((resolve, reject) => {
		let sqlite3: Sqlite3Module;
		try {
			sqlite3 = resolveHostModule<Sqlite3Module>('sqlite3');
		} catch (error) {
			reject(error);
			return;
		}

		const dbPath = getSqliteDatabasePath();
		const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openError) => {
			if (openError) {
				reject(openError);
				return;
			}

			db.all(sql, params, (queryError, rows) => {
				db.close(() => {
					if (queryError) {
						reject(queryError);
						return;
					}
					resolve(rows ?? []);
				});
			});
		});
	});
}

async function queryPostgres(
	sql: string,
	params: unknown[] = [],
): Promise<ClaudeProviderCredentialListItem[]> {
	const pg = resolveHostModule<PgModule>('pg');
	const pool = new pg.Pool({
		host: process.env.DB_POSTGRESDB_HOST ?? 'localhost',
		port: Number(process.env.DB_POSTGRESDB_PORT ?? 5432),
		database: process.env.DB_POSTGRESDB_DATABASE,
		user: process.env.DB_POSTGRESDB_USER,
		password: process.env.DB_POSTGRESDB_PASSWORD,
	});
	try {
		const result = await pool.query(sql, params);
		return result.rows ?? [];
	} finally {
		await pool.end();
	}
}

async function queryCredentials(
	sql: string,
	params: unknown[] = [],
): Promise<ClaudeProviderCredentialListItem[]> {
	if (usesPostgres()) {
		return queryPostgres(sql, params);
	}
	return querySqlite(sql, params);
}

function filterClaudeProviderRows(
	rows: ClaudeProviderCredentialListItem[],
): ClaudeProviderCredentialListItem[] {
	return rows.filter(
		(row) => row.id && row.name && isClaudeProviderCredentialType(row.type),
	);
}

export async function listClaudeProviderCredentialsFromDatabase(): Promise<
	ClaudeProviderCredentialListItem[]
> {
	const tableName = getCredentialsTableName();
	if (usesPostgres()) {
		const { clause, params } = buildClaudeProviderTypeInClausePostgres();
		const rows = await queryCredentials(
			`SELECT id, name, type FROM ${tableName} WHERE ${clause} ORDER BY LOWER(name) ASC`,
			params,
		);
		return filterClaudeProviderRows(rows);
	}

	const { clause, params } = buildClaudeProviderTypeInClause();
	const rows = await queryCredentials(
		`SELECT id, name, type FROM "${tableName}" WHERE ${clause} ORDER BY name COLLATE NOCASE ASC`,
		params,
	);
	return filterClaudeProviderRows(rows);
}

export async function findClaudeProviderCredentialById(
	credentialId: string,
): Promise<ClaudeProviderCredentialListItem | null> {
	const trimmedId = credentialId.trim();
	if (!trimmedId) return null;
	const tableName = getCredentialsTableName();

	if (usesPostgres()) {
		const { clause, params } = buildClaudeProviderTypeInClausePostgres(2);
		const rows = await queryCredentials(
			`SELECT id, name, type FROM ${tableName} WHERE id = $1 AND ${clause} LIMIT 1`,
			[trimmedId, ...params],
		);
		return filterClaudeProviderRows(rows)[0] ?? null;
	}

	const { clause, params } = buildClaudeProviderTypeInClause();
	const rows = await queryCredentials(
		`SELECT id, name, type FROM "${tableName}" WHERE id = ? AND ${clause} LIMIT 1`,
		[trimmedId, ...params],
	);
	return filterClaudeProviderRows(rows)[0] ?? null;
}
