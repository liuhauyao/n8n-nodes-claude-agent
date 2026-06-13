export type UserImageContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'url'; url: string } };

const USER_IMAGE_URL_RE =
	/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)|\[用户上传[^\]]*]\((https?:\/\/[^)\s]+)\)/g;

export function extractImageUrlsFromMarkdown(content: string): string[] {
	const urls: string[] = [];
	let match: RegExpExecArray | null;
	const re = new RegExp(USER_IMAGE_URL_RE.source, 'g');
	while ((match = re.exec(content)) !== null) {
		const url = match[1] || match[2];
		if (url) urls.push(url);
	}
	return urls;
}

export function stripImageMarkdown(content: string): string {
	return content
		.replace(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/g, '')
		.replace(/\[用户上传[^\]]*]\((https?:\/\/[^)\s]+)\)/g, '')
		.trim();
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

export function normalizeImageUrls(raw: unknown, chatInput?: string): string[] {
	const urls: string[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const url = String(item ?? '').trim();
			if (isHttpUrl(url)) urls.push(url);
		}
	} else if (typeof raw === 'string' && raw.trim()) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				return normalizeImageUrls(parsed, chatInput);
			}
		} catch {
			if (isHttpUrl(raw.trim())) urls.push(raw.trim());
		}
	}
	if (chatInput) {
		for (const url of extractImageUrlsFromMarkdown(chatInput)) {
			if (!urls.includes(url)) urls.push(url);
		}
	}
	return urls;
}

export function buildUserMessageContent(
	text: string,
	imageUrls: string[],
): string | UserImageContentBlock[] {
	const trimmedText = text.trim();
	if (!imageUrls.length) return trimmedText;

	const blocks: UserImageContentBlock[] = [];
	if (trimmedText) {
		blocks.push({ type: 'text', text: trimmedText });
	}
	for (const url of imageUrls) {
		blocks.push({
			type: 'image',
			source: { type: 'url', url },
		});
	}
	if (blocks.length === 1 && blocks[0].type === 'text') {
		return blocks[0].text;
	}
	return blocks;
}

export type SdkUserMessageLike = {
	type: 'user';
	message: { role: 'user'; content: string | UserImageContentBlock[] };
	parent_tool_use_id: null;
};

export function buildSdkUserMessage(text: string, imageUrls: string[]): SdkUserMessageLike {
	return {
		type: 'user',
		message: {
			role: 'user',
			content: buildUserMessageContent(text, imageUrls),
		},
		parent_tool_use_id: null,
	};
}

export async function* buildSingleTurnUserPrompt(
	text: string,
	imageUrls: string[],
): AsyncGenerator<SdkUserMessageLike> {
	yield buildSdkUserMessage(text, imageUrls);
}

export function resolveUserTurnInput(
	chatInput: string,
	imageUrls: string[],
): string | AsyncIterable<SdkUserMessageLike> {
	const userText = stripImageMarkdown(chatInput);
	const urls = normalizeImageUrls(imageUrls, chatInput);
	if (!urls.length) return chatInput.trim();
	return buildSingleTurnUserPrompt(userText, urls);
}

export function hasUserTurnContent(chatInput: string, imageUrls: unknown): boolean {
	const urls = normalizeImageUrls(imageUrls, chatInput);
	const text = stripImageMarkdown(chatInput);
	return Boolean(text) || urls.length > 0;
}
