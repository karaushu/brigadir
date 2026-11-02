import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { externalLink, t, type AgentTask, type Locale } from '@brigadir/core';
import { MarkdownBlock } from './MarkdownBlock';
import { markdown, type MarkdownTokens } from './markdown';
import { openTaskEditor, revealTaskFolder } from './task-state';
import { readFileLinksQueued } from './file-link-queue';
import styles from './MarkdownPreview.module.css';

/** spec/editor#markdown-views: what the preview finds. `current` is the match the code's search selected (its source line and its order
 *  within that block), or an index over every match for the preview's own find bar. */
export type PreviewFind = {
	pattern: RegExp;
	current: { line: number; index: number } | { global: number } | null;
};

type Block = { element: HTMLElement; start: number; end: number };
function blocks(root: HTMLElement): Block[] {
	return [...root.querySelectorAll<HTMLElement>('[data-line]')]
		.map((element) => {
			const [start, end] = (element.dataset.line ?? '').split('-').map(Number);
			return { element, start: start!, end: end! };
		})
		.filter((block) => block.start > 0);
}
/** The innermost block that holds `line`, else the first block after it. */
function blockFor(root: HTMLElement, line: number): Block | null {
	const all = blocks(root);
	let best: Block | null = null;
	for (const block of all)
		if (block.start <= line && line <= block.end && (!best || block.start >= best.start))
			best = block;
	return best ?? all.find((block) => block.start > line) ?? all.at(-1) ?? null;
}
/** The source line at the top of the preview, with the fraction scrolled into its block. */
export function previewTopLine(root: HTMLElement): number {
	const top = root.getBoundingClientRect().top + 1;
	let best: { block: Block; rect: DOMRect } | null = null;
	for (const block of blocks(root)) {
		const rect = block.element.getBoundingClientRect();
		if (rect.top <= top && rect.bottom > top && (!best || block.start >= best.block.start))
			best = { block, rect };
	}
	if (!best) {
		const after = blocks(root).find((block) => block.element.getBoundingClientRect().top > top);
		return after?.start ?? 1;
	}
	const span = best.block.end - best.block.start + 1,
		fraction = Math.min(1, Math.max(0, (top - best.rect.top) / Math.max(1, best.rect.height)));
	return Math.min(best.block.end, best.block.start + Math.floor(fraction * span));
}
/** The first source line of the block at the top of the preview: where the code opens when the person switches. */
export function previewTopBlockLine(root: HTMLElement): number {
	const line = previewTopLine(root);
	return blockFor(root, line)?.start ?? line;
}
/** Scrolls so the block holding `line` stands at the top, at the same fraction of its height. */
export function scrollPreviewToLine(root: HTMLElement, line: number) {
	const block = blockFor(root, line);
	if (!block) return;
	const rect = block.element.getBoundingClientRect(),
		base = root.getBoundingClientRect().top - root.scrollTop;
	const span = block.end - block.start + 1,
		fraction = line >= block.start ? Math.min(1, (line - block.start) / span) : 0;
	root.scrollTop = Math.max(0, rect.top - base + fraction * rect.height - (fraction ? 0 : 8));
}
/** A short accent frame around the block that holds `line` (spec/editor#markdown-views). */
export function flashPreviewLine(root: HTMLElement, line: number) {
	const block = blockFor(root, line);
	if (!block) return;
	block.element.dataset.flash = 'true';
	setTimeout(() => {
		delete block.element.dataset.flash;
	}, 900);
}
const slug = (text: string) =>
	text
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, '')
		.replace(/\s+/g, '-');
/** `a/b/c.md` + `../d.md#x` → `a/d.md`; null for a path that leaves the project. */
export function resolveDocumentLink(document: string, href: string): string | null {
	const parts = document.split('/').slice(0, -1);
	for (const part of decodeURI(href.split('#')[0]!).split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(part);
	}
	return parts.join('/') || null;
}

/** spec/editor#markdown-views: a rendered Markdown document — the chat's look at document scale, block maps for the place, links that
 *  open files, a double click that opens the code at its block, and find highlights. */
export function MarkdownPreview({
	tokens,
	newFile = false,
	rowId,
	path,
	task,
	locale,
	label,
	scrollRef,
	onScroll,
	onOpenLine,
	find,
	onMatches,
}: {
	tokens: MarkdownTokens;
	newFile?: boolean;
	rowId: string;
	path: string;
	task: AgentTask;
	locale: Locale;
	label: string;
	scrollRef?: RefObject<HTMLDivElement | null>;
	onScroll?: () => void;
	onOpenLine?: (line: number) => void;
	find?: PreviewFind | null;
	onMatches?: (count: number) => void;
}) {
	const own = useRef<HTMLDivElement | null>(null);
	const html = useMemo(() => markdown.renderer.render(tokens, markdown.options, {}), [tokens]);
	const setRoot = (node: HTMLDivElement | null) => {
		own.current = node;
		if (scrollRef) (scrollRef as { current: HTMLDivElement | null }).current = node;
	};
	// Native tooltips say where a link goes; the markup comes from the renderer, so they are set after each render.
	useLayoutEffect(() => {
		const root = own.current;
		if (!root) return;
		const label = () => {
			for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
				const href = link.getAttribute('href') ?? '';
				if (link.title) continue;
				if (externalLink(href)) link.title = href;
				else if (!href.startsWith('#') && !/^[a-z]+:/i.test(href)) {
					const target = resolveDocumentLink(path, href);
					if (target) link.title = `${t(locale, 'Open in editor')} · ${target}`;
				}
			}
		};
		label();
		const observer = new MutationObserver(label);
		observer.observe(root, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [html, path, locale]);
	// Find: every match in the rendered text, the current one in its own color; ranges follow the markup as it settles.
	useEffect(() => {
		const root = own.current,
			registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
		if (!root || !registry || typeof Highlight === 'undefined') return;
		if (!find) {
			registry.delete('md-find');
			registry.delete('md-find-current');
			onMatches?.(0);
			return;
		}
		let frame = 0;
		const paint = () => {
			frame = 0;
			const ranges: Range[] = [],
				owners: HTMLElement[] = [];
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const parent = node.parentElement;
				if (!parent || parent.closest('header,button')) continue;
				const text = node.textContent ?? '';
				find.pattern.lastIndex = 0;
				for (let match = find.pattern.exec(text); match; match = find.pattern.exec(text)) {
					if (!match[0]) {
						find.pattern.lastIndex++;
						continue;
					}
					const range = document.createRange();
					range.setStart(node, match.index);
					range.setEnd(node, match.index + match[0].length);
					ranges.push(range);
					owners.push(parent);
				}
			}
			registry.set('md-find', new Highlight(...ranges));
			onMatches?.(ranges.length);
			let current: Range | null = null;
			const wanted = find.current;
			if (wanted && 'global' in wanted)
				current = ranges.length
					? ranges[((wanted.global % ranges.length) + ranges.length) % ranges.length]!
					: null;
			else if (wanted) {
				const block = blockFor(root, wanted.line);
				if (block) {
					const inside = ranges.filter((_, i) => block.element.contains(owners[i]!));
					current = inside[Math.min(wanted.index, inside.length - 1)] ?? null;
				}
			}
			if (current) {
				registry.set('md-find-current', new Highlight(current));
				const rect = current.getBoundingClientRect(),
					box = root.getBoundingClientRect();
				if (rect.top < box.top + 24 || rect.bottom > box.bottom - 24)
					root.scrollTop += rect.top - box.top - box.height / 3;
			} else registry.delete('md-find-current');
		};
		paint();
		const observer = new MutationObserver(() => {
			if (!frame) frame = requestAnimationFrame(paint);
		});
		observer.observe(root, { childList: true, subtree: true, characterData: true });
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			registry.delete('md-find');
			registry.delete('md-find-current');
		};
	}, [html, find]);
	return (
		<div
			ref={setRoot}
			className={styles.preview}
			data-markdown-preview
			data-new-file={newFile || undefined}
			tabIndex={0}
			role="document"
			aria-label={label}
			onScroll={onScroll}
			onDoubleClick={(event) => {
				const block = (event.target as HTMLElement).closest<HTMLElement>('[data-line]');
				const start = Number(block?.dataset.line?.split('-')[0]);
				if (start && onOpenLine) {
					window.getSelection()?.removeAllRanges();
					onOpenLine(start);
				}
			}}
			onClick={(event) => {
				const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
				if (!link) return;
				event.preventDefault();
				const href = link.getAttribute('href') ?? '';
				if (href.startsWith('#')) {
					const id = slug(decodeURIComponent(href.slice(1)));
					const heading = [
						...(own.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? []),
					].find((item) => slug(item.textContent ?? '') === id);
					heading?.scrollIntoView({ block: 'start' });
					return;
				}
				// spec/chat#web-links: the block's own markup (FileLinkedMarkup) already opened an http(s)/mailto link in the system browser.
				if (externalLink(href)) return;
				const target = /^[a-z]+:/i.test(href) ? null : resolveDocumentLink(path, href);
				if (!target) return;
				void readFileLinksQueued(task, [{ text: target, literal: true }], () => true)
					.then((groups) => {
						const found = groups?.[0]?.[0];
						if (found?.folder) revealTaskFolder(task, found.id, found.folder.parents);
						else if (found)
							return window.brigadir
								.readEditorFile(task, found.id)
								.then((document) => openTaskEditor(task, document));
					})
					.catch(() => {});
			}}>
			<MarkdownBlock
				rowId={rowId}
				fold={false}
				html={html}
				tokens={tokens}
				locale={locale}
				task={task}
				revision={0}
				className={styles.doc}
			/>
		</div>
	);
}
/** The first source line of the block that holds `line`, for the order of a find match inside it. */
export function previewBlockStart(root: HTMLElement, line: number): number | null {
	return blockFor(root, line)?.start ?? null;
}
