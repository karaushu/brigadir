import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hideChat, hidePanel } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const key = process.platform === 'darwin' ? 'Meta' : 'Control';
// spec/terminal-and-cli-agents#console-links: ⌘C / ⌘A / ⌘V, ⌘-click on links and the native right-click menu of the console.
test('the console copies its selection, opens links on ⌘-click and has a native menu (spec/terminal-and-cli-agents#console-links) @area:browser @serial', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-console-menu-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(join(repo, 'src'), { recursive: true });
	await mkdir(dir, { recursive: true });
	await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
	await writeFile(
		join(repo, 'src/a.ts'),
		'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n'
	);
	// The output line comes from a script, so the command line stays short and never wraps above it when panels narrow the console.
	await writeFile(
		join(root, 'out.sh'),
		"printf '%s\\n' 'go http://localhost:5173/ docs https://example.com/x. see src/a.ts:3 TAILWORD'\n"
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'dark', language: 'en' } })
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Console menu fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`, '--no-proxy-server'],
		env: { ...env, HOME: root, ZDOTDIR: root, SHELL: '/bin/zsh', BRIGADIR_DATA_DIR: data },
	});
	const taskKey = { projectId: 'project', id: 'task' };
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1500, 950));
		// The menu is captured instead of shown; copies, pastes and opened links go here, never to the system clipboard or browser.
		await app.evaluate(({ Menu, clipboard, shell }) => {
			const state = globalThis as any;
			state.opened = [];
			state.copied = [];
			Menu.prototype.popup = function (options) {
				state.menu = this;
				state.options = options;
			};
			clipboard.writeText = (async (text: string) => {
				state.copied.push(text);
			}) as never;
			clipboard.readText = (async () => 'echo PASTED_OK') as never;
			shell.openExternal = async (url) => {
				state.opened.push(url);
			};
		});
		const items = async () => {
			await expect.poll(() => app.evaluate(() => !!(globalThis as any).menu)).toBe(true);
			return app.evaluate(() =>
				(globalThis as any).menu.items.map((item: any) =>
					item.type === 'separator' ? '-' : `${item.label}${item.enabled ? '' : ' (off)'}`
				)
			);
		};
		const choose = async (label: string) => {
			await app.evaluate((_, label) => {
				const state = globalThis as any,
					item = state.menu.items.find((item: any) => item.label === label);
				if (!item?.enabled) throw new Error(`Unavailable: ${label}`);
				item.click();
				state.options?.callback?.();
				state.menu = null;
			}, label);
		};
		const reset = () =>
			app.evaluate(() => {
				(globalThis as any).menu = null;
			});
		const copied = () => app.evaluate(() => (globalThis as any).copied as string[]);

		await page.getByRole('button', { name: /Console menu fixture/ }).click();
		// spec/task-window-workspace#work-area: ⇧⌘Y opens a terminal tab in the work area.
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Terminal')!
				.click()
		);
		await expect(page.locator('.xterm')).toHaveCount(1);
		// The output lines stay one row each: the work area takes the window's width (spec/task-window-workspace#layout-switch).
		await hideChat(page);
		await hidePanel(page);
		const input = page.locator('.xterm-helper-textarea');
		await input.focus();
		await input.fill('sh ~/out.sh');
		await input.press('Enter');
		const list = (await page.evaluate(
			(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
			taskKey
		)) as { id: string }[];
		const id = list[0]!.id;
		await expect
			.poll(() =>
				page.evaluate(({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'text', id }), {
					key: taskKey,
					id,
				})
			)
			.toContain('docs https://example.com/x.');
		// Where a word of the output stands on the screen: the line with `5173`, under the short command line.
		let outputRow = 1;
		const spot = async (word: string) => {
			const text = (await page.evaluate(
				({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'text', id }),
				{ key: taskKey, id }
			)) as string;
			// The block summary of the command: its output line is the last; on the screen it is the line under the prompt line.
			const line = text.split('\n').find((entry) => entry.includes('5173'))!,
				row = outputRow,
				col = line.indexOf(word);
			expect(col).toBeGreaterThanOrEqual(0);
			const box = (await page.locator('.xterm-screen').boundingBox())!;
			// The cell: the helper textarea is one cell high, the output is monospace.
			const cell = await page.evaluate(() => {
				const area = document.querySelector('.xterm-helper-textarea') as HTMLElement;
				return { h: parseFloat(area.style.height), w: parseFloat(area.style.width) };
			});
			return {
				x: box.x + cell.w * (col + Math.min(word.length, 4) / 2),
				y: box.y + cell.h * (row + 0.5),
			};
		};

		// spec/terminal-and-cli-agents#console-selection: one pixel of the screen; the selection must change an empty cell of its row in both themes.
		const pixel = async (x: number, y: number) => {
			const shot = (
				await page.screenshot({ clip: { x, y, width: 1, height: 1 }, animations: 'disabled' })
			).toString('base64');
			return page.evaluate(async (src) => {
				const image = new Image();
				image.src = `data:image/png;base64,${src}`;
				await image.decode();
				const canvas = document.createElement('canvas');
				canvas.width = canvas.height = 1;
				const context = canvas.getContext('2d')!;
				context.drawImage(image, 0, 0, 1, 1);
				return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
			}, shot);
		};
		const distance = (a: number[], b: number[]) =>
			a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0);
		const blank = async () => {
			const box = (await page.locator('.xterm-screen').boundingBox())!;
			return { x: box.x + box.width - 24, y: (await spot('TAILWORD')).y };
		};
		// Select a word, copy it with the keyboard: the system Copy sees only the helper textarea, which now holds the selection.
		const tail = await spot('TAILWORD');
		const empty = await blank(),
			darkBefore = await pixel(empty.x, empty.y);
		await page.mouse.dblclick(tail.x, tail.y);
		await expect.poll(() => input.inputValue()).toBe('TAILWORD');
		await page.keyboard.press(`${key}+${process.platform === 'darwin' ? '' : 'Shift+'}c`);
		await expect.poll(copied).toEqual(['TAILWORD']);
		// ⌘A selects the whole screen; the menu on the selection has Copy on.
		await page.keyboard.press(`${key}+${process.platform === 'darwin' ? '' : 'Shift+'}a`);
		await expect
			.poll(() =>
				input
					.inputValue()
					.then((value) => value.includes('TAILWORD') && value.includes('example.com'))
			)
			.toBe(true);
		expect(distance(await pixel(empty.x, empty.y), darkBefore)).toBeGreaterThan(24);

		// Right click on text outside the selection: no selection, Copy is off; the edit and agent groups are there.
		await page.keyboard.press('Escape');
		await page.mouse.click(tail.x, tail.y - 60);
		await reset();
		await page.mouse.click(tail.x, tail.y, { button: 'right' });
		expect(await items()).toEqual([
			'Copy (off)',
			'Paste',
			'Select all',
			'-',
			'Show the agent',
			'Clear terminal',
		]);
		await choose('Select all');
		await reset();
		await page.mouse.click(tail.x, tail.y, { button: 'right' });
		expect(await items()).toEqual([
			'Copy',
			'Paste',
			'Select all',
			'-',
			'Show the agent',
			'Clear terminal',
		]);
		await choose('Copy');
		await expect.poll(async () => (await copied()).length).toBe(2);
		// Paste goes through the PTY as typed text (the clipboard is faked).
		await reset();
		await page.mouse.click(tail.x, tail.y, { button: 'right' });
		await items();
		await choose('Paste');
		await expect
			.poll(
				async () =>
					(
						(await page.evaluate(
							({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'read', id }),
							{ key: taskKey, id }
						)) as { data: string }
					).data
			)
			.toContain('echo PASTED_OK');
		await input.press('Control+u');

		// Links: nothing without ⌘; with ⌘ the link is underlined and a click opens it.
		const local = await spot('localhost'),
			docs = await spot('example.com');
		await page.mouse.click(docs.x, docs.y);
		expect(await app.evaluate(() => (globalThis as any).opened)).toEqual([]);
		await page.mouse.move(docs.x, docs.y - 45);
		await page.keyboard.down(key);
		await page.mouse.move(docs.x, docs.y);

		await expect(page.getByRole('tooltip')).toHaveText('⌘+click opens the link');
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('console-link-hover-dark.png'),
		});
		await page.mouse.click(docs.x, docs.y);
		await page.keyboard.up(key);
		await expect
			.poll(() => app.evaluate(() => (globalThis as any).opened))
			.toEqual(['https://example.com/x']);
		// Right click on a link: both browsers and Copy link first; the system one is the system's. Before the task browser opens beside the console and narrows it.
		await reset();
		await page.mouse.click(docs.x, docs.y, { button: 'right' });
		expect(await items()).toEqual([
			'Open in task browser',
			'Open in system browser',
			'Copy link',
			'-',
			'Copy (off)',
			'Paste',
			'Select all',
			'-',
			'Show the agent',
			'Clear terminal',
		]);
		// spec/search-menus-and-commands#menu-glyphs: every item carries its glyph as a template image.
		await expect
			.poll(() =>
				app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById('settings')?.icon)
			)
			.toBe(true);
		expect(
			await app.evaluate(() =>
				(globalThis as any).menu.items
					.filter((item: any) => item.type !== 'separator' && !item.icon?.isTemplateImage())
					.map((item: any) => item.label)
			)
		).toEqual([]);
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('console-menu-dark.png'),
		});
		await choose('Open in system browser');
		await expect
			.poll(() => app.evaluate(() => (globalThis as any).opened))
			.toEqual(['https://example.com/x', 'https://example.com/x']);
		await reset();
		await page.mouse.click(docs.x, docs.y, { button: 'right' });
		await items();
		await choose('Copy link');
		await expect.poll(async () => (await copied()).at(-1)).toBe('https://example.com/x');
		await reset();
		await page.mouse.move(local.x, local.y - 45);
		await page.keyboard.down(key);
		await page.mouse.move(local.x, local.y);
		await expect(page.getByRole('tooltip')).toBeVisible();
		await page.mouse.click(local.x, local.y);
		await page.keyboard.up(key);
		await expect(page.getByRole('region', { name: 'Browser', exact: true })).toBeVisible();
		expect(await app.evaluate(() => (globalThis as any).opened)).toEqual([
			'https://example.com/x',
			'https://example.com/x',
		]);
		// spec/task-window-workspace#work-area: the page opened as a tab of the same group; the terminal's tab brings the console back.
		await page.getByRole('tab', { name: 'repo', exact: true }).click();

		// A file of the task opens in the editor on ⌘-click, on its line. The task browser narrowed the console: the line is shown again on a clear screen.
		await page.evaluate(
			({ key, id }) =>
				window.brigadir.terminalCommand(key, {
					kind: 'input',
					id,
					data: "\x03clear; sh ~/out.sh; echo RE''SHOWN\r",
				}),
			{ key: taskKey, id }
		);
		await expect
			.poll(() =>
				page.evaluate(({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'text', id }), {
					key: taskKey,
					id,
				})
			)
			.toContain('RESHOWN');
		outputRow = 0; // `clear` ran after the command line: the output starts the screen.
		const file = await spot('src/a.ts');
		await page.mouse.move(file.x, file.y - 45);
		await page.keyboard.down(key);
		await page.mouse.move(file.x, file.y);
		await expect(page.getByRole('tooltip')).toHaveText('⌘+click opens in editor');
		await page.mouse.click(file.x, file.y);
		await page.keyboard.up(key);
		await expect(page.locator('.cm-editor')).toBeVisible();
		// spec/task-window-workspace#work-area: the file opened as a tab beside the terminal; back to the terminal's tab.
		await page.getByRole('tab', { name: 'repo', exact: true }).click();
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		// The editor took the top of the column: where the link stands now.
		const lightDocs = await spot('example.com');
		await page.mouse.move(lightDocs.x, lightDocs.y - 45);
		await page.keyboard.down(key);
		await page.mouse.move(lightDocs.x, lightDocs.y);
		await expect(page.getByRole('tooltip')).toBeVisible();
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('console-link-hover-light.png'),
		});
		await page.keyboard.up(key);
		// spec/terminal-and-cli-agents#console-selection: the light console shows its selection; plain xterm drops the translucent accent and paints white on near-white.
		const light = await blank(),
			word = await spot('TAILWORD');
		await page.mouse.click(word.x, word.y);
		const lightBefore = await pixel(light.x, light.y);
		await page.keyboard.press(`${key}+${process.platform === 'darwin' ? '' : 'Shift+'}a`);
		await expect
			.poll(async () => distance(await pixel(light.x, light.y), lightBefore))
			.toBeGreaterThan(24);
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('console-selection-light.png'),
		});
		// spec/terminal-and-cli-agents#console-selection: a program that takes the mouse (a fullscreen TUI) still lets ⌥-drag select, as in iTerm and Terminal.
		await page.evaluate(
			({ key, id }) =>
				window.brigadir.terminalCommand(key, {
					kind: 'input',
					id,
					data: "\x03printf '\\e[?1000h\\e[?1006h'; sleep 30\r",
				}),
			{ key: taskKey, id }
		);
		await expect(page.locator('.xterm')).toHaveClass(/enable-mouse-events/);
		const screen = (await page.locator('.xterm-screen').boundingBox())!,
			row = screen.y + 6;
		const drag = async (alt: boolean) => {
			if (alt) await page.keyboard.down('Alt');
			await page.mouse.move(screen.x + 4, row);
			await page.mouse.down();
			await page.mouse.move(screen.x + 160, row, { steps: 6 });
			await page.mouse.up();
			if (alt) await page.keyboard.up('Alt');
		};
		await drag(false);
		expect(await input.inputValue()).toBe('');
		await drag(true);
		await expect.poll(() => input.inputValue()).not.toBe('');
		await input.press('Control+c');
		expect(errors).toEqual([]);
	} finally {
		try {
			await (
				await app.firstWindow()
			).evaluate((key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }), taskKey);
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
