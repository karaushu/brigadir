/**
 * spec/browser-and-simulator#background: the agent's browser works for a task that is not on screen. A view the person does not see lives in an
 * invisible window while the agent uses it, freezes 60 s after the agent's last browser call, and the app keeps at most
 * 10 cached views — live ones never count against that. What the page did meanwhile (a dialog, a copy, a file chooser,
 * a sign-in, the person's own input) reaches the agent as one sentence in the reply to its next call.
 */
export const browserFreezeMs = 60_000;
export const browserCacheLimit = 10;
/** What a reply carries of the task clipboard; the buffer itself may be longer. */
export const browserClipboardShown = 2000;
/** The task clipboard never grows past this; it lives in memory only. */
export const browserClipboardMax = 100_000;
/** After a thaw the page settles before the action: 500 ms without requests, 3 s at most. */
export const browserQuietMs = 500;
export const browserQuietMaxMs = 3000;

/**
 * Which cached views close, oldest first: only frozen ones, until at most `limit` views are left. A live view — on screen
 * or in an invisible window — never closes, so there is no limit on live pages; `keep` is the view being opened.
 */
export function browserEvictions(
	views: readonly { id: string; live: boolean }[],
	keep: string | null,
	limit = browserCacheLimit
): string[] {
	let count = views.length;
	const closed: string[] = [];
	for (const view of views) {
		if (count <= limit) break;
		if (view.live || view.id === keep) continue;
		closed.push(view.id);
		count--;
	}
	return closed;
}

/** Cut a text for a reply: the first 2 000 characters and how many more there are. */
export function browserClipText(text: string, limit = browserClipboardShown) {
	const chars = [...text];
	return chars.length <= limit
		? JSON.stringify(text)
		: `${JSON.stringify(chars.slice(0, limit).join(''))} (${chars.length - limit} more characters)`;
}

/** What the page did between the agent's calls; each turns into one sentence of the next reply. */
export type BrowserPageNote =
	| {
			kind: 'dialog';
			type: 'alert' | 'confirm' | 'prompt';
			message: string;
			/** `null` — cancelled; `true` — accepted (confirm), a string — the text given to prompt. */
			answer: boolean | string | null;
	  }
	| { kind: 'beforeunload' }
	| { kind: 'copy'; text: string; cut: boolean }
	| { kind: 'file-chooser' }
	| { kind: 'login'; host: string }
	| { kind: 'picker' }
	| { kind: 'person' }
	/** spec/browser-and-simulator#notifications: the page asked to show notifications; it showed one. */
	| { kind: 'notification-ask'; host: string }
	| { kind: 'notification'; title: string; body: string };

const quote = (text: string, limit = 300) =>
	browserClipText(text.replace(/\s+/g, ' ').trim(), limit);

export function browserNoteText(note: BrowserPageNote): string {
	switch (note.kind) {
		case 'dialog': {
			const asked =
				note.type === 'alert'
					? `The page showed an alert ${quote(note.message)}; it was closed.`
					: `The page asked ${quote(note.message)} (${note.type}); answered ${
							note.answer === null || note.answer === false
								? 'Cancel'
								: note.answer === true
									? 'OK'
									: `OK with ${quote(note.answer)}`
						}.`;
			return note.type === 'alert' || (note.answer !== null && note.answer !== false)
				? asked
				: `${asked} To answer otherwise, call browser_act dialog with accept (and text for a prompt), then repeat the step.`;
		}
		case 'beforeunload':
			return 'The page tried to keep you from leaving (beforeunload); the navigation went on.';
		case 'copy':
			return `The page ${note.cut ? 'cut' : 'copied'} to the task clipboard: ${browserClipText(note.text)}.`;
		case 'file-chooser':
			return 'The page opened a file chooser; uploading files is not supported, nothing was chosen. Ask the person to upload the file, or call browser_show.';
		case 'login':
			return `The page requires signing in (HTTP authentication at ${note.host}); it was cancelled. Ask the person to sign in.`;
		case 'picker':
			return 'The page tried to open a native picker (showPicker) while it is not on screen; it was refused.';
		case 'person':
			return 'The person used this page since your last browser call; call browser_ui to see it as it is now.';
		case 'notification-ask':
			return `The page asks to show notifications for ${note.host}; the person answers in the browser strip, or you answer with browser_act notifications (permission granted or denied).`;
		case 'notification':
			return `The page showed a notification ${quote(note.title)}${note.body ? `: ${quote(note.body)}` : ''}.`;
	}
}

/** spec/browser-and-simulator#background: a click that would open a native window on the screen from a hidden page is not sent. */
export function browserPickerRefusal(kind: 'select' | 'color') {
	return kind === 'select'
		? 'This is a <select>: clicking it in a page that is not on screen opens its list as a native window over the screen, so nothing was clicked. Use browser_act select with the value or text of the option.'
		: 'This is a color input: clicking it in a page that is not on screen opens a native color picker over the screen, so nothing was clicked. Use browser_act type with a color like #3366ff.';
}

/** `browser_act clipboard`: what the task clipboard holds. */
export function browserClipboardReply(text: string) {
	return text
		? `The task clipboard holds ${browserClipText(text)}.`
		: 'The task clipboard is empty.';
}

/** `browser_act dialog`: the answer waiting for the next dialog. */
export function browserDialogReply(accept: boolean, text?: string) {
	return `The next dialog of the page gets ${accept ? (text !== undefined ? `OK with ${quote(text)}` : 'OK') : 'Cancel'}. Repeat the step that opens it.`;
}

/** spec/browser-and-simulator#notifications: `browser_act notifications` — what the domain now answers. */
export function browserNotificationsReply(
	host: string,
	permission: 'granted' | 'denied' | 'default'
) {
	return permission === 'default'
		? `Notifications for ${host} are undecided again: the page asks the next time it requests them.`
		: `Notifications for ${host} are ${permission === 'granted' ? 'allowed' : 'blocked'}; a waiting request of the page got this answer. The project keeps it for the domain, and the person sees and can change it in the browser menu.`;
}

/** spec/browser-and-simulator#background: the «Needs you» card of `browser_show`. The host asks with these English names; the card knows the
 *  tool by its name and shows the title and both options in the person's language. */
export const browserShowCard = {
	tool: 'browser_show',
	title: 'The agent needs the page on screen',
	show: 'Show',
	decline: 'Decline',
} as const;
