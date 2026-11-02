import { FileLinkedMarkup } from './FileLinks';
import { useEffect, useMemo, useState } from 'react';
import { useTaskState } from './task-state';
import { toastError } from './ui/Toast';
import kitStyles from './ui/Controls.module.css';
import codeStyles from './MarkdownBlock.module.css';
import {
	syntaxFencePath,
	syntaxLanguage,
	t,
	type AgentTask,
	type Locale,
	type SyntaxSnapshot,
	type SyntaxToken,
} from '@brigadir/core';
import { lineTokens, syntaxSegments } from './syntax';
import { fenceDiff, isDiffFence, type FenceDiff } from './fence-diff';
import styles from './Conversation.module.css';
import { markdown, type MarkdownTokens } from './markdown';
export { markdown, type MarkdownTokens };
const key = (language: string, text: string) => `${language}\0${text}`;
/** spec/appearance#evolution-redesign: a block longer than this shows this many lines and «Show all · N» under them. */
export const CODE_FOLD_LINES = 8;
const copyIcon =
	'<svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 3V2.5A.5.5 0 0 0 10.5 2h-8a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5H3"/></svg>';
const copiedIcon =
	'<svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M5.4 8.2 7.2 10l3.4-3.8"/></svg>';
const fileIcon =
	'<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/></svg>';
const gapIcon =
	'<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 5.5 3-3 3 3M5 10.5l3 3 3-3"/></svg>';
/** A diff block's texts to colour: each file's old and new side, by the fence label of its grammar. */
function diffSides(diff: FenceDiff) {
	return diff.parts.flatMap((part) =>
		part.language
			? [
					{ language: part.language, text: part.old.join('\n') },
					{ language: part.language, text: part.new.join('\n') },
				]
			: []
	);
}
/** The chat's markdown look at rest, for a text without code blocks: no file links, no syntax requests through main (the intro's
 *  sample plan, spec/settings-modules-and-onboarding#intro-steps). The same two boxes as `MarkdownBlock`, so the look is the same. */
export function MarkdownStill({ html }: { html: string }) {
	const markup = useMemo(() => ({ __html: html }), [html]);
	return (
		<div>
			<div className={styles.markdown} dangerouslySetInnerHTML={markup} />
		</div>
	);
}
/**
 * `className` adds to the chat's markdown look: the document preview (spec/editor#markdown-views) keeps it and sets its own scale.
 * `message`: the chat message this block belongs to, for the log's Copy message (spec/chat#context-menu).
 * `fold`: a code block longer than 8 lines shows 8 and «Show all · N» (spec/appearance#evolution-redesign); the document preview shows all.
 */
export function MarkdownBlock({
	rowId,
	message,
	html,
	tokens,
	locale,
	task,
	revision,
	className,
	fold = true,
}: {
	rowId: string;
	message?: string;
	html: string;
	tokens: MarkdownTokens;
	locale: Locale;
	task: AgentTask;
	revision: number;
	className?: string | undefined;
	fold?: boolean;
}) {
	const [{ codeShown }, setTask] = useTaskState(task);
	// `Copied` sits in the block's header beside the button, so the log does not jump; a failure is a toast (spec/notifications-slack-notes-and-schedules#message-classes).
	const [copied, setCopied] = useState<number | null>(null);
	useEffect(() => {
		if (copied === null) return;
		const timer = setTimeout(() => setCopied(null), 2000);
		return () => clearTimeout(timer);
	}, [copied]);
	const [parsed, setParsed] = useState<{
		source: string;
		html: string;
		sides: Map<string, SyntaxToken[]>;
		warning: 'large' | 'failed' | null;
	} | null>(null);
	useEffect(() => {
		const fences = tokens.filter((token) => token.type === 'fence');
		const requests: { language: string; text: string }[] = [];
		for (const fence of fences) {
			if (isDiffFence(fence.info)) requests.push(...diffSides(fenceDiff(fence.content)));
			else if (syntaxLanguage(syntaxFencePath(fence.info)))
				requests.push({ language: fence.info.trim().split(/\s+/)[0] ?? '', text: fence.content });
		}
		if (!requests.length) return;
		let active = true;
		const timer = setTimeout(() => {
			void (async () => {
				const results = new Map<string, SyntaxSnapshot>();
				let warning: 'large' | 'failed' | null = null;
				for (const request of requests) {
					if (!active) return;
					const id = key(request.language, request.text);
					if (results.has(id)) continue;
					if (request.language.length > 64 || request.text.length > 1_000_000) {
						warning = 'large';
						continue;
					}
					try {
						const result = await window.brigadir.readCodeSyntax(request.language, request.text);
						if (!active) return;
						results.set(id, result);
						if (result.status === 'failed' || result.status === 'large') warning = result.status;
					} catch {
						warning = 'failed';
					}
				}
				if (!active) return;
				const rendered = markdown.renderer.render(
					tokens,
					{
						...markdown.options,
						highlight: (text, language) => {
							const result = results.get(key(language, text));
							if (!result?.tokens.length) return '';
							return syntaxSegments(text, result.tokens)
								.map((part) =>
									part.kind
										? `<span class="syntax-${part.kind}">${markdown.utils.escapeHtml(part.text)}</span>`
										: markdown.utils.escapeHtml(part.text)
								)
								.join('');
						},
					},
					{}
				);
				const sides = new Map<string, SyntaxToken[]>();
				for (const [id, result] of results) sides.set(id, result.tokens);
				setParsed({ source: html, html: rendered, sides, warning });
			})();
		}, 180);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [html]);
	const current = parsed?.source === html ? parsed : null;
	const markup = useMemo(() => {
		const doc = new DOMParser().parseFromString(current?.html ?? html, 'text/html'),
			codes: string[] = [];
		const button = (action: 'copy' | 'more', index: number, label: string, appearance: string) => {
			const node = doc.createElement('button');
			node.type = 'button';
			node.dataset.codeAction = action;
			node.dataset.codeIndex = String(index);
			node.className = `${kitStyles.button} ${action === 'copy' ? kitStyles.iconButton : ''} ${
				action === 'copy' ? (codeStyles.copy ?? '') : (codeStyles.more ?? '')
			}`;
			node.dataset.size = 's';
			node.dataset.appearance = 'neutral';
			node.dataset.variant = appearance;
			if (action === 'copy') {
				node.title = node.ariaLabel = label;
				node.innerHTML = copied === index ? copiedIcon : copyIcon;
				if (copied === index) node.dataset.copied = 'true';
			} else node.textContent = label;
			return node;
		};
		const counts = (additions: number, deletions: number) => {
			const node = doc.createElement('span'),
				add = doc.createElement('span'),
				remove = doc.createElement('span');
			node.className = codeStyles.counts ?? '';
			add.className = codeStyles.add ?? '';
			remove.className = codeStyles.remove ?? '';
			add.textContent = `+${new Intl.NumberFormat(locale).format(additions)}`;
			remove.textContent = `−${new Intl.NumberFormat(locale).format(deletions)}`;
			node.append(add, ' ', remove);
			return node;
		};
		doc.querySelectorAll('pre').forEach((pre, index) => {
			const code = pre.querySelector('code');
			if (!code) return;
			const source = code.textContent ?? '';
			codes[index] = source;
			const language = [...code.classList].find((value) => value.startsWith('language-'))?.slice(9),
				section = doc.createElement('section'),
				header = doc.createElement('header'),
				label = doc.createElement('span');
			section.className = codeStyles.block ?? '';
			section.dataset.codeBlock = String(index);
			header.className = codeStyles.header ?? '';
			label.className = codeStyles.lang ?? '';
			label.textContent = language || t(locale, 'Code');
			header.append(label);
			const diff = language && isDiffFence(language) ? fenceDiff(source) : null;
			if (diff) header.append(counts(diff.additions, diff.deletions));
			if (copied === index) {
				const status = doc.createElement('small');
				status.setAttribute('role', 'status');
				status.className = codeStyles.copied ?? '';
				status.textContent = t(locale, 'Copied');
				header.append(status);
			}
			header.append(button('copy', index, t(locale, 'Copy code'), 'ghost'));
			if (diff) {
				section.dataset.diff = 'true';
				section.dataset.source = source;
				const body = doc.createElement('div'),
					rows = doc.createElement('pre');
				body.className = codeStyles.diff ?? '';
				rows.className = codeStyles.diffRows ?? '';
				const lines = new Map<string, Map<number, SyntaxToken[]>>();
				const tokensOf = (part: number, side: 'old' | 'new', line: number) => {
					const owner = diff.parts[part];
					if (!owner?.language || !current) return [];
					const text = owner[side].join('\n'),
						id = `${part}/${side}`;
					let map = lines.get(id);
					if (!map) {
						map = lineTokens(text, current.sides.get(key(owner.language, text)) ?? []);
						lines.set(id, map);
					}
					return map.get(line) ?? [];
				};
				for (const row of diff.rows) {
					const node = doc.createElement('div');
					if (row.kind === 'file') {
						node.className = codeStyles.diffFile ?? '';
						const path = doc.createElement('span');
						path.textContent = row.path;
						path.title = row.path;
						node.innerHTML = fileIcon;
						node.append(path, counts(row.additions, row.deletions));
					} else if (row.kind === 'gap') {
						node.className = codeStyles.diffGap ?? '';
						node.innerHTML = gapIcon;
						node.append('…');
					} else {
						node.className = codeStyles.diffLine ?? '';
						node.dataset.kind = row.kind;
						const sign = doc.createElement('span'),
							text = doc.createElement('span');
						sign.className = codeStyles.sign ?? '';
						sign.setAttribute('aria-hidden', 'true');
						sign.textContent = row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : '';
						text.className = codeStyles.text ?? '';
						for (const part of syntaxSegments(
							row.text,
							tokensOf(row.part, row.kind === 'removed' ? 'old' : 'new', row.line),
							row.spans
						)) {
							const span = doc.createElement('span');
							if (part.kind) span.className = `syntax-${part.kind}`;
							if (part.changed) span.dataset.changed = 'true';
							span.textContent = part.text;
							text.append(span);
						}
						node.append(sign, text);
					}
					rows.append(node);
				}
				body.append(rows);
				pre.replaceWith(section);
				section.append(header, body);
				return;
			}
			const count = source.replace(/\n$/, '').split('\n').length,
				long = fold && count > CODE_FOLD_LINES,
				shown = codeShown.has(`${rowId}/${index}`);
			pre.replaceWith(section);
			section.append(header, pre);
			if (long) {
				section.dataset.folded = String(!shown);
				const more = button(
					'more',
					index,
					shown
						? t(locale, 'Show less')
						: `${t(locale, 'Show all')} · ${new Intl.NumberFormat(locale).format(count)}`,
					'soft'
				);
				more.setAttribute('aria-expanded', String(shown));
				section.append(more);
			}
		});
		return { html: doc.body.innerHTML, codes };
	}, [current, html, codeShown, rowId, locale, copied, fold]);
	return (
		<div
			data-chat-message={message}
			onClick={(event) => {
				const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
					'[data-code-action]'
				);
				if (!button) return;
				event.preventDefault();
				event.stopPropagation();
				const index = Number(button.dataset.codeIndex);
				if (button.dataset.codeAction === 'copy')
					void window.brigadir.copyText(markup.codes[index] ?? '').then(
						() => setCopied(index),
						() => toastError(t(locale, 'The text could not be copied.'))
					);
				else
					setTask((state) => {
						const next = new Set(state.codeShown),
							id = `${rowId}/${index}`;
						if (next.has(id)) next.delete(id);
						else next.add(id);
						return { codeShown: next };
					});
			}}>
			<FileLinkedMarkup
				html={markup.html}
				task={task}
				locale={locale}
				revision={revision}
				className={className ? `${styles.markdown} ${className}` : styles.markdown}
			/>
			{current?.warning && (
				<small className={codeStyles.warning} role="status">
					{t(
						locale,
						current.warning === 'large'
							? 'Syntax highlighting limit reached.'
							: 'Syntax highlighting is unavailable.'
					)}
				</small>
			)}
		</div>
	);
}
