import MarkdownIt from 'markdown-it';
import { externalLink, promptParts } from '@brigadir/core';
import { htmlComments } from './markdown-comments';
import type { FindCommands } from './mention-editor';
/**
 * One Markdown renderer for the chat and the document preview (spec/editor#markdown-views): no raw HTML.
 * spec/chat#web-links: a bare `http(s)://` or `mailto:` address becomes a link; nothing without a scheme does — `docs/x.md`,
 * `package-lock.json` and `www.host` stay text, so the path check (spec/chat#file-links) still makes them editor links.
 * HTML comments are not shown, as on GitHub (`markdown-comments.ts`).
 */
export function createMarkdown(breaks: boolean) {
	const instance = new MarkdownIt({ html: false, linkify: true, breaks }).use(htmlComments);
	instance.linkify
		.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false })
		.add('ftp:', null)
		.add('//', null);
	// Remote media never load implicitly from an agent's answer or a document.
	instance.renderer.rules.image = (tokens, index) =>
		instance.utils.escapeHtml(tokens[index]?.content ?? '');
	// The address is the hint of a link the system browser opens, as in the preview (spec/editor#markdown-views).
	instance.renderer.rules.link_open = (tokens, index, options, _env, self) => {
		const token = tokens[index]!,
			href = externalLink(token.attrGet('href'));
		if (href && !token.attrGet('title')) token.attrSet('title', href);
		return self.renderToken(tokens, index, options);
	};
	return instance;
}
export const markdown = createMarkdown(false);
export type MarkdownTokens = ReturnType<typeof markdown.parse>;

/**
 * spec/composer#formatting: the person's message in the log is rendered by the same renderer as an answer, with one difference: a single line break is a
 * line break, as it was in the plain text (`white-space: pre-wrap`) and as it was typed. A mention token (`@[att:…]`, spec/composer#mentions) is not
 * Markdown: it becomes an empty slot the log fills with the pill or the thumbnail; inside a code span or a block it stays the text it is.
 */
export const userMarkdown = createMarkdown(true);
userMarkdown.inline.ruler.before('text', 'prompt_token', (state, silent) => {
	if (state.src.charCodeAt(state.pos) !== 0x40 || state.src.charCodeAt(state.pos + 1) !== 0x5b)
		return false;
	const match = /^@\[(?:att|task|model):[^\]\s]{1,300}\]/.exec(
		state.src.slice(state.pos, state.pos + 340)
	);
	if (!match || promptParts(match[0]).every((part) => part.kind !== 'token')) return false;
	if (!silent) {
		const token = state.push('html_inline', '', 0);
		token.content = `<span data-prompt-token="${userMarkdown.utils.escapeHtml(match[0])}"></span>`;
	}
	state.pos += match[0].length;
	return true;
});

/** What the person's message is rendered with: the known `/` names and the class that marks them (spec/composer#slash-highlight). */
export type UserMarkdownEnv = { commands?: FindCommands; className?: string; started?: boolean };
// spec/composer#slash-highlight: a name the `/` list knows is marked as in the composer; a code span or block is not text here and stays as it is.
// Only the first text of the message is its start, where a built-in command counts.
userMarkdown.renderer.rules.text = (tokens, index, _options, env: UserMarkdownEnv) => {
	const content = tokens[index]!.content,
		escape = userMarkdown.utils.escapeHtml,
		start = !env.started;
	env.started = true;
	const words = env.commands?.(content, start) ?? [];
	if (!words.length) return escape(content);
	let html = '',
		at = 0;
	for (const word of words) {
		html +=
			escape(content.slice(at, word.from)) +
			`<span class="${escape(env.className ?? '')}" data-slash-command title="${escape(word.title)}">${escape(content.slice(word.from, word.to))}</span>`;
		at = word.to;
	}
	return html + escape(content.slice(at));
};
