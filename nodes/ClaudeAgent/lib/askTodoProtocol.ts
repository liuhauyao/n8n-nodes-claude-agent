export interface AskQuestionOption {
	id: string;
	label: string;
}

export interface AskQuestionItem {
	id: string;
	prompt: string;
	options: AskQuestionOption[];
	allowMultiple?: boolean;
}

export function isAskQuestionToolName(rawName: string): boolean {
	return rawName === 'AskQuestion' || rawName === 'askQuestion';
}

export function isUpdateTodosToolName(rawName: string): boolean {
	return rawName === 'UpdateTodos' || rawName === 'updateTodos' || rawName === 'TodoWrite';
}

function normalizeQuestionOption(raw: unknown): AskQuestionOption | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const id = typeof record.id === 'string' ? record.id : '';
	const label = typeof record.label === 'string' ? record.label : id;
	if (!id) return null;
	return { id, label };
}

function normalizeQuestionItem(raw: unknown): AskQuestionItem | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const id = typeof record.id === 'string' ? record.id : '';
	const prompt =
		(typeof record.prompt === 'string' && record.prompt) ||
		(typeof record.question === 'string' && record.question) ||
		id;
	if (!id || !prompt) return null;
	const optionsRaw = record.options;
	if (!Array.isArray(optionsRaw)) return null;
	const options = optionsRaw
		.map(normalizeQuestionOption)
		.filter((item): item is AskQuestionOption => item !== null);
	if (options.length === 0) return null;
	return {
		id,
		prompt,
		options,
		allowMultiple: record.allow_multiple === true || record.allowMultiple === true,
	};
}

export function parseAskQuestionArgs(args: unknown): {
	title?: string;
	questions: AskQuestionItem[];
} | null {
	if (!args) return null;
	let record: Record<string, unknown>;
	if (typeof args === 'string') {
		try {
			record = JSON.parse(args) as Record<string, unknown>;
		} catch {
			return null;
		}
	} else if (typeof args === 'object' && !Array.isArray(args)) {
		record = args as Record<string, unknown>;
	} else {
		return null;
	}
	const nested = record.input ?? record.arguments ?? record.params;
	if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
		const nestedParsed = parseAskQuestionArgs(nested);
		if (nestedParsed) return nestedParsed;
	}
	const questionsRaw = record.questions;
	if (!Array.isArray(questionsRaw)) return null;
	const questions = questionsRaw
		.map(normalizeQuestionItem)
		.filter((item): item is AskQuestionItem => item !== null);
	if (questions.length === 0) return null;
	const title = typeof record.title === 'string' ? record.title : undefined;
	return { title, questions };
}

export function parseUpdateTodosArgs(
	args: unknown,
): Array<{ id: string; content: string; status: string }> | null {
	if (!args) return null;
	let record: Record<string, unknown>;
	if (typeof args === 'string') {
		try {
			record = JSON.parse(args) as Record<string, unknown>;
		} catch {
			return null;
		}
	} else if (typeof args === 'object' && !Array.isArray(args)) {
		record = args as Record<string, unknown>;
	} else {
		return null;
	}
	const nested = record.input ?? record.arguments ?? record.todos ?? record.items;
	const list = Array.isArray(nested) ? nested : Array.isArray(record.todos) ? record.todos : null;
	if (!list) return null;
	const items = list
		.map((raw) => {
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
			const item = raw as Record<string, unknown>;
			const id = typeof item.id === 'string' ? item.id : '';
			const content =
				(typeof item.content === 'string' && item.content) ||
				(typeof item.text === 'string' && item.text) ||
				id;
			const status = typeof item.status === 'string' ? item.status : 'pending';
			if (!id) return null;
			return { id, content, status };
		})
		.filter((item): item is { id: string; content: string; status: string } => item !== null);
	return items.length > 0 ? items : null;
}
