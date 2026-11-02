import { useEffect, useMemo, useState } from 'react';
import {
	externalLink,
	localLink,
	pullRequestLink,
	filePathCandidates,
	t,
	type AgentTask,
	type FilePathLink,
	type Locale,
} from '@brigadir/core';
import { openTaskEditor, openTaskPR, revealTaskFolder, openTaskBrowser } from './task-state';
import { useWorkspace } from './store';
import { readFileLinksQueued } from './file-link-queue';
import { toastError, toastWarning } from './ui/Toast';
import styles from './FileLinks.module.css';
import { primaryKey } from './ui/primary-key';
const escape = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
	);
/**
 * spec/chat#web-links: a local page (the dev server) opens in the task's browser, the way a command's port does (spec/search-menus-and-commands#project-commands);
 * with the browser module off (spec/settings-modules-and-onboarding#module-off), and for every other http(s)/mailto link, the system browser. The window never navigates.
 * spec/pull-requests-and-ci#pr-links: a GitHub PR page of a repo of this task opens in the PR panel (the way a search row does); `system` (⌘-click,
 * «Open in browser») skips that. Another repo, the module off, a PR that cannot be read: the system browser, the last one with a toast.
 */
export function openTaskLink(task: AgentTask, href: string, system = false) {
	const { appearance } = useWorkspace.getState(),
		browser = () => {
			void window.brigadir.openWebLink(href).catch(() => {});
		};
	const local = localLink(href);
	if (local && appearance.modules.browser) {
		void openTaskBrowser(task, local).catch(() => {});
		return;
	}
	const pr = system || !appearance.modules.pullRequests ? null : pullRequestLink(href);
	if (!pr) {
		browser();
		return;
	}
	void window.brigadir.resolvePullRequestLink(task.projectId, task.id, href).then(
		(ref) => {
			if (ref) openTaskPR(task, ref, pr.tab);
			else browser();
		},
		() => {
			toastWarning(t(appearance.locale, 'The PR did not open here. Opened in the browser.'));
			browser();
		}
	);
}
/** spec/notifications-slack-notes-and-schedules#message-classes: a link that does not open is a toast with the file's name; the console's ⌘-click (spec/terminal-and-cli-agents#console-links) opens the same way.
 *  spec/chat#folder-links: a folder opens in Files. */
export function openTaskFile(task: AgentTask, locale: Locale, link: FilePathLink) {
	if (link.folder) {
		revealTaskFolder(task, link.id, link.folder.parents);
		return;
	}
	void window.brigadir
		.readEditorFile(task, link.id)
		.then((document) => openTaskEditor(task, document, link.line ?? undefined))
		.catch(() => {
			const name = link.path.split('/').at(-1) || link.path;
			toastError(t(locale, 'Could not open {file}.').replace('{file}', name), {
				bold: name,
				action: { label: t(locale, 'Retry'), run: () => openTaskFile(task, locale, link) },
			});
		});
}
/** spec/terminal-and-cli-agents#console-links: an http(s) page of the console's output in the task's own browser (spec/browser-and-simulator#browser), whatever its host. */
export function openInTaskBrowser(task: AgentTask, url: string) {
	void openTaskBrowser(task, url).catch(() => {});
}
export function FileLinkText({
	text,
	task,
	locale,
	revision = 0,
	literal = false,
}: {
	text: string;
	task: AgentTask;
	locale: Locale;
	revision?: number;
	literal?: boolean;
}) {
	return (
		<FileLinkedMarkup
			html={escape(text)}
			task={task}
			locale={locale}
			revision={revision}
			inline
			literal={literal}
		/>
	);
}
export function FileLinkedMarkup({
	html,
	task,
	locale,
	revision = 0,
	inline = false,
	literal = false,
	className,
}: {
	html: string;
	task: AgentTask;
	locale: Locale;
	revision?: number;
	inline?: boolean;
	literal?: boolean;
	className?: string | undefined;
}) {
	const [result, setResult] = useState<{
		source: string;
		revision: number;
		html: string;
		links: Map<string, FilePathLink>;
	} | null>(null);
	useEffect(() => {
		let active = true;
		// Parsing waits for the same 100 ms as the request: a block that is still streaming is not parsed per chunk (CHAT-18).
		const timer = setTimeout(() => {
			const doc = new DOMParser().parseFromString(html, 'text/html'),
				walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT),
				plans: { node: Text; text: string; literal: boolean }[] = [];
			let node: Node | null,
				bytes = 0;
			while ((node = walker.nextNode()) && plans.length < 32) {
				const parent = node.parentElement,
					text = node.textContent ?? '',
					exact = literal || parent?.tagName === 'CODE';
				if (
					!parent ||
					parent.closest('pre,a,button,script,style') ||
					!filePathCandidates(text, exact).length ||
					bytes + text.length > 32768
				)
					continue;
				bytes += text.length;
				plans.push({ node: node as Text, text, literal: exact });
			}
			if (!plans.length) return;
			void readFileLinksQueued(
				task,
				plans.map(({ text, literal }) => ({ text, literal })),
				() => active
			).then(
				(groups) => {
					if (!active || !groups) return;
					const targets = new Map<string, FilePathLink>();
					plans.forEach((plan, i) => {
						const links = groups[i] ?? [];
						if (!links.length) return;
						const fragment = doc.createDocumentFragment();
						let offset = 0;
						for (const [j, link] of links.entries()) {
							const id = `${i}/${j}`;
							fragment.append(plan.text.slice(offset, link.from));
							const button = doc.createElement('button');
							button.type = 'button';
							button.className = styles.link ?? '';
							button.dataset.fileLink = id;
							button.dataset.filePath = link.path;
							if (link.line) button.dataset.fileLine = String(link.line);
							if (link.folder) button.dataset.fileFolder = '';
							button.title = `${t(locale, link.folder ? 'Show in Files' : 'Open in editor')} · ${link.path}${link.line ? `:${link.line}` : ''}`;
							button.textContent = plan.text.slice(link.from, link.to);
							fragment.append(button);
							targets.set(id, link);
							offset = link.to;
						}
						fragment.append(plan.text.slice(offset));
						plan.node.replaceWith(fragment);
					});
					setResult({ source: html, revision, html: doc.body.innerHTML, links: targets });
				},
				() => {
					/* Failed validation leaves literal text, never an unverified link. */
				}
			);
		}, 100);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [html, task.id, task.projectId, revision, literal, locale]);
	const current = result?.source === html && result.revision === revision ? result : null,
		Tag = inline ? 'span' : 'div';
	const markup = useMemo(() => ({ __html: current?.html ?? html }), [current?.html, html]);
	/** spec/notifications-slack-notes-and-schedules#message-classes: a link that does not open is a toast with the file's name. */
	const openLink = (link: FilePathLink) => openTaskFile(task, locale, link);
	return (
		<Tag
			className={className}
			dangerouslySetInnerHTML={markup}
			onClick={(event) => {
				const target = (event.target as HTMLElement).closest<HTMLElement>('[data-file-link]');
				if (target) {
					event.preventDefault();
					event.stopPropagation();
					const link = current?.links.get(target.dataset.fileLink ?? '');
					if (link) openLink(link);
				} else {
					const anchor = (event.target as HTMLElement).closest('a');
					if (!anchor) return;
					event.preventDefault();
					const href = externalLink(anchor.getAttribute('href'));
					if (href) {
						event.stopPropagation();
						openTaskLink(task, href, primaryKey(event));
					}
				}
			}}
		/>
	);
}
