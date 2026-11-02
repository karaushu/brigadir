import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';
import {
	connectDevice,
	freePorts,
	launch,
	machine,
	menuAction,
	openRemoteSettings,
} from './remote-fixture';
// spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#module-and-settings: the working machine turns access on with a password and shows a code; the device pairs by the code,
// connects with the password and gets a window of the working machine; the machine's own window is covered until
// «Take back»; the device sees that control was taken; revoking the device closes its connection.
test('pairs a device by code, connects it, covers the machine and revokes it @area:settings', async () => {
	test.setTimeout(120_000);
	const port = await freePorts();
	const studio = await machine('studio', true, 'Remote fixture task'),
		thinkpad = await machine('ThinkPad', true, null);
	const work = await launch(studio, port),
		device = await launch(thinkpad, port + 10);
	try {
		const page = await work.firstWindow(),
			client = await device.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(`studio: ${error.message}`));
		client.on('pageerror', (error) => errors.push(`ThinkPad: ${error.message}`));
		await expect(page.getByRole('button', { name: /Remote fixture task/ })).toBeVisible();
		// spec/appearance#evolution-redesign: with access off there is no Remote button in the bar.
		const chip = page.locator('[data-remote-chip="idle"] button');
		await expect(chip).toHaveCount(0);

		// The working machine: Settings ▸ Modules ▸ Remote access ⚙ (spec/settings-modules-and-onboarding#module-settings-popup), the switch, a password twice.
		await menuAction(work, 'settings');
		const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
		await expect(settings.getByRole('tab')).toHaveCount(7);
		const remoteSettings = await openRemoteSettings(page);
		// spec/settings-modules-and-onboarding#intro-remote: the intro's scheme and facts over the switch.
		await expect(remoteSettings.locator('[data-remote-scheme]')).toContainText('studio');
		await expect(remoteSettings.locator('[data-remote-facts] li')).toHaveCount(2);
		await expect(remoteSettings.locator('[data-remote-facts] [data-tailscale-link]')).toHaveText(
			'Download Tailscale'
		);
		await remoteSettings.getByRole('switch', { name: 'Allow control from other devices' }).click();
		const password = 'correct horse battery';
		await remoteSettings.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
		await remoteSettings.getByRole('textbox', { name: 'Repeat the password' }).fill(password);
		await remoteSettings.locator('[data-remote-enable]').click();
		await expect(remoteSettings.locator('[data-remote-status]')).toContainText('127.0.0.1');
		// The Remote icon in the window bar: access is on, nobody is connected — a grey dot, the machine in the hint.
		await expect(chip).toHaveAttribute('data-remote-on', 'true');
		await expect(chip).toHaveText('');
		await expect(chip).toHaveAttribute('data-dot-at', 'bottom');
		await expect(chip).toHaveAttribute(
			'title',
			/^studio · Listening · .*\nRemote access and other machines · /
		);

		// «Add device»: a code for 5 minutes.
		await remoteSettings.locator('[data-remote-add]').click();
		const pairDialog = page.locator('[data-remote-pair]');
		await expect(pairDialog.locator('[data-remote-code]')).toBeVisible();
		const code = (await pairDialog.locator('[data-remote-code]').getAttribute('data-remote-code'))!;
		expect(code).toMatch(/^[0-9A-Z]{8}$/);

		// The device: its access is off, so no Remote button (spec/appearance#evolution-redesign); File ▸ Connect… (⌥⌘O) opens the list
		// «Connect» (spec/remote-access-and-mobile#remote-button): «New machine…» ▸ Enter an address…, the code in 8 cells.
		await expect(client.locator('[data-remote-chip]')).toHaveCount(0);
		await menuAction(device, 'connect');
		const connect = client.locator('dialog[data-remote-connect]');
		await connect.locator('[data-remote-new]').click();
		await expect(connect).toHaveAttribute('data-remote-connect', 'new');
		await connect.locator('[data-remote-address]').click();
		await connect.getByRole('textbox', { name: 'Address', exact: true }).fill('127.0.0.1');
		await connect.getByRole('textbox', { name: 'Port', exact: true }).fill(String(port));
		await connect.getByRole('button', { name: 'Next', exact: true }).click();
		await expect(connect).toHaveAttribute('data-remote-connect', 'code');
		// A pasted code spreads over the cells and pairs by itself.
		await connect.getByRole('textbox', { name: 'Code character 1' }).focus();
		await client.keyboard.type(`${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase());
		await expect(connect).toHaveAttribute('data-remote-connect', 'wait');
		await expect(connect).toContainText('Waiting for confirmation on studio');

		// The machine's person confirms the name the device sent.
		await expect(pairDialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
			'ThinkPad'
		);
		await pairDialog.locator('[data-remote-pair-accept]').click();
		await expect(pairDialog).toHaveCount(0);
		await expect(remoteSettings.locator('[data-remote-device="ThinkPad"]')).toBeVisible();
		// Esc closes the popup, back to Settings ▸ Modules; the second closes Settings.
		await page.keyboard.press('Escape');
		await expect(remoteSettings).toBeHidden();
		await page.keyboard.press('Escape');
		await expect(settings).toBeHidden();

		// The device: paired, the password, a window of studio.
		await expect(connect).toHaveAttribute('data-remote-connect', 'paired');
		const opened = device.waitForEvent('window');
		await connect.locator('[data-remote-password]').fill(password);
		await connect.locator('[data-remote-password]').press('Enter');
		const remote = await opened;
		remote.on('pageerror', (error) => errors.push(`studio on ThinkPad: ${error.message}`));
		await expect(connect).toHaveCount(0);
		await expect(remote.getByRole('button', { name: /Remote fixture task/ })).toBeVisible();
		// spec/remote-access-and-mobile#remote-button: the other machine's window has the Remote icon; its name is in the label and the system hint.
		await expect(remote.locator('[data-remote-chip] button').first()).toHaveAttribute(
			'aria-label',
			/studio/
		);
		expect(
			await device.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows().map((window) => window.getTitle())
			)
		).toContain('studio — Brigadir');

		// The working machine is under its cover until «Take back».
		const cover = page.locator('[data-remote-cover]');
		await expect(cover).toBeVisible();
		await expect(cover).toContainText('Controlled from ThinkPad');
		await cover.locator('[data-remote-take-back]').click();
		await expect(cover).toHaveCount(0);
		await expect(remote.locator('[data-remote-state="taken"]')).toContainText(
			'Control was taken back on studio'
		);
		// «Take control again» from the device: the cover comes back.
		await remote.locator('[data-remote-take-again]').click();
		await expect(remote.locator('[data-remote-state]')).toHaveCount(0);
		await expect(cover).toBeVisible();
		await cover.locator('[data-remote-take-back]').click();
		await expect(cover).toHaveCount(0);

		// spec/remote-access-and-mobile#remote-button: remote access settings ▸ Connect to another lists studio with its window open (the device's access is
		// off, so it has no Remote button, spec/appearance#evolution-redesign).
		await expect(client.locator('[data-remote-chip="idle"]')).toHaveCount(0);
		await menuAction(device, 'settings');
		const deviceRemote = await openRemoteSettings(client);
		await deviceRemote.getByRole('tab', { name: 'Connect to another', exact: true }).click();
		const studioRow = deviceRemote.locator('[data-remote-peer="studio"]');
		await expect(studioRow).toContainText('window open');
		await expect(studioRow.getByRole('button', { name: 'Show window', exact: true })).toBeVisible();

		// Revoke: the device's connection closes, its window says why.
		await menuAction(work, 'settings');
		const workRemote = await openRemoteSettings(page);
		await workRemote
			.locator('[data-remote-device="ThinkPad"]')
			.getByRole('button', { name: 'Revoke', exact: true })
			.click();
		await expect(workRemote.locator('[data-remote-device]')).toHaveCount(0);
		await expect(remote.locator('[data-remote-state="closed"]')).toContainText(
			'This device was revoked on studio.'
		);
		// The device forgets studio from remote access settings ▸ Connect to another: the part says what to do instead.
		await client.evaluate(
			(id) => window.brigadir.disconnectRemoteMachine(id),
			(await client.evaluate(() => window.brigadir.readRemoteMachines()))[0]!.id
		);
		await expect(studioRow.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
		await studioRow.locator('[data-remote-peer-forget]').click();
		await client
			.getByRole('dialog', { name: 'Forget studio?' })
			.getByRole('button', { name: 'Forget', exact: true })
			.click();
		await expect(deviceRemote.locator('[data-remote-no-machines]')).toContainText(
			'No paired machines yet'
		);
		expect(errors).toEqual([]);
	} finally {
		await device.close();
		await work.close();
	}
});

// spec/remote-access-and-mobile#module-and-settings: with the module off there is no Remote tab, no File ▸ Connect…, no chip; turning it on brings them back.
test('the remote access module switches off whole @area:settings', async () => {
	const at = await machine('studio', false, 'Module fixture');
	const app = await launch(at, await freePorts());
	try {
		const page = await app.firstWindow();
		await expect(page.getByRole('button', { name: /Module fixture/ })).toBeVisible();
		expect(
			await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('connect'))
		).toBeNull();
		await menuAction(app, 'settings');
		const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
		await expect(settings.getByRole('tab')).toHaveCount(7);
		await expect(settings.getByRole('tab', { name: 'Remote', exact: true })).toHaveCount(0);
		await expect(page.locator('[data-remote-chip]')).toHaveCount(0);
		await settings.getByRole('tab', { name: 'Modules', exact: true }).click();
		await settings.getByRole('switch', { name: 'Remote access', exact: true }).click();
		await expect(settings.getByRole('tab')).toHaveCount(7);
		// spec/settings-modules-and-onboarding#module-settings-popup: no Remote tab; the module's ⚙ opens its settings while it is on.
		await expect(settings.locator('[data-module-settings-button="remoteAccess"]')).toBeVisible();
		await expect
			.poll(() =>
				app.evaluate(
					({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('connect')?.label ?? null
				)
			)
			.toBe('Connect…');
		// The menu item is the third of File, after Open Recent.
		expect(
			await app.evaluate(({ Menu }) =>
				Menu.getApplicationMenu()!
					.items.find((item) => item.label === 'File')!
					.submenu!.items.slice(0, 3)
					.map((item) => item.id)
			)
		).toEqual(['open-project', 'open-recent', 'connect']);
		// The bridge answers the module's sentence while it is off.
		await settings.getByRole('switch', { name: 'Remote access', exact: true }).click();
		await expect(settings.locator('[data-module-settings-button="remoteAccess"]')).toHaveCount(0);
		await expect(page.evaluate(() => window.brigadir.readRemoteMachines())).rejects.toThrow(
			/Remote access is off in Settings/
		);
	} finally {
		await app.close();
	}
});

// «Does not answer»: Try again repeats the last try with the same password instead of staying disabled.
test('a machine that does not answer can be tried again with the same password @area:settings', async () => {
	test.setTimeout(150_000);
	const port = await freePorts();
	const studio = await machine('studio', true, 'Retry fixture task'),
		thinkpad = await machine('ThinkPad', true, null);
	const work = await launch(studio, port),
		device = await launch(thinkpad, port + 10);
	try {
		const { client, remote } = await connectDevice(work, device, port);
		await remote.close();
		await client.evaluate(
			async () =>
				await window.brigadir.disconnectRemoteMachine(
					(await window.brigadir.readRemoteMachines())[0]!.id
				)
		);
		await work.close();
		await menuAction(device, 'connect');
		// The only paired machine is chosen already, its password open.
		const connect = client.locator('dialog[data-remote-connect]');
		await connect.locator('[data-remote-password]').fill('correct horse battery');
		await connect.locator('[data-remote-password]').press('Enter');
		const retry = connect.locator('[data-remote-retry]');
		await expect(retry).toBeVisible({ timeout: 60_000 });
		await expect(connect).toContainText('studio does not answer');
		await expect(retry).toBeEnabled();
		await retry.click();
		// The same password goes again: the block comes back after the second try, not an empty password field.
		await expect(retry).toBeVisible({ timeout: 60_000 });
		await expect(retry).toBeEnabled();
		await expect(connect.locator('[data-remote-password]')).toHaveCount(0);
	} finally {
		await device.close();
		await work.close().catch(() => {});
	}
});

/** The device's next native menu: its labels are kept, and the item `choose` is clicked (none — the menu closes). */
async function nextMenu(device: ElectronApplication, choose: string | null) {
	await device.evaluate(({ Menu }, choose) => {
		const original = Menu.buildFromTemplate;
		(globalThis as any).deviceMenu = null;
		Menu.buildFromTemplate = ((template: any[]) => {
			Menu.buildFromTemplate = original;
			(globalThis as any).deviceMenu = template.map((item) => item.label ?? '-');
			return {
				popup: ({ callback }: any) => {
					const item = template.find((entry) => entry.label === choose);
					if (choose && !item) throw new Error(`No menu item ${choose}`);
					item?.click?.();
					callback?.();
				},
			} as any;
		}) as any;
	}, choose);
	return () =>
		expect.poll(() => device.evaluate(() => (globalThis as any).deviceMenu as string[] | null));
}

// spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#client-ui-seam: a device's context menus show on the device and act on the machine; the machine's message
// boxes become the device's modal dialog; `Add a project` browses the machine's folders; files dropped and pasted on the
// device become attachments on the machine; copy, links and saves stay on the device. Nothing opens on the machine.
test('the machine asks the device to show its menus, dialogs and folders, and takes its files @area:settings @serial', async () => {
	test.setTimeout(180_000);
	const port = await freePorts();
	const studio = await machine('studio', true, 'Remote fixture task'),
		thinkpad = await machine('ThinkPad', true, null);
	// The folder browser starts in the machine's home: a known one here.
	const home = join(studio.root, 'home');
	await mkdir(join(home, 'projects/shop/.git'), { recursive: true });
	await mkdir(join(home, 'devel/new-project'), { recursive: true });
	const work = await launch(studio, port, { HOME: home }),
		device = await launch(thinkpad, port + 10);
	try {
		const screen = await watchScreen(work);
		const { page, remote } = await connectDevice(work, device, port);
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(`studio: ${error.message}`));
		remote.on('pageerror', (error) => errors.push(`studio on ThinkPad: ${error.message}`));
		const row = remote.getByRole('button', { name: /Remote fixture task/ });
		await expect(row).toBeVisible();
		await device.evaluate(({ shell }) => {
			const opened: string[] = ((globalThis as any).deviceOpened = []);
			shell.openExternal = (async (url: string) => {
				opened.push(url);
			}) as any;
		});

		// The task menu of the machine shows on the device; «Pin task» pins it on the machine.
		let labels = await nextMenu(device, 'Pin task');
		await row.click({ button: 'right' });
		await labels().toEqual(
			expect.arrayContaining(['Open task', 'Copy task title', 'Delete task…'])
		);
		// The machine's data changed: the window of it on the device reads it back.
		await expect(remote.locator('[data-pinned="true"]').first()).toBeVisible();

		// «Copy task title» writes the device's clipboard, not the machine's.
		await device.evaluate(({ clipboard }) => clipboard.writeText(''));
		labels = await nextMenu(device, 'Copy task title');
		await row.click({ button: 'right' });
		await labels().toContain('Copy task title');
		await expect
			.poll(() => device.evaluate(({ clipboard }) => clipboard.readText()))
			.toBe('Remote fixture task');

		// The project menu has no «Reveal in Finder» on a device.
		labels = await nextMenu(device, null);
		await remote
			.locator('aside')
			.getByRole('button', { name: 'repo', exact: true })
			.click({ button: 'right' });
		await labels().toEqual(expect.arrayContaining(['New task', 'Copy path']));
		expect(await device.evaluate(() => (globalThis as any).deviceMenu)).not.toContain(
			'Reveal in Finder'
		);

		// «Delete task…»: the machine's question is the device's modal dialog; Cancel keeps the task.
		labels = await nextMenu(device, 'Delete task…');
		await row.click({ button: 'right' });
		const box = remote.locator('dialog[data-remote-box]');
		await expect(box).toBeVisible();
		await expect(box).toContainText('Remote fixture task');
		await box.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(box).toHaveCount(0);
		await expect(page.getByRole('button', { name: /Remote fixture task/ })).toBeVisible();

		// The chip's «Choose a folder on studio…»: the folder browser of the machine, «New folder…», then a project.
		await remote.locator('[data-remote-chip] button').first().click();
		await expect(remote.locator('[data-remote-choose-folder]')).toBeEnabled();
		// spec/remote-access-and-mobile#remote-button: «Go to» — this computer's task window by its own name, studio as this window.
		await expect(remote.locator('[data-remote-go-home]')).toContainText('ThinkPad');
		await expect(remote.getByRole('menuitemradio', { name: /studio/ })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await remote.locator('[data-remote-choose-folder]').click();
		const browser = remote.locator('dialog[data-remote-folder="folder"]');
		await expect(browser).toBeVisible();
		await browser.locator('[data-folder-row="devel"]').dblclick();
		await expect(browser.locator('[data-folder-row="shop"]')).toHaveAttribute('data-git', 'true');
		await browser.locator('[data-folder-row="new-project"]').click();
		await expect(browser.locator('[data-remote-folder-path]')).toHaveText(
			join(home, 'devel/new-project')
		);
		await browser.getByRole('button', { name: 'New folder…', exact: true }).click();
		await browser.getByRole('textbox', { name: 'Folder name', exact: true }).fill('made-here');
		await browser.getByRole('textbox', { name: 'Folder name', exact: true }).press('Enter');
		await expect(browser.locator('[data-folder-row="made-here"]')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		expect(existsSync(join(home, 'devel/made-here'))).toBe(true);
		await browser.locator('[data-folder-row="new-project"]').click();
		await browser.locator('[data-remote-folder-choose]').click();
		await expect(browser).toHaveCount(0);
		await expect(
			remote.locator('aside').getByRole('button', { name: 'new-project', exact: true })
		).toBeVisible();

		// Files of the device dropped and pasted into a new task sheet of the machine: attachments there.
		await remote.locator('aside').getByRole('button', { name: 'repo', exact: true }).click();
		await remote.evaluate(() => window.brigadir.dispatchWorkspaceAction('new-task'));
		const sheet = remote.getByRole('dialog', { name: 'New task', exact: true });
		await expect(sheet).toBeVisible();
		const png = await device.evaluate(({ nativeImage }) =>
			nativeImage
				.createFromBitmap(Buffer.alloc(20 * 10 * 4, 0x80), { width: 20, height: 10 })
				.toPNG()
				.toString('base64')
		);
		await writeFile(join(thinkpad.root, 'shot.png'), Buffer.from(png, 'base64'));
		await writeFile(join(thinkpad.root, 'notes.txt'), 'notes from ThinkPad\n');
		await remote.evaluate(() => {
			const input = document.createElement('input');
			input.type = 'file';
			input.multiple = true;
			input.id = 'finder';
			input.hidden = true;
			document.body.append(input);
		});
		await remote.setInputFiles('#finder', [
			join(thinkpad.root, 'shot.png'),
			join(thinkpad.root, 'notes.txt'),
		]);
		await sheet.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node) => {
			const transfer = new DataTransfer();
			for (const file of (document.getElementById('finder') as HTMLInputElement).files!)
				transfer.items.add(file);
			node.dispatchEvent(
				new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
			);
		});
		const drafts = join(studio.data, 'drafts/project');
		await expect
			.poll(async () => (await attachmentKinds(drafts)).sort())
			.toEqual(['image', 'text']);
		const uploads = join(studio.data, 'projects/project/uploads');
		const [upload] = await readdir(uploads);
		expect(await readFile(join(uploads, upload!, 'notes.txt'), 'utf8')).toBe(
			'notes from ThinkPad\n'
		);
		expect(existsSync(join(thinkpad.data, 'drafts'))).toBe(false);
		// A picture on the device's clipboard, pasted into the sheet.
		await device.evaluate(({ clipboard, nativeImage }) => {
			const bytes = nativeImage
				.createFromBitmap(Buffer.alloc(8 * 8 * 4, 0x40), { width: 8, height: 8 })
				.toPNG();
			(clipboard as any).read = async () => [
				{
					types: ['image/png'],
					getType: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
				},
			];
		});
		await sheet.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([new Uint8Array([1])], 'image.png', { type: 'image/png' }));
			node.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
			);
		});
		await expect.poll(async () => (await attachmentKinds(drafts)).length).toBe(3);
		await remote.keyboard.press('Escape');

		// A link opens on the device; the machine's own browser and DevTools are not a device's to open.
		await remote.evaluate(() => window.brigadir.openWebLink('https://example.com/r2'));
		await expect
			.poll(() => device.evaluate(() => (globalThis as any).deviceOpened as string[]))
			.toEqual(['https://example.com/r2']);
		await expect(
			remote.evaluate(() =>
				window.brigadir.browserCommand({ projectId: 'project', id: 'task' }, { kind: 'external' })
			)
		).rejects.toThrow(/Not available from a remote device/);

		// A template saved from the machine lands on the device's disk.
		const target = join(thinkpad.root, 'exported.json');
		await device.evaluate(({ dialog }, target) => {
			dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as any;
		}, target);
		expect(
			await remote.evaluate(async () => {
				const library = await window.brigadir.readTemplates();
				return window.brigadir.exportTemplate('agent', library.agents[0]!.id);
			})
		).toBe(true);
		expect(JSON.parse(await readFile(target, 'utf8')).schemaVersion).toBe(1);

		expect(await screen()).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await device.close();
		await work.close();
	}
});

/** The kinds of the attachments in the machine's sheet drafts. */
async function attachmentKinds(drafts: string): Promise<string[]> {
	const kinds: string[] = [];
	for (const draft of await readdir(drafts).catch(() => [] as string[]))
		for (const id of await readdir(join(drafts, draft, 'attachments')).catch(
			() => [] as string[]
		)) {
			const doc = JSON.parse(
				await readFile(join(drafts, draft, 'attachments', id, 'attachment.json'), 'utf8')
			);
			kinds.push(doc.attachment.kind);
		}
	return kinds;
}

/** Everything that would open on the working machine's screen, recorded instead of shown (spec/remote-access-and-mobile#client-ui-seam, spec/remote-access-and-mobile#browser-from-device). */
async function watchScreen(app: ElectronApplication) {
	await app.evaluate(({ Menu, dialog, shell, clipboard }) => {
		const opened: string[] = ((globalThis as any).screenOpened = []);
		const build = Menu.buildFromTemplate.bind(Menu);
		Menu.buildFromTemplate = ((template: any) => {
			const menu = build(template);
			menu.popup = ((options: any) => {
				opened.push(`menu: ${template.map((item: any) => item.label ?? '-').join(', ')}`);
				options?.callback?.();
			}) as any;
			return menu;
		}) as any;
		for (const name of ['showMessageBox', 'showOpenDialog', 'showSaveDialog'] as const)
			(dialog as any)[name] = async () => {
				opened.push(name);
				return { response: 0, canceled: true, filePaths: [] };
			};
		for (const name of ['openExternal', 'showItemInFolder', 'openPath'] as const)
			(shell as any)[name] = async () => {
				opened.push(name);
				return '';
			};
		for (const name of ['writeText', 'readText'] as const)
			(clipboard as any)[name] = () => {
				opened.push(`clipboard ${name}`);
				return '';
			};
	});
	return () => app.evaluate(() => (globalThis as any).screenOpened as string[]);
}
/** The device's clipboard without the system one: what it was given, what it holds. */
async function fakeClipboard(app: ElectronApplication, text: string) {
	await app.evaluate(({ clipboard }, text) => {
		const state = ((globalThis as any).deviceClipboard = { text, written: [] as string[] });
		(clipboard as any).readText = () => state.text;
		(clipboard as any).writeText = (value: string) => {
			state.written.push(value);
			state.text = value;
		};
	}, text);
	return () =>
		app.evaluate(() => (globalThis as any).deviceClipboard as { text: string; written: string[] });
}
/** Runs in the machine's page (its WebContentsView), found by its address. */
function inPage(app: ElectronApplication, url: string, script: string) {
	return app.evaluate(
		({ webContents }, { url, script }) => {
			const web = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url));
			return web ? web.executeJavaScript(script) : null;
		},
		{ url, script }
	);
}
/** The colour of the device's canvas at a point of the page (CSS pixels), by its strongest channel (the frames are lossy). */
function pixel(remote: Page, x: number, y: number) {
	return remote.evaluate(
		({ x, y }) => {
			const canvas = document.querySelector('canvas[data-browser-screen]') as HTMLCanvasElement;
			const scale = canvas.width / canvas.getBoundingClientRect().width;
			const [r = 0, g = 0, b = 0] = canvas
				.getContext('2d')!
				.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
			const top = Math.max(r, g, b);
			return top < 120 ? 'dark' : top === r ? 'red' : top === g ? 'green' : 'blue';
		},
		{ x, y }
	);
}
const fixturePage = `<!doctype html><meta charset="utf-8"><title>Stream fixture</title>
<style>html,body{margin:0;height:100%;font:16px system-ui}#pad{position:fixed;inset:0;background:rgb(200,30,30)}
#field{position:fixed;left:20px;top:20px;width:300px;height:40px;font-size:20px}
#paint{position:fixed;left:20px;top:80px;width:200px;height:60px}
#file{position:fixed;left:20px;top:160px;width:240px;height:30px}
#out{position:fixed;left:20px;top:210px;display:block;width:120px;height:30px;background:white}
#log{position:fixed;left:360px;top:20px;margin:0;color:white}</style>
<div id="pad"></div><input id="field"><button id="paint">Paint</button><input id="file" type="file" accept=".txt">
<a id="out" href="/other" target="_blank">Other</a><pre id="log"></pre>
<script>
const log = (text) => { document.getElementById('log').textContent += text + '\\n'; };
let painted = 0;
document.getElementById('paint').onclick = () => { document.getElementById('pad').style.background = ++painted % 2 ? 'rgb(30,160,60)' : 'rgb(30,60,200)'; };
document.getElementById('file').onchange = async (event) => { for (const file of event.target.files) log('file:' + file.name + ':' + (await file.text()).trim()); };
window.ask = () => { alert('Hello from the page'); log('alert:done'); log('confirm:' + confirm('Sure?')); log('prompt:' + prompt('Name?', 'x')); };
window.spin = (ms) => { const pad = document.getElementById('pad'), end = performance.now() + ms; let n = 0;
  const step = () => { pad.style.background = 'hsl(' + (n++ * 7 % 360) + ',70%,50%)'; if (performance.now() < end) requestAnimationFrame(step); else pad.style.background = 'rgb(200,30,30)'; };
  requestAnimationFrame(step); };
document.addEventListener('copy', () => log('copied'));
</script>`;

// spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#browser-from-device: the device sees the machine's page in a canvas, clicks and types into it, answers its
// dialogs, gives it a file of its own and gets its new windows as tabs; nothing opens on the machine's screen.
test('a device streams the browser of the machine, types into it, answers its dialogs and gives it files @area:settings @serial', async () => {
	test.setTimeout(240_000);
	const server = createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html');
		response.end(
			request.url === '/other'
				? '<!doctype html><title>Other</title><h1>Other page</h1>'
				: fixturePage
		);
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const port = await freePorts();
	const studio = await machine('studio', true, 'Remote fixture task'),
		thinkpad = await machine('ThinkPad', true, null);
	const work = await launch(studio, port, { BRIGADIR_REMOTE_DEBUG: '1' }),
		device = await launch(thinkpad, port + 10);
	try {
		const screen = await watchScreen(work);
		const { page, remote } = await connectDevice(work, device, port);
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(`studio: ${error.message}`));
		remote.on('pageerror', (error) => errors.push(`studio on ThinkPad: ${error.message}`));
		const clipboard = await fakeClipboard(device, 'pasted from ThinkPad');
		await device.evaluate(({ BrowserWindow }) => {
			for (const window of BrowserWindow.getAllWindows())
				if (window.getTitle().startsWith('studio')) window.setSize(1280, 800);
		});
		await remote.getByRole('button', { name: /Remote fixture task/ }).click();
		await remote.evaluate(() => window.brigadir.dispatchWorkspaceAction('browser'));
		const panel = remote.getByRole('region', { name: 'Browser', exact: true });
		await expect(panel).toBeVisible();
		// spec/remote-access-and-mobile#client-ui-seam: the machine's name in the address field.
		await expect(panel.locator('[data-machine-tag]')).toHaveText('studio');
		const address = panel.getByRole('textbox', { name: 'Address' });
		await address.fill(url);
		await address.press('Enter');
		const canvas = panel.locator('canvas[data-browser-screen]');
		await expect(canvas).toBeVisible();
		await expect.poll(() => pixel(remote, 250, 450), { timeout: 15_000 }).toBe('red');
		// The page is drawn for the device alone: no view of it in the machine's window, no invisible window.
		expect(
			await work.evaluate(({ BaseWindow }) =>
				BaseWindow.getAllWindows().map((window) => window.contentView.children.length)
			)
		).toEqual([0]);

		// A click on the canvas reaches the page; the picture changes.
		const box = (await canvas.boundingBox())!;
		await remote.mouse.click(box.x + 120, box.y + 110);
		await expect.poll(() => pixel(remote, 250, 450)).toBe('green');

		// Typing, Backspace, and the device's clipboard for copy and paste.
		await remote.mouse.click(box.x + 150, box.y + 40);
		await remote.keyboard.type('hello');
		await remote.keyboard.press('Backspace');
		await expect
			.poll(() => inPage(work, url, 'document.getElementById("field").value'))
			.toBe('hell');
		await remote.keyboard.press('ControlOrMeta+A');
		await remote.keyboard.press('ControlOrMeta+C');
		await expect.poll(async () => (await clipboard()).written).toEqual(['hell']);
		await device.evaluate(() => {
			(globalThis as any).deviceClipboard.text = 'pasted from ThinkPad';
		});
		await remote.keyboard.press('End');
		await remote.keyboard.press('ControlOrMeta+V');
		await expect
			.poll(() => inPage(work, url, 'document.getElementById("field").value'))
			.toBe('hellpasted from ThinkPad');

		// The page's alert, confirm and prompt: our dialogs on the device, answered back.
		void inPage(work, url, 'setTimeout(() => ask(), 0); true');
		const pageDialog = (type: string) => remote.locator(`dialog[data-remote-page="${type}"]`);
		await expect(pageDialog('alert')).toBeVisible();
		await expect(pageDialog('alert')).toContainText('Hello from the page');
		await pageDialog('alert').getByRole('button', { name: 'OK', exact: true }).click();
		await expect(pageDialog('confirm')).toContainText('Sure?');
		await pageDialog('confirm').getByRole('button', { name: 'OK', exact: true }).click();
		await expect(pageDialog('prompt')).toContainText('Name?');
		await pageDialog('prompt').getByRole('textbox').fill('Ada');
		await pageDialog('prompt').getByRole('button', { name: 'OK', exact: true }).click();
		await expect
			.poll(() => inPage(work, url, 'document.getElementById("log").textContent'))
			.toContain('alert:done\nconfirm:true\nprompt:Ada');
		// The dialog requests are not the page's network.
		expect(
			JSON.stringify(
				await remote.evaluate(
					() =>
						window.brigadir.browserCommand(
							{ projectId: 'project', id: 'task' },
							{ kind: 'network' }
						) as Promise<unknown>
				)
			)
		).not.toContain('brigadir-dialog');

		// The file input: the device's own dialog, its file uploaded to the page.
		const file = join(thinkpad.root, 'notes.txt');
		await writeFile(file, 'notes from ThinkPad\n');
		await device.evaluate(({ dialog }, file) => {
			(globalThis as any).deviceDialogs = [];
			dialog.showOpenDialog = (async (_window: unknown, options: any) => {
				(globalThis as any).deviceDialogs.push(options);
				return { canceled: false, filePaths: [file] };
			}) as any;
		}, file);
		await remote.mouse.click(box.x + 60, box.y + 175);
		await expect
			.poll(() => inPage(work, url, 'document.getElementById("log").textContent'))
			.toContain('file:notes.txt:notes from ThinkPad');
		expect(await device.evaluate(() => (globalThis as any).deviceDialogs[0].filters)).toEqual([
			{ name: 'TXT', extensions: ['txt'] },
		]);

		// spec/remote-access-and-mobile#browser-from-device: under motion the stream keeps coming and stays within its frame cap.
		const frames = () =>
			remote.evaluate(() => ({
				count: Number(
					(document.querySelector('canvas[data-browser-screen]') as HTMLCanvasElement).dataset
						.frames ?? 0
				),
				at: performance.now(),
			}));
		const before = await frames();
		await inPage(work, url, 'spin(3000); true');
		await remote.waitForTimeout(3000);
		const after = await frames();
		const fps = (after.count - before.count) / ((after.at - before.at) / 1000);
		expect(fps).toBeGreaterThan(5);
		expect(fps).toBeLessThanOrEqual(21);

		// `target=_blank`: a new tab of our browser on the device, with that page.
		await remote.mouse.click(box.x + 60, box.y + 225);
		await expect
			.poll(async () =>
				(
					(await remote.evaluate(() =>
						window.brigadir.browserCommand({ projectId: 'project', id: 'task' }, { kind: 'tabs' })
					)) as { url: string }[]
				).map((tab) => tab.url)
			)
			.toContain(`${url}other`);
		// It is in front, streamed like the first.
		await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(
			// spec/task-window-workspace#tool-tab-look: the field at rest has no scheme.
			`${url}other`.replace(/^http:\/\//, '')
		);

		expect(await screen()).toEqual([]);
		expect(await work.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		await device.close();
		await work.close();
		server.close();
	}
});

// The sim-helper framing (spec/browser-and-simulator#simulator) from a stand-in: ready, a config, a recorded key frame on request; stdin logged.
const helperSource = `#!/usr/bin/env node
const fs=require('node:fs');const out=(type,payload)=>{const body=Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));const head=Buffer.alloc(5);head[0]=type;head.writeUInt32BE(body.length,1);process.stdout.write(Buffer.concat([head,body]));};
const log={write:line=>fs.appendFileSync(process.env.HELPER_LOG,line)};
const recorded=JSON.parse(fs.readFileSync(process.env.SIM_FIXTURE_H264,'utf8'));
const config=recorded.config;const frame=Buffer.from(recorded.frame,'base64');
out(1,{event:'ready',width:config.width,height:config.height,pointWidth:402,pointHeight:874});out(2,config);out(3,frame);
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);log.write(line+'\\n');const message=JSON.parse(line);if(message.cmd==='keyframe')out(3,frame);if(typeof message.id==='number')out(1,{event:'reply',id:message.id,result:null});}});
process.stdin.on('end',()=>process.exit(0));
`;
// spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#browser-from-device: the simulator of the machine on a device — its H.264 frames decoded there, touches and
// the device's own clipboard going back, the machine's name in the strip.
test('a device shows the simulator of the machine and pastes its own clipboard into it @area:settings @serial', async () => {
	test.setTimeout(180_000);
	const port = await freePorts();
	const studio = await machine('studio', true, 'Remote fixture task', { simulator: true }),
		thinkpad = await machine('ThinkPad', true, null, { simulator: true });
	const helper = join(studio.root, 'sim-helper'),
		log = join(studio.root, 'helper.log');
	await writeFile(helper, helperSource);
	await chmod(helper, 0o755);
	await writeFile(log, '');
	await writeFile(
		join(studio.root, 'fixture.json'),
		JSON.stringify({
			xcodebuild: 'Xcode 27.0\n',
			helper,
			simctl: {
				devices: {
					'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
						{
							udid: '4900CF11-BDEA-4EC2-BE33-11CE51B20141',
							name: 'iPhone 17 Pro',
							state: 'Shutdown',
						},
					],
				},
			},
		})
	);
	const work = await launch(studio, port, {
			BRIGADIR_TEST_SIMULATOR: join(studio.root, 'fixture.json'),
			HELPER_LOG: log,
			SIM_FIXTURE_H264: resolve('tests/fixtures/sim-frame.json'),
		}),
		device = await launch(thinkpad, port + 10);
	try {
		const screen = await watchScreen(work);
		const { page, remote } = await connectDevice(work, device, port);
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(`studio: ${error.message}`));
		remote.on('pageerror', (error) => errors.push(`studio on ThinkPad: ${error.message}`));
		await fakeClipboard(device, 'from ThinkPad');
		await device.evaluate(({ BrowserWindow }) => {
			for (const window of BrowserWindow.getAllWindows())
				if (window.getTitle().startsWith('studio')) window.setSize(1280, 800);
		});
		await remote.getByRole('button', { name: /Remote fixture task/ }).click();
		await remote.evaluate(() => window.brigadir.dispatchWorkspaceAction('simulator'));
		const panel = remote.getByRole('region', { name: 'Simulator', exact: true });
		await expect(panel).toBeVisible();
		await expect(panel.locator('[data-machine-tag]')).toHaveText('studio');
		await panel.getByRole('button', { name: 'Start', exact: true }).click();
		const canvas = panel.locator('canvas[aria-label="Simulator screen"]');
		await expect(canvas).toBeVisible();
		// The recorded key frame went over the connection as a binary frame and decoded here.
		await expect
			.poll(() =>
				canvas.evaluate((node: HTMLCanvasElement) => {
					if (node.width < 100) return 0;
					const data = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data;
					let lit = 0;
					for (let index = 0; index < data.length; index += 4 * 97) if (data[index + 3]) lit++;
					return lit;
				})
			)
			.toBeGreaterThan(100);
		const box = (await canvas.boundingBox())!;
		await remote.mouse.click(box.x + box.width / 2, box.y + box.height / 4);
		await expect
			.poll(async () =>
				(await readFile(log, 'utf8'))
					.split('\n')
					.filter(Boolean)
					.map((line) => JSON.parse(line))
					.filter((entry) => entry.cmd === 'touch')
					.map((entry) => entry.phase)
			)
			.toEqual(['down', 'up']);
		// ⌘V / Ctrl+V: the device's clipboard, typed into the simulator; the machine's is not read.
		await canvas.focus();
		await remote.keyboard.press('ControlOrMeta+V');
		await expect
			.poll(async () =>
				(await readFile(log, 'utf8')).includes('"cmd":"text","text":"from ThinkPad"')
			)
			.toBe(true);
		await expect(
			remote.evaluate(
				() => window.brigadir.simulatorCommand('project', { kind: 'paste' }) as Promise<unknown>
			)
		).rejects.toThrow(/Not available from a remote device/);
		expect(await screen()).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await device.close();
		await work.close();
	}
});

// spec/remote-access-and-mobile#browser-from-device: what spec/remote-access-and-mobile#client-ui-seam left — a sign-in started from a device opens no browser on the machine; closing a
// window of the machine asks about its unsaved buffers on the device; its renderer's second crash asks there too; a
// device does not restart the machine.
test('a device signs an agent in, closes and recovers its window of the machine, and cannot restart it @area:settings @serial', async () => {
	test.setTimeout(180_000);
	const port = await freePorts();
	const studio = await machine('studio', true, 'Remote fixture task'),
		thinkpad = await machine('ThinkPad', true, null);
	await writeFile(join(studio.root, 'repo/keep.txt'), 'keep\n');
	const login = join(studio.root, 'login.cjs'),
		loginLog = join(studio.root, 'login.json');
	await writeFile(
		login,
		`require('node:fs').writeFileSync(${JSON.stringify(loginLog)}, JSON.stringify({ browser: process.env.BROWSER ?? null, first: (process.env.PATH || '').split(':')[0] }));
console.log('Open https://example.com/sign-in?from=test');
setTimeout(() => {}, 60000);`
	);
	const work = await launch(studio, port, { BRIGADIR_TEST_LOGIN: login }),
		device = await launch(thinkpad, port + 10);
	try {
		const screen = await watchScreen(work);
		const { remote } = await connectDevice(work, device, port);
		await remote.getByRole('button', { name: /Remote fixture task/ }).click();
		const key = { projectId: 'project', id: 'task' };

		// The sign-in runs on the machine with a PATH whose `open` does nothing; its page is the device's to open.
		expect(await remote.evaluate(() => window.brigadir.signInAgent('claude'))).toMatchObject({
			phase: 'waiting',
		});
		await expect
			.poll(async () =>
				JSON.parse((await readFile(loginLog, 'utf8').catch(() => 'null')) || 'null')
			)
			.toMatchObject({ browser: 'true', first: expect.stringMatching(/brigadir-quiet-browser$/) });
		await expect(remote.evaluate(() => window.brigadir.reopenAgentLogin('claude'))).rejects.toThrow(
			/Not available from a remote device/
		);
		await remote.evaluate(() => window.brigadir.cancelAgentLogin('claude'));
		await expect(remote.evaluate(() => window.brigadir.restartApp())).rejects.toThrow(
			/Not available from a remote device/
		);

		// The device's own dialogs, answered from a list.
		await device.evaluate(({ dialog }) => {
			const asked: { message: string; detail: string }[] = ((globalThis as any).asked = []);
			(globalThis as any).answers = [];
			dialog.showMessageBox = (async (_window: unknown, options: any) => {
				asked.push({ message: options.message, detail: options.detail });
				return { response: (globalThis as any).answers.shift() ?? 0, checkboxChecked: false };
			}) as any;
		});
		const windows = () =>
			device.evaluate(
				({ BrowserWindow }) =>
					BrowserWindow.getAllWindows().filter((window) => window.getTitle().startsWith('studio'))
						.length
			);

		// An unsaved buffer of this window: closing asks here; «Keep editing» keeps the window.
		await remote.evaluate(async (key) => {
			const file = (await window.brigadir.listFiles(key, null)).entries.find(
				(item) => item.name === 'keep.txt'
			)!;
			await window.brigadir.readEditorFile(key, file.id);
			await window.brigadir.setEditorDirty(key, file.id, true);
		}, key);
		const machineWindow = (run: 'close' | 'crash' | 'loaded') =>
			device.evaluate(({ BrowserWindow }, run) => {
				const window = BrowserWindow.getAllWindows().find((item) =>
					item.getTitle().startsWith('studio')
				)!;
				if (run === 'close') window.close();
				else if (run === 'crash') window.webContents.forcefullyCrashRenderer();
				else return !window.webContents.isCrashed() && !window.webContents.isLoading();
				return true;
			}, run);
		await machineWindow('close');
		await expect.poll(() => device.evaluate(() => (globalThis as any).asked.length)).toBe(1);
		expect(await device.evaluate(() => (globalThis as any).asked[0])).toMatchObject({
			message: 'There are unsaved changes.',
			detail: expect.stringContaining('keep.txt'),
		});
		expect(await windows()).toBe(1);

		// The renderer of the machine's window: back by itself once, the second crash in a minute asks here.
		await machineWindow('crash');
		await expect.poll(() => machineWindow('loaded'), { timeout: 20_000 }).toBe(true);
		await machineWindow('crash');
		await expect
			.poll(() => device.evaluate(() => (globalThis as any).asked.map((item: any) => item.message)))
			.toEqual(['There are unsaved changes.', 'Repeated Brigadir window crash']);
		await expect.poll(() => machineWindow('loaded'), { timeout: 20_000 }).toBe(true);

		// «Discard changes» closes it.
		await device.evaluate(() => {
			(globalThis as any).answers.push(1);
		});
		await machineWindow('close');
		await expect.poll(windows).toBe(0);
		expect(await screen()).toEqual([]);
	} finally {
		await device.close();
		await work.close();
	}
});

/** spec/remote-access-and-mobile#networking: the test hooks main exposes in an unpackaged e2e run. */
const hook = (app: ElectronApplication, name: 'freeze' | 'cut' | 'networkChanged', arg?: unknown) =>
	app.evaluate((_electron, { name, arg }) => (globalThis as any).brigadirRemoteTest[name](arg), {
		name,
		arg,
	});
const session = (client: Page) =>
	client.evaluate(async () => (await window.brigadir.readRemoteSessions())[0] ?? null);

// spec/remote-access-and-mobile#networking: a broken path and a sleeping machine — the window shows «Reconnecting…» and comes back by itself with
// the resume token, never asking the password; before an attempt the Connect list says whether the machine answers.
test('a device rides out a broken path and a sleeping machine, and sees availability before connecting @area:settings', async () => {
	test.setTimeout(240_000);
	const port = await freePorts();
	const studio = await machine('studio', true, 'Remote fixture task'),
		thinkpad = await machine('ThinkPad', true, null);
	const work = await launch(studio, port),
		device = await launch(thinkpad, port + 10);
	try {
		const { page, client, remote } = await connectDevice(work, device, port);
		const logins = async () =>
			(await page.evaluate(() => window.brigadir.readRemoteAudit(200))).filter(
				(entry) => entry.kind === 'login'
			).length;
		const lost = remote.locator('[data-remote-lost]'),
			chip = remote.locator('[data-remote-chip]');
		await expect(chip.locator('button').first()).toHaveAttribute('aria-label', /studio/);
		expect(await session(client)).toMatchObject({ state: 'connected', generation: 1 });

		// The path breaks for 1.5 s: «Reconnecting…» at once, then the same window again without a password.
		await hook(work, 'cut', 1500);
		await expect(lost).toBeVisible({ timeout: 5000 });
		await expect(lost).toBeHidden({ timeout: 15_000 });
		await expect(chip.locator('button').first()).toHaveAttribute('aria-label', /studio/);
		expect(await session(client)).toMatchObject({
			state: 'connected',
			generation: 2,
			active: true,
		});
		await expect(client.locator('dialog[data-remote-connect]')).toHaveCount(0);
		// The window is still in control and works over the new connection.
		await remote.getByRole('button', { name: /Remote fixture task/ }).click();
		await expect(remote.getByRole('button', { name: /Remote fixture task/ })).toBeVisible();

		// The machine sleeps: nothing answers, nothing closes. Within 25 s of silence the window says so.
		const asleep = Date.now();
		await hook(work, 'freeze', true);
		await expect(lost).toBeVisible({ timeout: 30_000 });
		const noticed = Date.now() - asleep;
		expect(noticed).toBeLessThan(28_000);
		expect(noticed).toBeGreaterThan(20_000);
		// It wakes: the window comes back by itself, no password.
		await hook(work, 'freeze', false);
		await expect(lost).toBeHidden({ timeout: 40_000 });
		expect(await session(client)).toMatchObject({ state: 'connected', generation: 3 });
		await expect(client.locator('dialog[data-remote-connect]')).toHaveCount(0);

		// A network change on the device with the machine asleep: dropped within the check, not after 25 s.
		await hook(work, 'freeze', true);
		const changed = Date.now();
		await hook(device, 'networkChanged');
		await expect(lost).toBeVisible({ timeout: 10_000 });
		expect(Date.now() - changed).toBeLessThan(6000);
		await hook(work, 'freeze', false);
		await hook(device, 'networkChanged');
		await expect(lost).toBeHidden({ timeout: 15_000 });

		// spec/remote-access-and-mobile#networking: with the window closed, the Connect list touches the machine before any password.
		const machineId = (await session(client))!.machineId;
		await client.evaluate((id) => window.brigadir.disconnectRemoteMachine(id), machineId);
		const signedIn = await logins();
		// spec/remote-access-and-mobile#remote-button: File ▸ Connect… opens the list (the device's access is off: no Remote button, spec/appearance#evolution-redesign).
		await menuAction(device, 'connect');
		const connect = client.locator('dialog[data-remote-connect]'),
			row = connect.locator('[data-remote-machine="studio"]');
		// The only paired machine is chosen already.
		await expect(row).toHaveAttribute('data-remote-reach', 'answered', { timeout: 10_000 });
		await expect(row).toContainText('127.0.0.1');
		await hook(work, 'freeze', true);
		await expect(row).toHaveAttribute('data-remote-reach', 'silent', { timeout: 20_000 });
		// spec/remote-access-and-mobile#tailscale-guidance: the only machine is open: it says Tailscale reaches it outside the LAN and links the download.
		await expect(connect.locator('[data-remote-outside] [data-tailscale-link]')).toBeVisible();
		await hook(work, 'freeze', false);
		await expect(row).toHaveAttribute('data-remote-reach', 'answered', { timeout: 20_000 });
		// A touch is not a login: the machine's log has no new sign-in for it.
		expect(await logins()).toBe(signedIn);
	} finally {
		await device.close();
		await work.close();
	}
});

const pickerPage = `<!doctype html><meta charset="utf-8"><title>Picker fixture</title>
<style>html,body{margin:0;font:16px system-ui;background:#fff}
#fruit{position:fixed;left:20px;top:20px;width:200px;height:32px}
#colour{position:fixed;left:20px;top:80px;width:80px;height:32px}
#field{position:fixed;left:20px;top:140px;width:300px;height:32px}
#log{position:fixed;left:360px;top:20px;margin:0}</style>
<select id="fruit"><option value="apple">Apple</option><optgroup label="Stone"><option value="peach">Peach</option><option value="plum" disabled>Plum</option></optgroup></select>
<input id="colour" type="color" value="#ff0000"><input id="field"><pre id="log"></pre>
<script>
const log = (text) => { document.getElementById('log').textContent += text + '\\n'; };
for (const id of ['fruit', 'colour']) {
  const node = document.getElementById(id);
  node.addEventListener('mousedown', (event) => log('mousedown:' + id + ':' + event.defaultPrevented));
  node.addEventListener('input', () => log('input:' + id + ':' + node.value));
  node.addEventListener('change', () => log('change:' + id + ':' + node.value));
}
</script>`;

// spec/remote-access-and-mobile#networking: a page's pickers open on the device, an IME composes into the page, and a sign-in whose page
// comes back to localhost finishes on the machine through the device's one-shot listener.
test('a device picks in the machine page’s select and colour, composes with an IME and finishes a Codex sign-in @area:settings', async () => {
	test.setTimeout(240_000);
	const server = createServer((_request, response) => {
		response.setHeader('Content-Type', 'text/html');
		response.end(pickerPage);
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const port = await freePorts();
	const studio = await machine('studio', true, 'Remote fixture task'),
		thinkpad = await machine('ThinkPad', true, null);
	// The sign-in's own server on the machine: localhost:<callback>, as Codex runs it on 1455.
	const callback = (await freePorts()) + 1;
	const login = join(studio.root, 'login.cjs');
	await writeFile(
		login,
		`const http = require('node:http');
const port = ${callback};
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/auth/callback?code=c1&state=s1')) {
    response.writeHead(302, { location: 'http://localhost:' + port + '/success' });
    return response.end();
  }
  if (request.url === '/success') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<p>Signed in to Codex</p>');
    return setTimeout(() => process.exit(0), 200);
  }
  response.writeHead(404);
  response.end();
});
server.listen(port, '127.0.0.1', () => {
  console.log('Open https://auth.example.com/oauth/authorize?client_id=x&redirect_uri=' +
    encodeURIComponent('http://localhost:' + port + '/auth/callback') + '&state=s1');
});
setTimeout(() => process.exit(1), 120000);`
	);
	const work = await launch(studio, port, { BRIGADIR_TEST_LOGIN: login }),
		device = await launch(thinkpad, port + 10, { BRIGADIR_TEST_CALLBACK_PORT_OFFSET: '1' });
	try {
		const { remote } = await connectDevice(work, device, port);
		await device.evaluate(({ BrowserWindow, shell }) => {
			for (const window of BrowserWindow.getAllWindows())
				if (window.getTitle().startsWith('studio')) window.setSize(1280, 800);
			const opened: string[] = ((globalThis as any).deviceOpened = []);
			shell.openExternal = (async (address: string) => {
				opened.push(address);
			}) as any;
		});
		await remote.getByRole('button', { name: /Remote fixture task/ }).click();
		await remote.evaluate(() => window.brigadir.dispatchWorkspaceAction('browser'));
		const panel = remote.getByRole('region', { name: 'Browser', exact: true });
		const address = panel.getByRole('textbox', { name: 'Address' });
		await address.fill(url);
		await address.press('Enter');
		const canvas = panel.locator('canvas[data-browser-screen]');
		await expect(canvas).toBeVisible();
		await expect
			.poll(() => canvas.evaluate((node) => Number((node as HTMLElement).dataset.frames ?? 0)), {
				timeout: 15_000,
			})
			.toBeGreaterThan(0);
		// A machine-local page has neither DevTools nor «Open in default browser» here: no empty «…».
		await expect(panel.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
		// The device's own pickers are recorded, not shown: a native menu would take the screen in a background test.
		await remote.evaluate(() => {
			const shown: unknown[] = ((window as any).shownPickers = []);
			const record = function (this: HTMLSelectElement | HTMLInputElement) {
				shown.push({
					type: this instanceof HTMLSelectElement ? 'select' : this.type,
					value: this.value,
					options:
						this instanceof HTMLSelectElement
							? [...this.options].map((option) => [
									option.value,
									option.parentElement instanceof HTMLOptGroupElement
										? option.parentElement.label
										: null,
									option.disabled,
								])
							: [],
				});
			};
			HTMLSelectElement.prototype.showPicker = record;
			HTMLInputElement.prototype.showPicker = record;
		});
		const box = (await canvas.boundingBox())!;
		const log = () => inPage(work, url, 'document.getElementById("log").textContent');

		// The select: its popup on the device with the page's options; the choice is a real change on the machine.
		await remote.mouse.click(box.x + 60, box.y + 36);
		const proxy = panel.locator('[data-browser-picker="select"]');
		await expect(proxy).toHaveCount(1);
		expect(await remote.evaluate(() => (window as any).shownPickers)).toEqual([
			{
				type: 'select',
				value: 'apple',
				options: [
					['apple', null, false],
					['peach', 'Stone', false],
					['plum', 'Stone', true],
				],
			},
		]);
		await expect.poll(log).toContain('mousedown:fruit:true');
		await proxy.evaluate((node) => {
			(node as HTMLSelectElement).value = 'peach';
			node.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await expect
			.poll(() => inPage(work, url, 'document.getElementById("fruit").value'))
			.toBe('peach');
		await expect.poll(log).toContain('input:fruit:peach\nchange:fruit:peach');
		await expect(proxy).toHaveCount(0);

		// The colour input: the device's colour panel; its choice reaches the page.
		await remote.mouse.click(box.x + 60, box.y + 96);
		const colour = panel.locator('[data-browser-picker="color"]');
		await expect(colour).toHaveCount(1);
		await colour.evaluate((node) => {
			(node as HTMLInputElement).value = '#00ff00';
			node.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await expect
			.poll(() => inPage(work, url, 'document.getElementById("colour").value'))
			.toBe('#00ff00');

		// An IME composes: the page shows the composition, then the committed text.
		await remote.mouse.click(box.x + 150, box.y + 156);
		const keys = panel.locator('textarea');
		await keys.evaluate((node) => {
			node.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
			(node as HTMLTextAreaElement).value = 'にほ';
			node.dispatchEvent(
				new CompositionEvent('compositionupdate', { data: 'にほ', bubbles: true })
			);
		});
		await expect
			.poll(() => inPage(work, url, 'document.getElementById("field").value'))
			.toBe('にほ');
		await keys.evaluate((node) => {
			node.dispatchEvent(new CompositionEvent('compositionend', { data: '日本', bubbles: true }));
		});
		await expect
			.poll(() => inPage(work, url, 'document.getElementById("field").value'))
			.toBe('日本');

		// The Codex sign-in: the page opens on the device, the browser's return reaches the machine's localhost.
		await expect(
			remote.evaluate(() =>
				window.brigadir.relayAgentLogin('codex', { method: 'GET', path: '/x', headers: {} })
			)
		).rejects.toThrow(/No sign-in of this device is waiting/);
		await remote.evaluate(() => window.brigadir.signInAgent('codex'));
		await expect
			.poll(async () => (await remote.evaluate(() => window.brigadir.readAgentLogin('codex'))).url)
			.toContain('redirect_uri');
		const signInUrl = (await remote.evaluate(() => window.brigadir.readAgentLogin('codex'))).url!;
		await remote.evaluate(
			(address) => window.brigadir.openAgentSignIn('codex', address),
			signInUrl
		);
		expect(await device.evaluate(() => (globalThis as any).deviceOpened)).toEqual([signInUrl]);
		// The test plays the device's browser: it comes back to the device's loopback (port + 1 for two copies on one Mac).
		const fetchDevice = (path: string) =>
			new Promise<{ status: number; location: string | null; body: string }>((resolve, reject) => {
				const outgoing = request({ host: '127.0.0.1', port: callback + 1, path }, (response) => {
					const chunks: Buffer[] = [];
					response.on('data', (chunk) => chunks.push(chunk));
					response.on('end', () =>
						resolve({
							status: response.statusCode!,
							location: (response.headers.location as string | undefined) ?? null,
							body: Buffer.concat(chunks).toString(),
						})
					);
				});
				outgoing.on('error', reject);
				outgoing.end();
			});
		expect(await fetchDevice('/auth/callback?code=c1&state=s1')).toMatchObject({
			status: 302,
			location: '/success',
		});
		expect(await fetchDevice('/success')).toMatchObject({
			status: 200,
			body: '<p>Signed in to Codex</p>',
		});
		await expect
			.poll(
				async () => (await remote.evaluate(() => window.brigadir.readAgentLogin('codex'))).phase
			)
			.toBe('done');
		// The sign-in is over: the device's listener closed with it.
		await expect
			.poll(() =>
				fetchDevice('/success').then(
					() => 'open',
					() => 'closed'
				)
			)
			.toBe('closed');
	} finally {
		await device.close();
		await work.close();
		server.close();
	}
});
