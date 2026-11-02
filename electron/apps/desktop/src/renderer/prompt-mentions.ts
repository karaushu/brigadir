/** spec/tasks#sheet-layout: a mention lives in the prompt text as `@token`. The text is already what goes to the agent
 *  (English template names, paths from the repo root); the localized name is only on screen. */
export type MentionKind = 'file' | 'crew' | 'agent';
export type MentionOption = {
	kind: MentionKind;
	token: string;
	label: string;
	tail?: string;
	icon?: 'claude' | 'openai' | 'helmet' | 'person' | 'folder';
};

/** The tail of the line before the caret that opens the menu: `@` at a word start and letters without spaces. */
export const mentionTrigger = /(^|\s)@([^\s@]*)$/;
/** A token in the text. A trailing period or comma is sentence punctuation, not part of the path. */
export const mentionToken = /@([^\s@]+?)(?=[.,;:!?)]*(?:\s|$))/g;

/** A file is anything that looks like a path: it has `/` or an extension. The rest is recognised only by a known name. */
export function looksLikeFile(token: string): boolean {
	return token.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(token);
}

export function mentionLabel(
	token: string,
	known: ReadonlyMap<string, MentionOption>
): { kind: MentionKind; label: string; icon?: MentionOption['icon'] } | null {
	const option = known.get(token);
	if (option)
		return {
			kind: option.kind,
			label: option.label,
			...(option.icon ? { icon: option.icon } : {}),
		};
	// spec/composer#mention-menu: `@src/ui/` — a folder, by its trailing `/`.
	if (token.length > 1 && token.endsWith('/'))
		return { kind: 'file', label: token.slice(0, -1).split('/').at(-1)!, icon: 'folder' };
	if (looksLikeFile(token)) return { kind: 'file', label: token.split('/').at(-1) || token };
	return null;
}

export const agentMentions: MentionOption[] = [
	{ kind: 'agent', token: 'Claude', label: 'Claude', icon: 'claude' },
	{ kind: 'agent', token: 'Codex', label: 'Codex', icon: 'openai' },
];

/** Menu item filter: a case-insensitive substring of the token or the label. */
export function matchOptions(options: readonly MentionOption[], query: string): MentionOption[] {
	const needle = query.toLocaleLowerCase();
	return options.filter(
		(option) =>
			!needle ||
			option.token.toLocaleLowerCase().includes(needle) ||
			option.label.toLocaleLowerCase().includes(needle)
	);
}
