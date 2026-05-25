const HITL_DISABLED_SYSTEM_APPEND = `

---

# HITL 禁用

**禁止**使用 AskQuestion / UpdateTodos 工具；需要用户做离散选择时在正文列出选项或使用 \`<next>\`。`;

export function readHitlEnabled(raw: boolean | string | number | undefined): boolean {
	if (typeof raw === 'boolean') return raw;
	if (typeof raw === 'number') return raw !== 0;
	if (typeof raw === 'string') {
		const normalized = raw.trim().toLowerCase();
		return normalized !== 'false' && normalized !== '0' && normalized !== 'no';
	}
	return true;
}

export function applyHitlSystemMessage(systemMessage: string, hitlEnabled: boolean): string {
	if (hitlEnabled) return systemMessage;
	const base = systemMessage?.trim() ?? '';
	return base ? `${base}${HITL_DISABLED_SYSTEM_APPEND}` : HITL_DISABLED_SYSTEM_APPEND.trim();
}
