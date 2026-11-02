import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const boxes = vi.hoisted(() => [] as { window: unknown; options: Record<string, unknown> }[]);
vi.mock('electron', () => ({
	Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
	clipboard: { writeText: () => {} },
	dialog: {
		showMessageBox: async (...args: unknown[]) => {
			const options = args.pop() as Record<string, unknown>;
			boxes.push({ window: args[0], options });
			return { response: 1 };
		},
	},
	shell: {},
	nativeImage: { createEmpty: () => ({}) },
}));
import {
	ClientUi,
	createFolder,
	deviceRoleLabels,
	electronUi,
	listFolder,
	messageBox,
	type NativeUi,
} from './client-ui';
import type { Client } from './clients';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** A device connection: what it was sent, and whether the connection took it. */
function device(id = 'peer-1', open = true) {
	const sent: { channel: string; value: any }[] = [];
	const client: Client = {
		id,
		local: false,
		device: { id: 'd'.repeat(64), name: 'ThinkPad' },
		events: 'remote',
		send: (channel, value) => {
			sent.push({ channel, value });
			return open;
		},
		owns: () => false,
	};
	return { client, sent };
}
const native: NativeUi & { calls: string[] } = {
	calls: [],
	async menu() {
		native.calls.push('menu');
		return 'local';
	},
	async box() {
		native.calls.push('box');
		return 1;
	},
	async pick() {
		native.calls.push('pick');
		return '/local';
	},
	async save() {
		native.calls.push('save');
		return true;
	},
};
const local: Client = { id: 'local', local: true, send: () => true, owns: () => false };

describe('ClientUi (spec/remote-access-and-mobile#client-ui-seam)', () => {
	it('shows natively over a window of this machine and never sends a local menu anywhere', async () => {
		const ui = new ClientUi(native);
		expect(await ui.menu(local, [{ id: 'a', label: 'A' }])).toBe('local');
		expect(await ui.ask(local, box)).toBe(1);
		expect(await ui.pick(local, { target: 'folder', title: 'x', extensions: null })).toBe('/local');
		expect(native.calls).toEqual(['menu', 'box', 'pick']);
	});
	it('hands a device its menu as data without reveal items and takes back only an item it offered', async () => {
		const ui = new ClientUi(native),
			{ client, sent } = device();
		const chosen = ui.menu(client, [
			{ id: 'open', label: 'Open' },
			{ id: 'off', label: 'Off', enabled: false },
			{ id: 'copy', label: 'Copy', copy: '/x' },
			null,
			{ id: 'finder', label: 'Reveal', reveal: '/x' },
		]);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.channel).toBe('remote:menu');
		const menu = sent[0]!.value;
		expect(menu.items.map((item: any) => item?.id ?? null)).toEqual(['open', 'off', 'copy']);
		// Another device, an item that was not there, a disabled one, a copy item: all cancel.
		await ui.answer(device('peer-2').client, menu.id, 'open');
		await ui.answer(client, menu.id, 'off');
		expect(await chosen).toBeNull();
		const again = ui.menu(client, [{ id: 'open', label: 'Open' }]);
		await ui.answer(client, sent[1]!.value.id, 'open');
		expect(await again).toBe('open');
	});
	it('answers a message box with a button it has, or its cancel', async () => {
		const ui = new ClientUi(native),
			{ client, sent } = device();
		const first = ui.ask(client, box);
		expect(sent[0]).toMatchObject({ channel: 'remote:dialog', value: { kind: 'box', ...box } });
		await ui.answer(client, sent[0]!.value.id, 7);
		expect(await first).toBe(0);
		const second = ui.ask(client, box);
		await ui.answer(client, sent[1]!.value.id, 1);
		expect(await second).toBe(1);
	});
	it('takes a chosen path only when it is the folder or file the choice asked for', async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-client-ui-'));
		roots.push(root);
		await mkdir(join(root, 'repo'));
		await writeFile(join(root, 'template.json'), '{}');
		await writeFile(join(root, 'notes.txt'), 'x');
		const ui = new ClientUi(native),
			{ client, sent } = device();
		const folder = ui.pick(client, {
			target: 'folder',
			title: 'Add a project from studio',
			extensions: null,
		});
		const id = sent[0]!.value.id;
		expect(ui.openPick(client, id)).toMatchObject({ target: 'folder' });
		expect(ui.openPick(device('peer-2').client, id)).toBeNull();
		await ui.answer(client, id, join(root, 'notes.txt'));
		expect(await folder).toBeNull();
		expect(ui.openPick(client, id)).toBeNull();
		const file = ui.pick(client, { target: 'file', title: 'Import', extensions: ['json'] });
		await ui.answer(client, sent[1]!.value.id, join(root, 'template.json'));
		expect(await file).toBe(join(root, 'template.json'));
		const dotted = ui.pick(client, { target: 'folder', title: 'x', extensions: null });
		await ui.answer(client, sent[2]!.value.id, `${root}/repo/../repo`);
		expect(await dotted).toBeNull();
	});
	it('cancels what a device was asked when it goes away or did not get it', async () => {
		const ui = new ClientUi(native),
			{ client } = device();
		const menu = ui.menu(client, [{ id: 'a', label: 'A' }]),
			asked = ui.ask(client, box),
			save = ui.save(client, {
				name: 'a.json',
				extensions: ['json'],
				filterName: 'JSON',
				text: '{}',
			});
		ui.forget(client);
		expect(await menu).toBeNull();
		expect(await asked).toBe(0);
		expect(await save).toBe(false);
		const gone = device('peer-3', false);
		expect(await ui.ask(gone.client, box)).toBe(0);
	});
	it('replaces a request of the same kind', async () => {
		const ui = new ClientUi(native),
			{ client } = device();
		const first = ui.menu(client, [{ id: 'a', label: 'A' }]);
		void ui.menu(client, [{ id: 'b', label: 'B' }]);
		expect(await first).toBeNull();
	});
	it('sends a save to the device without the native filter name', async () => {
		const ui = new ClientUi(native),
			{ client, sent } = device();
		const saved = ui.save(client, {
			name: 'Reviewer.json',
			extensions: ['json'],
			filterName: 'JSON',
			text: '{}\n',
		});
		expect(sent[0]).toEqual({
			channel: 'remote:save',
			value: { id: sent[0]!.value.id, name: 'Reviewer.json', extensions: ['json'], text: '{}\n' },
		});
		await ui.answer(client, sent[0]!.value.id, true);
		expect(await saved).toBe(true);
	});
});

describe('the folder browser reads (spec/remote-access-and-mobile#client-ui-seam)', () => {
	it('lists folders first, marks git and hidden names, and files only for a file choice', async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-folders-'));
		roots.push(root);
		await mkdir(join(root, 'choice', '.git'), { recursive: true });
		await mkdir(join(root, 'scratch'));
		await mkdir(join(root, '.config'));
		await writeFile(join(root, 'crew.json'), '{}');
		await writeFile(join(root, 'notes.txt'), 'x');
		const folders = await listFolder({ target: 'folder', extensions: null }, root, false);
		expect(folders.entries.map((entry) => [entry.name, entry.kind, entry.git])).toEqual([
			['choice', 'directory', true],
			['scratch', 'directory', false],
		]);
		expect(folders.parent).toBe(join(root, '..').replace(/\/$/, ''));
		const withHidden = await listFolder({ target: 'folder', extensions: null }, root, true);
		expect(withHidden.entries.find((entry) => entry.name === '.config')?.hidden).toBe(true);
		const files = await listFolder({ target: 'file', extensions: ['json'] }, root, false);
		expect(files.entries.map((entry) => entry.name)).toEqual(['choice', 'scratch', 'crew.json']);
		expect(await createFolder(root, 'new one')).toBe(join(root, 'new one'));
		await expect(createFolder(root, 'new one')).rejects.toThrow();
	});
});

const box = {
	type: 'warning' as const,
	message: 'Delete task… Fix',
	detail: 'Local history will move to Trash.',
	buttons: ['Cancel', 'Delete task'],
	defaultId: 0,
	cancelId: 0,
	danger: 1,
};

describe('security review R2–R4, V7: a machine’s menu on the device', () => {
	it('names a role item with the device’s own word, whatever the machine called it', () => {
		const words = {
			cut: 'Вирізати',
			copy: 'Копіювати',
			paste: 'Вставити',
			selectAll: 'Вибрати все',
		};
		expect(
			deviceRoleLabels(
				[
					{ id: 'open', label: 'Open the task', role: 'paste' },
					null,
					{ id: 'rename', label: 'Rename' },
				],
				(role) => words[role]
			)
		).toEqual([
			{ id: 'open', label: 'Вставити', role: 'paste' },
			null,
			{ id: 'rename', label: 'Rename' },
		]);
	});
});

describe('security review R2–R4, P1: a page that floods the device with dialogs', () => {
	it('takes «Don’t show more dialogs» only when it was offered, and cancels to no tick', async () => {
		const ui = new ClientUi(native),
			{ client, sent } = device();
		const page = { site: 'evil.example', message: 'Again', value: '' };
		const offered = ui.page(client, { ...page, type: 'confirm', mute: true });
		await ui.answer(client, sent[0]!.value.id, { value: true, mute: true });
		expect(await offered).toEqual({ answer: true, mute: true });
		// Not offered: the tick a device sends anyway does not count.
		const plain = ui.page(client, { ...page, type: 'prompt', mute: false });
		await ui.answer(client, sent[1]!.value.id, { value: 'Ada', mute: true });
		expect(await plain).toEqual({ answer: 'Ada', mute: false });
		const gone = ui.page(client, { ...page, type: 'alert', mute: true });
		ui.forget(client);
		expect(await gone).toEqual({ answer: null, mute: false });
	});
});
describe('message boxes (spec/appearance#dialogs)', () => {
	it('asks Windows for plain buttons, not command links, with a window and without one', async () => {
		boxes.length = 0;
		const window = {} as never;
		expect(await electronUi.box(window, box)).toBe(1);
		await messageBox(null, { message: 'x', buttons: ['Cancel', 'Delete task'] });
		expect(boxes.map((call) => [call.window, call.options.noLink])).toEqual([
			[window, true],
			[undefined, true],
		]);
		expect(boxes[0]!.options).toMatchObject({ message: box.message, buttons: box.buttons });
	});
});
