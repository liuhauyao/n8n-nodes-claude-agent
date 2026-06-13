type UserContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'url'; url: string } };

export type QueuedUserMessage = {
	type: 'user';
	message: { role: 'user'; content: string | UserContentBlock[] };
	parent_tool_use_id: null;
};

export class MessageQueue implements AsyncIterable<QueuedUserMessage> {
	private readonly queue: QueuedUserMessage[] = [];
	private waiters: Array<() => void> = [];
	private closed = false;

	push(message: QueuedUserMessage): void {
		if (this.closed) {
			throw new Error('MessageQueue is closed');
		}
		this.queue.push(message);
		const wake = this.waiters.shift();
		wake?.();
	}

	close(): void {
		this.closed = true;
		for (const wake of this.waiters) wake();
		this.waiters = [];
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<QueuedUserMessage> {
		while (!this.closed || this.queue.length > 0) {
			if (this.queue.length === 0) {
				await new Promise<void>((resolve) => {
					if (this.closed) {
						resolve();
						return;
					}
					this.waiters.push(resolve);
				});
				if (this.closed && this.queue.length === 0) break;
				continue;
			}
			const next = this.queue.shift();
			if (next) yield next;
		}
	}
}

export function createUserMessage(content: string): QueuedUserMessage {
	return {
		type: 'user',
		message: { role: 'user', content },
		parent_tool_use_id: null,
	};
}

export function createUserMessageWithImages(
	text: string,
	imageUrls: string[],
): QueuedUserMessage {
	const blocks: UserContentBlock[] = [];
	const trimmedText = text.trim();
	if (trimmedText) {
		blocks.push({ type: 'text', text: trimmedText });
	}
	for (const url of imageUrls) {
		blocks.push({
			type: 'image',
			source: { type: 'url', url },
		});
	}

	if (!blocks.length) {
		return createUserMessage('');
	}
	if (blocks.length === 1 && blocks[0].type === 'text') {
		return createUserMessage(blocks[0].text);
	}

	return {
		type: 'user',
		message: { role: 'user', content: blocks },
		parent_tool_use_id: null,
	};
}
