import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

import { listClaudeProviderCredentialsFromDatabase } from './listClaudeProviderCredentials';

export async function getClaudeProviderCredentials(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	try {
		const credentials = await listClaudeProviderCredentialsFromDatabase();

		if (credentials.length === 0) {
			return [
				{
					name: 'No Claude Provider credentials — create one under Credentials',
					value: '',
				},
			];
		}

		return credentials.map((credential) => ({
			name: credential.name,
			value: credential.id,
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [
			{
				name: `Failed to load Claude Provider credentials (${message})`,
				value: '',
			},
		];
	}
}
