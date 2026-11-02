import { describe, expect, it } from 'vitest';
import {
	browserCacheLimit,
	browserClipText,
	browserClipboardReply,
	browserDialogReply,
	browserEvictions,
	browserNoteText,
	browserNotificationsReply,
	browserPickerRefusal,
} from './browser-background';
import { isBrowserActRequest } from './browser-agent';
import { isBrowserCommand } from './browser';

describe('spec/browser-and-simulator#background the agent browser off screen', () => {
	it('keeps a cache of 10 views and closes only the oldest frozen ones', () => {
		expect(browserCacheLimit).toBe(10);
		const frozen = (count: number) =>
			Array.from({ length: count }, (_, index) => ({ id: `t${index}`, live: false }));
		expect(browserEvictions(frozen(10), 't9')).toEqual([]);
		expect(browserEvictions(frozen(12), 't11')).toEqual(['t0', 't1']);
		// Live pages never close and do not stop the oldest frozen from closing.
		const views = [{ id: 'live-a', live: true }, ...frozen(10), { id: 'live-b', live: true }];
		expect(browserEvictions(views, 't9')).toEqual(['t0', 't1']);
		// Without frozen views there is no limit.
		const live = Array.from({ length: 14 }, (_, index) => ({ id: `l${index}`, live: true }));
		expect(browserEvictions(live, 'l13')).toEqual([]);
		// The view being opened stays even when it is the oldest.
		expect(browserEvictions(frozen(11), 't0')).toEqual(['t1']);
	});
	it('cuts what the page copied to 2 000 characters and says how many more', () => {
		const long = 'я'.repeat(2500);
		const shown = browserClipText(long);
		expect(shown).toBe(`${JSON.stringify('я'.repeat(2000))} (500 more characters)`);
		expect(browserClipText('short')).toBe('"short"');
		expect(browserNoteText({ kind: 'copy', text: long, cut: false })).toBe(
			`The page copied to the task clipboard: ${shown}.`
		);
		expect(browserNoteText({ kind: 'copy', text: 'abc', cut: true })).toBe(
			'The page cut to the task clipboard: "abc".'
		);
		expect(browserClipboardReply('')).toBe('The task clipboard is empty.');
		expect(browserClipboardReply('x'.repeat(2001))).toContain('(1 more characters)');
	});
	it('tells the agent what a dialog asked and how it was answered', () => {
		expect(
			browserNoteText({ kind: 'dialog', type: 'confirm', message: 'Delete it?', answer: null })
		).toBe(
			'The page asked "Delete it?" (confirm); answered Cancel. To answer otherwise, call browser_act dialog with accept (and text for a prompt), then repeat the step.'
		);
		expect(
			browserNoteText({ kind: 'dialog', type: 'confirm', message: 'Delete it?', answer: true })
		).toBe('The page asked "Delete it?" (confirm); answered OK.');
		expect(
			browserNoteText({ kind: 'dialog', type: 'prompt', message: 'Name', answer: 'Ada' })
		).toBe('The page asked "Name" (prompt); answered OK with "Ada".');
		expect(browserNoteText({ kind: 'dialog', type: 'alert', message: 'Saved', answer: null })).toBe(
			'The page showed an alert "Saved"; it was closed.'
		);
		expect(browserDialogReply(true, 'Ada')).toBe(
			'The next dialog of the page gets OK with "Ada". Repeat the step that opens it.'
		);
		expect(browserDialogReply(false)).toBe(
			'The next dialog of the page gets Cancel. Repeat the step that opens it.'
		);
		expect(browserNoteText({ kind: 'beforeunload' })).toContain('beforeunload');
		expect(browserNoteText({ kind: 'login', host: 'staging.test' })).toContain(
			'Ask the person to sign in'
		);
		expect(browserNoteText({ kind: 'file-chooser' })).toContain('uploading files is not supported');
		expect(browserNoteText({ kind: 'person' })).toContain('The person used this page');
	});
	it('refuses a click on <select> and a color input with what to use instead', () => {
		expect(browserPickerRefusal('select')).toContain('Use browser_act select');
		expect(browserPickerRefusal('color')).toContain('Use browser_act type with a color');
	});
	it('validates the new actions: dialog needs accept, paste needs text, clipboard needs nothing', () => {
		expect(isBrowserActRequest({ action: 'dialog', accept: true })).toBe(true);
		expect(isBrowserActRequest({ action: 'dialog', accept: false, text: 'x' })).toBe(true);
		expect(isBrowserActRequest({ action: 'dialog' })).toBe(false);
		expect(isBrowserActRequest({ action: 'paste', text: 'hello' })).toBe(true);
		expect(isBrowserActRequest({ action: 'paste' })).toBe(false);
		expect(isBrowserActRequest({ action: 'clipboard' })).toBe(true);
		expect(isBrowserCommand({ kind: 'act', action: 'clipboard' })).toBe(true);
	});
});

describe('spec/browser-and-simulator#notifications notifications of a page, spec/browser-and-simulator#tab-sound the sound of a tab', () => {
	it('takes the person’s answers for the page and the tab', () => {
		for (const decision of ['default', 'granted', 'denied', 'dismiss'])
			expect(isBrowserCommand({ kind: 'notifications', decision })).toBe(true);
		expect(isBrowserCommand({ kind: 'notifications', decision: 'prompt' })).toBe(false);
		expect(isBrowserCommand({ kind: 'notifications', decision: 'granted', host: 'x' })).toBe(false);
		expect(isBrowserCommand({ kind: 'notification-click', id: 3, tab: 'b1234abcd' })).toBe(true);
		expect(isBrowserCommand({ kind: 'notification-click', id: 0 })).toBe(false);
		expect(isBrowserCommand({ kind: 'mute', muted: true })).toBe(true);
		expect(isBrowserCommand({ kind: 'mute', muted: 'yes' })).toBe(false);
	});
	it('tells the agent the page asked and what it showed', () => {
		expect(browserNoteText({ kind: 'notification-ask', host: 'stage.example.com' })).toBe(
			'The page asks to show notifications for stage.example.com; the person answers in the browser strip, or you answer with browser_act notifications (permission granted or denied).'
		);
		expect(
			browserNoteText({ kind: 'notification', title: 'New order', body: '#12  table 4' })
		).toBe('The page showed a notification "New order": "#12 table 4".');
		expect(browserNoteText({ kind: 'notification', title: 'Ping', body: '' })).toBe(
			'The page showed a notification "Ping".'
		);
	});
	it('spec/browser-and-simulator#notifications: the agent decides for the domain through browser_act', () => {
		for (const permission of ['granted', 'denied', 'default'])
			expect(isBrowserActRequest({ action: 'notifications', permission })).toBe(true);
		expect(isBrowserActRequest({ action: 'notifications' })).toBe(false);
		expect(isBrowserActRequest({ action: 'notifications', permission: 'dismiss' })).toBe(false);
		expect(isBrowserCommand({ kind: 'act', action: 'notifications', permission: 'granted' })).toBe(
			true
		);
		expect(browserNotificationsReply('stage.example.com', 'granted')).toContain(
			'Notifications for stage.example.com are allowed; a waiting request of the page got this answer.'
		);
		expect(browserNotificationsReply('stage.example.com', 'denied')).toContain('are blocked');
		expect(browserNotificationsReply('stage.example.com', 'default')).toBe(
			'Notifications for stage.example.com are undecided again: the page asks the next time it requests them.'
		);
	});
});
