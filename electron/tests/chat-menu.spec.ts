import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const answer =
	'Changed src/foo.ts:3 and opened https://example.com/pr for **review**.\n\n```ts\nconst a = 1;\n```\n\nSecond paragraph, plain text.';
// spec/chat#context-menu: the chat log's native menu groups what is under the click; the composer gets the system edit menu.
test('the chat context menu copies text, links, paths, code, images and whole messages (spec/chat#context-menu) @area:chat @serial', async () => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-chat-menu-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(join(repo, 'src'), { recursive: true });
	await mkdir(dir, { recursive: true });
	await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
	await writeFile(join(repo, 'src/foo.ts'), 'export const foo = 1;\n\nexport const bar = 2;\n');
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
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
				title: 'Chat menu fixture',
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
	const launch = () =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: { ...env, BRIGADIR_DATA_DIR: data },
		});
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const png = await app.evaluate(({ nativeImage }) => {
			const width = 40,
				height = 30,
				bitmap = Buffer.alloc(width * height * 4, 0xff);
			return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG().toString('base64');
		});
		const image = await page.evaluate(
			([png]) =>
				window.brigadir.createAttachment(
					{ projectId: 'project', id: 'task' },
					{ kind: 'image', name: 'screen.png', mimeType: 'image/png', data: png }
				),
			[png] as const
		);
		await app.close();
		const events = [
			{ kind: 'turn.started', text: 'Fix the layout.', attachments: [image] },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'answer',
				content: { kind: 'text', text: answer },
			},
			{ kind: 'turn.completed', reason: 'end_turn' },
			{ kind: 'host.stopped', reason: 'Fixture offline' },
		];
		await writeFile(
			join(dir, 'events.jsonl'),
			events
				.map((event, index) =>
					JSON.stringify({
						schemaVersion: 1,
						seq: index + 1,
						at: new Date(Date.UTC(2026, 9, 6, 12, 0, index)).toISOString(),
						event,
					})
				)
				.join('\n') + '\n'
		);
		app = await launch();
		page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		// The menu is captured instead of shown; copies, images and opened links land here instead of the system.
		await app.evaluate(({ Menu, clipboard, shell }) => {
			const state = globalThis as any;
			state.opened = [];
			Menu.prototype.popup = function (options) {
				state.menu = this;
				state.options = options;
			};
			clipboard.writeText = (async (text: string) => {
				state.copied = text;
			}) as never;
			clipboard.write = (async (items: any[]) => {
				state.written = await Promise.all(
					items.map(async (item) => ({
						types: item.types,
						size: (await item.getType('image/png')).size,
					}))
				);
			}) as never;
			shell.openExternal = async (url) => {
				state.opened.push(url);
			};
		});
		const items = async () => {
			await expect.poll(() => app.evaluate(() => !!(globalThis as any).menu)).toBe(true);
			return app.evaluate(
				() =>
					(globalThis as any).menu.items.map((item: any) =>
						item.type === 'separator' ? '-' : `${item.label}${item.enabled ? '' : ' (off)'}`
					) as string[]
			);
		};
		const close = () =>
			app.evaluate(() => {
				const state = globalThis as any;
				state.options?.callback?.();
				state.menu = null;
			});
		const menuAt = async (
			locator: import('@playwright/test').Locator,
			position?: { x: number; y: number }
		) => {
			await app.evaluate(() => {
				(globalThis as any).menu = null;
			});
			await locator.click({ button: 'right', ...(position ? { position } : {}) });
			const list = await items();
			return list;
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
		const copied = () => app.evaluate(() => (globalThis as any).copied as string | undefined);
		await page.getByRole('button', { name: /Chat menu fixture/ }).click();
		const log = page.getByRole('log', { name: 'Conversation' }),
			path = log.getByRole('button', { name: 'src/foo.ts:3', exact: true });
		await expect(path).toHaveCount(1);
		const plain = log.locator('p').filter({ hasText: 'Second paragraph' });

		// A message without a selection: Copy is off, Copy message takes the Markdown source of the whole answer. The macOS right
		// click selects the word under it before the menu (WebKit's select on contextual menu click); the log undoes it.
		await plain.evaluate((node) =>
			document.addEventListener(
				'contextmenu',
				() => {
					const range = document.createRange();
					range.setStart(node.firstChild!, 0);
					range.setEnd(node.firstChild!, 6);
					getSelection()!.removeAllRanges();
					getSelection()!.addRange(range);
				},
				{ capture: true, once: true }
			)
		);
		expect(await menuAt(plain, { x: 20, y: 6 })).toEqual(['Copy (off)', '-', 'Copy message']);
		expect(await page.evaluate(() => getSelection()?.isCollapsed ?? true)).toBe(true);
		await choose('Copy message');
		await expect.poll(copied).toBe(answer);

		// A link: open and copy it, then the message.
		const link = log.getByRole('link', { name: 'https://example.com/pr', exact: true });
		expect(await menuAt(link)).toEqual([
			'Open link',
			'Copy link',
			'-',
			'Copy (off)',
			'-',
			'Copy message',
		]);
		await choose('Copy link');
		await expect.poll(copied).toBe('https://example.com/pr');
		await menuAt(link);
		await choose('Open link');
		await expect
			.poll(() => app.evaluate(() => (globalThis as any).opened))
			.toEqual(['https://example.com/pr']);

		// A code block, its header included: Copy code gives the code alone.
		const code = log.locator('[data-code-block]');
		expect(await menuAt(code.locator('pre'))).toEqual([
			'Copy (off)',
			'-',
			'Copy code',
			'Copy message',
		]);
		await choose('Copy code');
		await expect.poll(copied).toBe('const a = 1;\n');
		expect(await menuAt(code.locator('header'), { x: 30, y: 8 })).toContain('Copy code');
		await close();

		// A selection: right click inside keeps it and offers the system Copy; outside it clears it.
		await plain.evaluate((node) => {
			const text = node.firstChild!,
				range = document.createRange();
			range.setStart(text, 0);
			range.setEnd(text, 16);
			getSelection()!.removeAllRanges();
			getSelection()!.addRange(range);
		});
		expect(await menuAt(plain, { x: 20, y: 6 })).toEqual(['Copy', '-', 'Copy message']);
		expect(await app.evaluate(() => (globalThis as any).menu.items[0].role)).toBe('copy');
		await close();
		expect(await page.evaluate(() => getSelection()?.toString())).toBe('Second paragraph');
		expect(await menuAt(log.locator('strong').filter({ hasText: 'review' }))).toEqual([
			'Copy (off)',
			'-',
			'Copy message',
		]);
		await close();
		expect(await page.evaluate(() => getSelection()?.isCollapsed ?? true)).toBe(true);

		// The person's message: its text, and its image tile copies the full image.
		const person = log.locator('[data-chat-message]').filter({ hasText: 'Fix the layout.' });
		expect(await menuAt(person, { x: 10, y: 8 })).toEqual(['Copy (off)', '-', 'Copy message']);
		await choose('Copy message');
		await expect.poll(copied).toBe('Fix the layout.');
		expect(await menuAt(person.locator('[data-attachment-id]'))).toEqual([
			'Copy (off)',
			'-',
			'Copy image',
			'Copy message',
		]);
		await choose('Copy image');
		await expect
			.poll(() => app.evaluate(() => (globalThis as any).written))
			.toEqual([{ types: ['image/png'], size: Buffer.from(png, 'base64').length }]);

		// The composer keeps the system edit menu, Paste included.
		const composer = page.getByRole('textbox', { name: 'Message', exact: true });
		await composer.fill('draft');
		await composer.selectText();
		expect(await menuAt(composer)).toEqual(['Cut', 'Copy', 'Paste', '-', 'Select all']);
		expect(
			await app.evaluate(() =>
				(globalThis as any).menu.items.map((item: any) => item.role).filter(Boolean)
			)
		).toEqual(['cut', 'copy', 'paste', 'selectall']);
		// spec/search-menus-and-commands#menu-glyphs: the system edit menu carries the same glyphs as the rest.
		expect(
			await app.evaluate(() =>
				(globalThis as any).menu.items
					.filter((item: any) => item.type !== 'separator' && !item.icon?.isTemplateImage())
					.map((item: any) => item.label)
			)
		).toEqual([]);
		await close();

		// A file path last, since it opens the editor: open it and copy its path with and without the line.
		expect(await menuAt(path)).toEqual([
			'Open in editor',
			'Copy relative path',
			'Copy path:line',
			'-',
			'Copy (off)',
			'-',
			'Copy message',
		]);
		await choose('Copy path:line');
		await expect.poll(copied).toBe('src/foo.ts:3');
		await menuAt(path);
		await choose('Copy relative path');
		await expect.poll(copied).toBe('src/foo.ts');
		await menuAt(path);
		await choose('Open in editor');
		await expect(
			page
				.locator('section')
				.filter({ has: page.getByRole('textbox', { name: 'File content' }) })
				.last()
				.locator(':scope > footer')
		).toContainText('3:1');
		// The main process refuses a malformed menu state.
		await expect(
			page.evaluate(() => window.brigadir.chatMenu({ selection: true } as never))
		).rejects.toThrow();
		expect(errors).toEqual([]);
	} finally {
		await app.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
