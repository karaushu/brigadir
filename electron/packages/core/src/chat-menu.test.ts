import { describe, expect, it } from 'vitest';
import { chatMenuItems, isChatMenuState, type ChatMenuState } from './chat-menu';
import { t } from './messages';

const none: ChatMenuState = {
	selection: false,
	link: null,
	line: false,
	code: false,
	image: false,
	message: false,
};
const ids = (state: ChatMenuState) =>
	chatMenuItems(state).map((item) => (item ? `${item.id}${item.enabled ? '' : ' (off)'}` : '-'));

describe('chat menu (spec/chat#context-menu)', () => {
	it('opens no menu when nothing under the click can be copied or opened', () => {
		expect(chatMenuItems(none)).toEqual([]);
	});
	it('keeps Copy and disables it without a selection', () => {
		expect(ids({ ...none, message: true })).toEqual(['copy (off)', '-', 'copy-message']);
		expect(ids({ ...none, selection: true })).toEqual(['copy']);
		expect(chatMenuItems({ ...none, selection: true })[0]?.accelerator).toBe('CmdOrCtrl+C');
	});
	it('groups by target: link first, then Copy, then the block and the message', () => {
		expect(ids({ ...none, link: 'web', selection: true, message: true })).toEqual([
			'open-link',
			'copy-link',
			'-',
			'copy',
			'-',
			'copy-message',
		]);
		expect(ids({ ...none, code: true, message: true })).toEqual([
			'copy (off)',
			'-',
			'copy-code',
			'copy-message',
		]);
		expect(ids({ ...none, image: true, message: true })).toEqual([
			'copy (off)',
			'-',
			'copy-image',
			'copy-message',
		]);
	});
	it('offers the PR panel and the browser for a PR page (spec/pull-requests-and-ci#pr-links)', () => {
		expect(ids({ ...none, link: 'pr' })).toEqual([
			'open-link',
			'open-browser',
			'copy-link',
			'-',
			'copy (off)',
		]);
		expect(isChatMenuState({ ...none, link: 'pr' })).toBe(true);
	});
	it('offers path:line only for a path with a line', () => {
		expect(ids({ ...none, link: 'file', message: true })).toEqual([
			'open-file',
			'copy-path',
			'-',
			'copy (off)',
			'-',
			'copy-message',
		]);
		expect(ids({ ...none, link: 'file', line: true })).toEqual([
			'open-file',
			'copy-path',
			'copy-line',
			'-',
			'copy (off)',
		]);
		// spec/chat#folder-links: a folder shows in Files; it names no line.
		expect(
			chatMenuItems({ ...none, link: 'folder' }).flatMap((item) =>
				item ? [t('uk', item.label)] : []
			)
		).toEqual(['Показати у Файлах', 'Копіювати відносний шлях', 'Копіювати']);
		expect(isChatMenuState({ ...none, link: 'folder' })).toBe(true);
	});
	it('names every item in both languages, in the editor menu terms', () => {
		const all = chatMenuItems({
			selection: true,
			link: 'web',
			line: true,
			code: true,
			image: true,
			message: true,
		});
		for (const item of all) if (item) expect(t('uk', item.label)).toBeTruthy();
		expect(all.flatMap((item) => (item ? [t('uk', item.label)] : []))).toEqual([
			'Відкрити посилання',
			'Копіювати посилання',
			'Копіювати',
			'Копіювати код',
			'Копіювати зображення',
			'Копіювати повідомлення',
		]);
		expect(
			chatMenuItems({ ...none, link: 'file', line: true }).flatMap((item) =>
				item ? [t('uk', item.label)] : []
			)
		).toEqual([
			'Відкрити в редакторі',
			'Копіювати відносний шлях',
			'Копіювати шлях:рядок',
			'Копіювати',
		]);
	});
	it('validates the IPC state', () => {
		expect(isChatMenuState(none)).toBe(true);
		expect(isChatMenuState({ ...none, link: 'file', line: true })).toBe(true);
		expect(isChatMenuState({ ...none, link: 'ftp' })).toBe(false);
		expect(isChatMenuState({ ...none, extra: true })).toBe(false);
		expect(isChatMenuState({ ...none, message: 'yes' })).toBe(false);
		expect(isChatMenuState(null)).toBe(false);
	});
});
