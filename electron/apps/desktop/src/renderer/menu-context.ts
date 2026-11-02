import { useEffect } from 'react';
import { emptyMenuContext, type MenuContext } from '@brigadir/core';
/** Only bounded UI availability crosses this bridge; commands retain their own guards. */
/** spec/search-menus-and-commands#search-tabs: what the menu offered before a modal took the focus — the Actions tab lists those items. */
let beforeModal: MenuContext = emptyMenuContext;
export const menuContextBeforeModal = () => beforeModal;
/** spec/remote-access-and-mobile#pairing: main kept the menu context of the client in control; a window that gets control back says it again. */
let announce: (() => void) | null = null;
export const announceMenuContext = () => announce?.();
/** `archivable` (spec/tasks#archive): the open task can go to the archive now, so ⌃⌘A acts. */
export function useMenuContext(
	project: boolean,
	task: boolean,
	needsYou: boolean,
	relay = false,
	archivable = false
) {
	useEffect(() => {
		let last = '',
			frame = 0;
		const publish = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
			const focus = document.activeElement as HTMLElement | null;
			const closest = (selector: string) => focus?.closest<HTMLElement>(selector);
			const flag = (selector: string, key: string) => closest(selector)?.dataset[key] === 'true';
			const modal = !!document.querySelector('dialog[open]');
			const inInput = !!closest('input,textarea,[data-prompt],[role=listbox]');
			// spec/composer#mentions: the task composer and the sheet's prompt are CodeMirror too, but they are text fields, not the code editor.
			const prompt = !!closest('[data-prompt]'),
				codeEditor = !!closest('.cm-editor') && !prompt;
			const surface = closest('[data-font-surface]')?.dataset.fontSurface;
			const console = !!closest('[data-role=console]');
			const threeColumns = !!document.querySelector('[data-columns="3"]');
			const activity =
				(!!closest('[data-activity]') ||
					(!threeColumns &&
						!!document.querySelector('[data-activity]') &&
						!document.querySelector('[data-font-surface=editor],[data-font-surface=diff]') &&
						!closest('[data-menu-tree],[data-browser],[data-role]'))) &&
				!inInput &&
				!surface;
			const editorHost =
				closest('[data-font-surface=editor]') ??
				(focus === document.body
					? document.querySelector<HTMLElement>('[data-font-surface=editor]')
					: null);
			const editor =
				!!editorHost &&
				!closest('[data-editor-selection],[data-comment-draft]') &&
				(!inInput || codeEditor);
			const diff =
				(surface === 'diff' ||
					(!!document.querySelector('[data-font-surface=diff]') &&
						!closest(
							'[data-font-surface=editor],[data-browser],[data-activity],[data-role],[data-app-sidebar]'
						))) &&
				!inInput &&
				!closest('[data-comment-draft]');
			const terminal = surface === 'terminal';
			const taskNode = document.querySelector<HTMLElement>('[data-menu-task]');
			// spec/editor#markdown-views: the Markdown document on screen, editor or diff; ⇧⌘V acts on it unless typing elsewhere.
			const markdownHost = document.querySelector<HTMLElement>('[data-markdown-view]');
			const markdown =
				!!markdownHost &&
				(!inInput || codeEditor) &&
				!closest('[data-browser],[data-role],[data-comment-draft]');
			const next: MenuContext = {
				...emptyMenuContext,
				project,
				task,
				needsYou,
				relay,
				archivable,
				threeColumns: task && threeColumns,
				// spec/task-window-workspace#layout-switch: View ▸ Layout ticks the task's switches.
				layoutChat: task
					? !!taskNode?.dataset.layout?.split(',').includes('chat')
					: document.querySelector<HTMLElement>('[data-notes-body]')?.dataset.chat === 'true',
				// spec/notifications-slack-notes-and-schedules#notes: a note is open with its chat column, so ⌘1 shows or hides it.
				noteChat: !task && !!document.querySelector('[data-notes-body]'),
				layoutWork: task && !!taskNode?.dataset.layout?.split(',').includes('work'),
				layoutPanel: task && !!taskNode?.dataset.layout?.split(',').includes('panel'),
				// spec/editor#editor-groups: a second editor group is on screen, so the group items and ⌥⇥ act.
				editorGroups: task && !!document.querySelector('[data-editor-group][data-focused=false]'),
				modal,
				editor,
				diff,
				activity,
				console,
				terminal,
				markdown,
				markdownPreview: markdown && markdownHost?.dataset.markdownView !== 'code',
				sidebar: !!document.querySelector('[data-app-sidebar]'),
				// spec/sidebar#section-rail: Pull requests is a section of the rail only while its module is on.
				prSection: !!document.querySelector('[data-rail-section=prs]'),
				document:
					!!taskNode &&
					taskNode.dataset.menuDocuments !== '0' &&
					!inInput &&
					!activity &&
					!terminal &&
					!closest('[data-browser]'),
				font: !!surface && !closest('button,[data-comment-draft]') && (!inInput || terminal),
				save: editor && editorHost?.dataset.menuSave === 'true',
				// spec/composer#formatting: on a list item ⇧Tab is the item's level, not the agent's mode (the editor sets data-list-line from its caret).
				composerMode:
					!!closest('[data-menu-cycle-mode=true]') &&
					!closest('[role=listbox]') &&
					!closest('[data-list-line=true]'),
				// spec/composer#formatting: Edit ▸ Formatting acts in the text of the composer, not in a terminal's prompt.
				composerFormat: prompt && !console,
				// spec/composer-steering-queue-and-ghost#steering-hold: ⌘↩ queues only from the task composer's own field while the agent works and steering is on.
				composerQueue: prompt && !!closest('[data-menu-queue=true]'),
				review:
					taskNode?.dataset.menuReview === 'true' &&
					!activity &&
					!inInput &&
					!terminal &&
					!closest('[data-permission-id],[data-question-id],[data-comment-draft]'),
				permission: flag('[data-permission-id]', 'menuAllowOnce'),
				permissionAlways: flag('[data-permission-id]', 'menuAllowAlways'),
				permissionDeny: flag('[data-permission-id]', 'menuDeny'),
				question: flag('[data-question-id]', 'menuAnswer'),
				comment: flag('[data-comment-draft]', 'menuComment'),
				commentGo: flag('[data-comment-draft]', 'menuCommentGo'),
				browser: !!document.querySelector('[data-browser]'),
				simulator: !!document.querySelector('[data-simulator]'),
				simulatorFocus: !!document.activeElement?.closest('[data-simulator]'),
				running: console
					? flag('[data-role=console]', 'menuTerminalAlive')
					: taskNode?.dataset.menuRunning === 'true',
				terminalTabs: Number(closest('[data-role=console]')?.dataset.menuTerminalCount) > 1,
				terminalOutput: flag('[data-role=console]', 'menuTerminalOutput'),
				diffSelection: flag('[data-font-surface=diff]', 'menuDiffSelection'),
				// spec/editor#reopen-closed-tab: F4 — the diff on screen (not a passive group's) has a file to open.
				diffSource:
					(
						closest('[data-font-surface=diff]') ??
						[...document.querySelectorAll<HTMLElement>('[data-font-surface=diff]')].find(
							(item) => !item.closest('[data-passive-diff]')
						)
					)?.dataset.menuDiffSource === 'true',
				// spec/editor#reopen-closed-tab: the focused group has a closed tab; not while typing, in a terminal or in the browser.
				reopenTab:
					taskNode?.dataset.menuReopen === 'true' &&
					(!inInput || codeEditor) &&
					!terminal &&
					!closest('[data-browser],[data-role=console]'),
				// spec/pull-requests-and-ci#reading-and-refresh: ⌘R refreshes the PR list and the open PR while the focus is in the PR panel.
				pullRequests: !!closest('[data-pr-panel]'),
				// spec/git#commit-dialog: Diff ▸ Commit… opens the commit dialog of the open task.
				commit: task && !!taskNode,
				// spec/composer-steering-queue-and-ghost#quick-question: ⌘I asks about the selection the panel stands under, in the editor or the diff.
				askAgent:
					!!document.querySelector('[data-selection-actions] [data-ask-agent]') &&
					!inInput &&
					!modal &&
					!closest('[data-browser],[data-role],[data-activity]'),
				// spec/chat-turns-plans-and-questions#turn-rail: the conversation, or its composer, while a turn rail is on screen.
				turnRail:
					!!document.querySelector('[data-activity] [data-turn-rail]') &&
					(activity || (!!closest('[data-activity] form') && !closest('[role=listbox]'))),
				find:
					editor ||
					activity ||
					!!closest('[data-menu-tree]') ||
					!!closest('[data-menu-find]') ||
					(diff && (surface === 'diff' || !threeColumns)),
			};
			if (!modal) beforeModal = next;
			const key = JSON.stringify(next);
			if (key !== last) {
				last = key;
				void window.brigadir.updateMenuContext(next).catch(() => {});
			}
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(publish);
		};
		announce = () => {
			last = '';
			schedule();
		};
		const observer = new MutationObserver((records) => {
			if (records.some((record) => record.type === 'attributes')) publish();
			else schedule();
		});
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [
				'open',
				'data-markdown-view',
				'data-menu-task',
				'data-menu-review',
				'data-menu-running',
				'data-menu-documents',
				'data-layout',
				'data-menu-cycle-mode',
				'data-list-line',
				'data-menu-queue',
				'data-menu-save',
				'data-font-surface',
				'data-columns',
				'data-menu-answer',
				'data-menu-allow-once',
				'data-menu-allow-always',
				'data-menu-deny',
				'data-menu-comment',
				'data-menu-comment-go',
				'data-menu-terminal-count',
				'data-menu-terminal-alive',
				'data-menu-terminal-output',
				'data-menu-diff-selection',
				'data-menu-diff-source',
				'data-menu-reopen',
			],
		});
		document.addEventListener('focusin', publish);
		document.addEventListener('focusout', schedule);
		schedule();
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			document.removeEventListener('focusin', publish);
			document.removeEventListener('focusout', schedule);
		};
	}, [project, task, needsYou, relay, archivable]);
}
