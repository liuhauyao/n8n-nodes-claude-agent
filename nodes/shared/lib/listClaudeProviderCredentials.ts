import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveHostModule } from './resolveHostModule';
import {
	buildClaudeProviderTypeInClause,
	CLAUDE_PROVIDER_BASE_TYPE,
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

export async function listClaudeProviderCredentialsFromDatabase(): Promise<
	ClaudeProviderCredentialListItem[]
> {
	const tableName = getCredentialsTableName();
	const { clause, params } = buildClaudeProviderTypeInClause();
	const rows = await querySqlite(
		`SELECT id, name, type FROM "${tableName}" WHERE ${clause} ORDER BY name COLLATE NOCASE ASC`,
		params,
	);
	return rows.filter(
		(row) => row.id && row.name && isClaudeProviderCredentialType(row.type),
	);
}

export async function findClaudeProviderCredentialById(
	credentialId: string,
): Promise<ClaudeProviderCredentialListItem | null> {
	const trimmedId = credentialId.trim();
	if (!trimmedId) return null;
	const tableName = getCredentialsTableName();
	const { clause, params } = buildClaudeProviderTypeInClause();
	const rows = await querySqlite(
		`SELECT id, name, type FROM "${tableName}" WHERE id = ? AND ${clause} LIMIT 1`,
		[trimmedId, ...params],
	);
	const row = rows[0];
	if (!row?.id || !row.name || !isClaudeProviderCredentialType(row.type)) return null;
	return row;
}
