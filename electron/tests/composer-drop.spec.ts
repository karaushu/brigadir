import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { editorState, editorText, setEditorCaret } from './editor-text';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
// One done task `title` in a fresh data dir; `launch(true)` runs the fixture agent and logs what it receives to `agentLog`.
async function fixture(title: string) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-composer-drop-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task'),
		agentLog = join(root, 'agent.jsonl');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { id: 'task', projectId: 'project', title, status: 'done', provider: 'claude' },
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const launch = (agent: boolean) =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: {
				...env,
				BRIGADIR_DATA_DIR: data,
				...(agent
					? {
							BRIGADIR_FIXTURE_LOG: agentLog,
							BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
						}
					: {}),
			},
		});
	return { root, repo, data, dir, agentLog, launch };
}
// spec/composer#paste: files from Finder — dropped on the composer or copied and pasted with ⌘V — land on the shelf like the `+` picker's.
// Finder's files are real `File` objects with a path; a file input gives the same ones, and the events carry them.
test('files dropped from Finder or pasted from a Finder copy attach and reach the agent @area:chat @serial', async ({}, info) => {
	test.setTimeout(90000);
	const { root, repo, agentLog, launch } = await fixture('Drop fixture');
	await writeFile(join(repo, 'notes.txt'), 'remember this\n');
	const app = await launch(true);
	const key = { projectId: 'project', id: 'task' };
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const png = await app.evaluate(({ nativeImage }) => {
			const width = 40,
				height = 30,
				bitmap = Buffer.alloc(width * height * 4, 0x80);
			return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG().toString('base64');
		});
		await writeFile(join(repo, 'shot.png'), Buffer.from(png, 'base64'));
		await page.getByRole('button', { name: /Drop fixture/ }).click();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true }),
			form = page.locator('form:has([aria-label="Message"])'),
			shelf = form.locator('[data-attachments]'),
			image = message.locator('[data-mention-image]'),
			pill = message.locator('[data-mention-pill]');
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await message.fill('Check these');
		await page.evaluate(() => {
			const input = document.createElement('input');
			input.type = 'file';
			input.multiple = true;
			input.id = 'finder';
			input.hidden = true;
			document.body.append(input);
		});
		await page.setInputFiles('#finder', [join(repo, 'shot.png'), join(repo, 'notes.txt')]);
		const transfer = () =>
			page.evaluateHandle(() => {
				const transfer = new DataTransfer();
				for (const file of (document.getElementById('finder') as HTMLInputElement).files!)
					transfer.items.add(file);
				return transfer;
			});
		const drag = async (type: 'dragover' | 'dragleave' | 'drop') => {
			const data = await transfer();
			return message.evaluate(
				(node, { type, data }) => {
					const event = new DragEvent(type, {
						dataTransfer: data,
						bubbles: true,
						cancelable: true,
						relatedTarget: null,
					});
					node.dispatchEvent(event);
					return event.defaultPrevented;
				},
				{ type, data }
			);
		};
		// Over the island the form marks the drop target; leaving takes it away.
		expect(await drag('dragover')).toBe(true);
		await expect(form).toHaveAttribute('data-drop-over', 'true');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await form.screenshot({
				animations: 'disabled',
				path: info.outputPath(`composer-drop-${theme}.png`),
			});
		}
		await drag('dragleave');
		await expect(form).not.toHaveAttribute('data-drop-over');
		// Dropping attaches both (spec/composer#mentions): the picture as a thumbnail and the text file as a pill, in the text at the caret; no shelf.
		await drag('dragover');
		expect(await drag('drop')).toBe(true);
		await expect(form).not.toHaveAttribute('data-drop-over');
		await expect(image).toHaveCount(1);
		await expect(image).toHaveAttribute('title', 'shot.png');
		await expect(image.locator('img')).toHaveCount(1);
		await expect(pill).toHaveCount(1);
		await expect(pill).toHaveText('notes.txt');
		await expect(shelf).toHaveCount(0);
		expect(await editorText(message)).toMatch(
			/^Check these @\[att:[0-9a-f-]{36}\] @\[att:[0-9a-f-]{36}\] $/
		);
		// Removing the pills from the text takes their attachments away.
		await message.fill('Check these');
		await expect(image).toHaveCount(0);
		await expect(pill).toHaveCount(0);
		// ⌘V of a Finder copy: the event shows the files and no text; they attach at the caret, the rest of the text stays.
		await setEditorCaret(message, 5);
		const data = await transfer();
		expect(
			await message.evaluate((node, data) => {
				const event = new ClipboardEvent('paste', {
					clipboardData: data,
					bubbles: true,
					cancelable: true,
				});
				node.dispatchEvent(event);
				return event.defaultPrevented;
			}, data)
		).toBe(true);
		await expect(image).toHaveCount(1);
		await expect(pill).toHaveText('notes.txt');
		const state = await editorState(message);
		expect(state.text).toMatch(/^Check @\[att:[0-9a-f-]{36}\] @\[att:[0-9a-f-]{36}\] these$/);
		expect(state.caret).toBe(state.text.indexOf(' these'));
		await expect(page.getByRole('alert')).toHaveCount(0);
		await message.press('Enter');
		await expect.poll(() => editorText(message)).toBe('');
		await expect(image).toHaveCount(0);
		await expect
			.poll(
				async () => (await readFile(agentLog, 'utf8').catch(() => '')).includes('"prompt-blocks"'),
				{ timeout: 20000 }
			)
			.toBe(true);
		const agent = (await readFile(agentLog, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { event: string; params: any });
		const blocks = (
			agent.filter((entry) => entry.event === 'prompt-blocks').at(-1)!.params as {
				type: string;
				text?: string;
				data?: string;
				mimeType?: string;
			}[]
		).filter(
			(block) =>
				!(
					block.type === 'text' && block.text!.startsWith('<attached_context name="Brigadir brief"')
				)
		);
		// spec/composer#mentions: the blocks follow the text — the attachments stand where the person put them.
		expect(
			blocks.map((block) =>
				block.type === 'image'
					? { type: 'image', data: block.data }
					: { type: block.type, text: block.text }
			)
		).toEqual([
			{ type: 'text', text: 'Check ' },
			{ type: 'image', data: png },
			{
				type: 'text',
				text: `<attached_context name="notes.txt">\nFile reference:\nAbsolute path: ${JSON.stringify(join(repo, 'notes.txt'))}\nRead the current contents from disk when needed.\n</attached_context>`,
			},
			{ type: 'text', text: ' these' },
		]);
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = app.windows()[0];
			if (page)
				await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }), key);
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/composer#paste: ⌘V with an image on the clipboard attaches it to the composer shelf and the image reaches the agent; text pastes as before.
// The system clipboard is the developer's: main's `clipboard.read` is replaced, and the paste event carries its own DataTransfer.
test('pasting a clipboard image attaches it and sends it to the agent; text paste stays @area:chat @serial', async ({}, info) => {
	test.setTimeout(90000);
	const { root, agentLog, launch } = await fixture('Paste fixture');
	const app = await launch(true);
	const key = { projectId: 'project', id: 'task' };
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		// A 64×48 screenshot stand-in: main offers it as `image/png`, the way macOS offers a ⌘⇧⌃4 capture.
		const png = await app.evaluate(({ clipboard, nativeImage }) => {
			const width = 64,
				height = 48,
				bitmap = Buffer.alloc(width * height * 4);
			for (let i = 0; i < bitmap.length; i += 4) {
				bitmap[i] = 0xd0;
				bitmap[i + 1] = 0x60;
				bitmap[i + 2] = 0x20;
				bitmap[i + 3] = 0xff;
			}
			const bytes = nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
			(clipboard as any).read = async () => (globalThis as any).clipboardItems;
			(globalThis as any).clipboardItems = [
				{
					types: ['image/png'],
					getType: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
				},
			];
			return bytes.toString('base64');
		});
		await page.getByRole('button', { name: /Paste fixture/ }).click();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true }),
			shelf = page.locator('form [data-attachments]'),
			inline = message.locator('[data-mention-image]');
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await message.fill('Look at this');
		await setEditorCaret(message, 4);
		// Dispatches the paste the browser fires for ⌘V or Edit → Paste, with a clipboard that holds only an image.
		const paste = (items: { text?: string; image?: boolean }) =>
			message.evaluate((node, items) => {
				const transfer = new DataTransfer();
				if (items.text !== undefined) transfer.setData('text/plain', items.text);
				if (items.image)
					transfer.items.add(
						new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'image.png', {
							type: 'image/png',
						})
					);
				const event = new ClipboardEvent('paste', {
					clipboardData: transfer,
					bubbles: true,
					cancelable: true,
				});
				node.dispatchEvent(event);
				return event.defaultPrevented;
			}, items);
		expect(await paste({ image: true })).toBe(true);
		// spec/composer#mentions: the image stands in the text where the caret was, as a thumbnail; there is no shelf.
		await expect(inline).toHaveCount(1);
		await expect(inline).toHaveAttribute('title', 'Pasted image');
		await expect(inline.locator('img')).toHaveCount(1);
		await expect(shelf).toHaveCount(0);
		const state = await editorState(message);
		expect(state.text).toMatch(/^Look @\[att:[0-9a-f-]{36}\] at this$/);
		expect(state.caret).toBe(state.text.indexOf(' at this'));
		expect(state.focused).toBe(true);
		await page
			.locator('form')
			.screenshot({ animations: 'disabled', path: info.outputPath('composer-pasted-light.png') });
		// Text paste stays the editor's own: the text goes in at the caret and nothing attaches, also when a spreadsheet adds a picture of its cells.
		await paste({ text: 'plain text' });
		await expect
			.poll(async () => (await editorText(message)).endsWith(']plain text at this'))
			.toBe(true);
		await paste({ text: 'a\tb\n1\t2', image: true });
		await expect
			.poll(async () => (await editorText(message)).endsWith(']plain texta\tb\n1\t2 at this'))
			.toBe(true);
		await expect(inline).toHaveCount(1);
		// Nothing on the clipboard: no attachment and no error.
		await app.evaluate(() => {
			(globalThis as any).clipboardItems = [];
		});
		expect(await paste({})).toBe(true);
		await page.waitForTimeout(300);
		await expect(inline).toHaveCount(1);
		await expect(page.getByRole('alert')).toHaveCount(0);
		const sent = await editorText(message);
		await message.press('Enter');
		await expect.poll(() => editorText(message)).toBe('');
		await expect(inline).toHaveCount(0);
		await expect
			.poll(
				async () => (await readFile(agentLog, 'utf8').catch(() => '')).includes('"prompt-blocks"'),
				{ timeout: 20000 }
			)
			.toBe(true);
		const agent = (await readFile(agentLog, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { event: string; params: any });
		const blocks = agent.filter((entry) => entry.event === 'prompt-blocks').at(-1)!.params as {
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}[];
		expect(
			blocks.filter(
				(block) =>
					block.type !== 'text' ||
					!block.text!.startsWith('<attached_context name="Brigadir brief"')
			)
		).toEqual([
			{ type: 'text', text: 'Look ' },
			{ type: 'image', mimeType: 'image/png', data: png },
			{ type: 'text', text: sent.slice(sent.indexOf(']') + 1) },
		]);
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = app.windows()[0];
			if (page)
				await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }), key);
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/chat#images: the person's message shows its attachments as shelf tiles (thumbnails from a cached small PNG), images open over the
// whole window with Esc, ← and →, a gone image is «unavailable», and a pasted image is named in the interface language.
test('a sent message shows its images as shelf tiles that open the window-wide viewer @area:chat', async ({}, info) => {
	test.setTimeout(120000);
	const { root, dir, launch: start } = await fixture('Images fixture');
	const launch = () => start(false);
	const key = { projectId: 'project', id: 'task' };
	let app = await launch();
	try {
		let page = await app.firstWindow();
		// A tall page screenshot, a wide toolbar strip and an ordinary one; the second keeps the name an older build stored translated.
		const pngs = await app.evaluate(({ nativeImage }) =>
			(
				[
					[600, 1900, [0xd0, 0x60, 0x20]],
					[2400, 220, [0x20, 0xa0, 0x40]],
					[160, 100, [0x20, 0x60, 0xd0]],
				] as [number, number, number[]][]
			).map(([width, height, [r, g, b]]) => {
				const bitmap = Buffer.alloc(width * height * 4);
				for (let i = 0; i < bitmap.length; i += 4) {
					const row = Math.floor(i / 4 / width);
					bitmap[i] = row < 20 ? 0xff : b!;
					bitmap[i + 1] = row < 20 ? 0xff : g!;
					bitmap[i + 2] = row < 20 ? 0xff : r!;
					bitmap[i + 3] = 0xff;
				}
				return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG().toString('base64');
			})
		);
		const created = await page.evaluate(
			async ([key, pngs]) => {
				const make = (input: any) => window.brigadir.createAttachment(key, input);
				return [
					await make({ kind: 'image', name: 'Pasted image', mimeType: 'image/png', data: pngs[0] }),
					await make({
						kind: 'image',
						name: 'Вставлене зображення',
						mimeType: 'image/png',
						data: pngs[1],
					}),
					await make({ kind: 'image', name: 'menu.png', mimeType: 'image/png', data: pngs[2] }),
					await make({
						kind: 'text',
						name: 'notes.txt',
						text: 'File reference:\nAbsolute path: "/tmp/notes.txt"',
						fileBytes: 52000,
					}),
				];
			},
			[key, pngs] as const
		);
		await app.close();
		const events = [
			{ kind: 'turn.started', text: 'The ring is missing on these screens.', attachments: created },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'a',
				content: { kind: 'text', text: 'I see it on all three.' },
			},
			{ kind: 'turn.completed', reason: 'end_turn' },
			{ kind: 'turn.started', text: '', attachments: [created[2]] },
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
						at: new Date(Date.UTC(2026, 9, 2, 10, 0, index)).toISOString(),
						event,
					})
				)
				.join('\n') + '\n'
		);
		app = await launch();
		page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
		await page.getByRole('button', { name: /Images fixture/ }).click();
		const messages = page.locator('[data-attachments][class*="log"]'),
			first = messages.first(),
			tiles = first.locator('button');
		await expect(messages).toHaveCount(2);
		await expect(tiles).toHaveCount(4);
		// The interface names a pasted image by kind: the stored English key and the old translated name both read «Pasted image».
		expect(
			await tiles.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))
		).toEqual(['Pasted image', 'Pasted image', 'menu.png', 'notes.txt']);
		await expect(first.getByRole('button', { name: /^Remove attachment/ })).toHaveCount(0);
		const images = first.locator('img');
		await expect(images).toHaveCount(3);
		expect(
			await images.evaluateAll((nodes) =>
				nodes.map((node) => (node as HTMLImageElement).dataset.crop)
			)
		).toEqual(['top', 'start', 'center']);
		// Tiles get the small cached PNG, not the full image: 600 × 1900 arrives as 176 × 557.
		expect(
			await images
				.first()
				.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])
		).toEqual([176, 557]);
		expect(
			(await stat(join(dir, 'attachments', created[0]!.id, 'thumb.png'))).size
		).toBeGreaterThan(0);
		// The viewer: the full image, «1 of 3», ← and →, Esc returns focus to the tile.
		await tiles.first().click();
		const viewer = page.getByRole('dialog', { name: 'Pasted image', exact: true });
		await expect(viewer).toBeVisible();
		await expect(viewer.getByRole('img', { name: 'Pasted image' })).toBeVisible();
		expect(
			await viewer
				.getByRole('img', { name: 'Pasted image' })
				.evaluate((img: HTMLImageElement) => img.naturalWidth)
		).toBe(600);
		await expect(viewer).toContainText('1 of 3');
		await expect(viewer).toContainText('600 × 1900');
		await expect(viewer.getByRole('button', { name: 'Previous image · ←' })).toBeDisabled();
		await expect(viewer.getByRole('tab')).toHaveCount(3);
		await expect(viewer.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('ArrowRight');
		await expect(viewer).toContainText('2 of 3');
		await expect(viewer.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.waitForTimeout(250);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`log-viewer-${theme}.png`),
			});
		}
		await viewer.getByRole('button', { name: 'Next image · →' }).click();
		const named = page.getByRole('dialog', { name: 'menu.png', exact: true });
		await expect(named).toContainText('3 of 3');
		await expect(named.getByRole('button', { name: 'Next image · →' })).toBeDisabled();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(tiles.first()).toBeFocused();
		// A text attachment keeps the document sheet, now closed with Esc as every modal (rule 14).
		await tiles.nth(3).click();
		const sheet = page.getByRole('dialog', { name: 'notes.txt', exact: true });
		await expect(sheet).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(sheet).toHaveCount(0);
		// An image gone from the task data is «unavailable» on its tile and in the viewer.
		await rm(join(dir, 'attachments', created[1]!.id, 'image.png'));
		await page.reload();
		await page.getByRole('button', { name: /Images fixture/ }).click();
		const missing = page
			.locator('[data-attachments][class*="log"]')
			.first()
			.locator('[data-state="missing"] button');
		await expect(missing).toHaveCount(1);
		await missing.click();
		const gone = page.getByRole('dialog', { name: 'Pasted image', exact: true });
		await expect(gone.getByRole('status')).toBeVisible();
		await expect(gone).toContainText('2 of 3');
		await page.keyboard.press('Escape');
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		await page.mouse.move(0, 0);
		await page
			.locator('[class*="user"]')
			.first()
			.screenshot({
				animations: 'disabled',
				path: info.outputPath('log-message-missing-light.png'),
			});
		expect(errors).toEqual([]);
	} finally {
		await app.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
