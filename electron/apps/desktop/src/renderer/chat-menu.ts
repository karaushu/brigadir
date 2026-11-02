import type { MouseEvent } from 'react';
import {
	externalLink,
	pullRequestLink,
	pathWithLines,
	type AgentTask,
	type ChatMenuState,
} from '@brigadir/core';
import { openTaskLink } from './FileLinks';
import { useWorkspace } from './store';

/** Fields and surfaces in the log that keep their own right click (spec/chat#context-menu). */
const own = 'input,textarea,select,[contenteditable],.xterm,.cm-editor';
const target = (event: MouseEvent) => {
	const node = event.target as HTMLElement;
	return node.closest('[role="log"]') && !node.closest(own) ? node : null;
};
const secondary = (event: MouseEvent) =>
	event.button === 2 || (event.button === 0 && event.ctrlKey);

/** Whether the last right press in the log fell inside the selection; null until one does (a keyboard menu has none). */
let pressedInside: boolean | null = null;
/**
 * spec/chat#context-menu: before the right click. A click inside the selection keeps it, outside it clears it. The macOS word
 * selection on right click (WebKit's «select on contextual menu click») is undone in the menu handler: otherwise every
 * right click would leave a selected word for Copy.
 */
export function chatMenuMouseDown(event: MouseEvent) {
	if (!secondary(event) || !target(event)) return;
	const selection = getSelection(),
		{ clientX: x, clientY: y } = event;
	pressedInside = Boolean(
		selection &&
		!selection.isCollapsed &&
		selection.rangeCount &&
		[...selection.getRangeAt(0).getClientRects()].some(
			(rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
		)
	);
}

/** spec/chat#context-menu: the native menu of the chat log; `message` gives the source text of a `[data-chat-message]` id. */
export async function openChatMenu(
	event: MouseEvent,
	task: AgentTask,
	message: (id: string) => string | null,
	onError: (error: unknown) => void
) {
	if (event.defaultPrevented || event.nativeEvent.defaultPrevented) return;
	const node = target(event);
	if (!node) return;
	event.preventDefault();
	const selection = getSelection();
	if (pressedInside === false) selection?.removeAllRanges();
	pressedInside = null;
	const selected = Boolean(selection && !selection.isCollapsed && selection.toString().trim());
	const anchor = node.closest('a'),
		href = anchor ? externalLink(anchor.getAttribute('href')) : null;
	const file = href ? null : node.closest<HTMLElement>('[data-file-link]'),
		path = file?.dataset.filePath,
		line = Number(file?.dataset.fileLine) || null;
	const code = node.closest<HTMLElement>('[data-code-block]'),
		image = node.closest<HTMLElement>('[data-kind="image"][data-attachment-id]');
	const owner = node.closest<HTMLElement>('[data-chat-message]')?.dataset.chatMessage,
		text = owner ? message(owner) : null;
	const state: ChatMenuState = {
		selection: selected,
		link: href
			? pullRequestLink(href) && useWorkspace.getState().appearance.modules.pullRequests
				? 'pr'
				: 'web'
			: path
				? file?.dataset.fileFolder !== undefined
					? 'folder'
					: 'file'
				: null,
		line: Boolean(path && line),
		code: Boolean(code),
		image: Boolean(image),
		message: Boolean(text),
	};
	try {
		const action = await window.brigadir.chatMenu(state);
		if (action === 'open-link' && href) openTaskLink(task, href);
		else if (action === 'open-browser' && href) openTaskLink(task, href, true);
		else if (action === 'copy-link' && href) await window.brigadir.copyText(href);
		else if (action === 'open-file') file?.click();
		else if (action === 'copy-path' && path) await window.brigadir.copyText(path);
		else if (action === 'copy-line' && path && line)
			await window.brigadir.copyText(pathWithLines(path, { start: line, end: line }));
		else if (action === 'copy-code' && code)
			await window.brigadir.copyText(
				// spec/chat#layout: a diff block draws its rows, so it keeps the fence's raw text for copying.
				code.dataset.source ?? code.querySelector('pre code')?.textContent ?? ''
			);
		else if (action === 'copy-image' && image)
			await window.brigadir.copyAttachmentImage(task, image.dataset.attachmentId!);
		else if (action === 'copy-message' && text) await window.brigadir.copyText(text);
	} catch (error) {
		onError(error);
	}
}
