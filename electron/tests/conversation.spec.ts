import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { showChat, hideChat } from './layout';
const desktop = resolve('apps/desktop');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
test('creates a task, answers permission after Electron restart, and exchanges an MCP question @area:chat @smoke', async ({}, info) => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-chat-ui-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const launch = () =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: {
				...env,
				BRIGADIR_DATA_DIR: join(root, 'data'),
				BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			},
		});
	let app = await launch();
	let page = await app.firstWindow();
	let key: { projectId: string; id: string } | undefined;
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	try {
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		await page.getByRole('button', { name: 'Add a project…' }).click();
		await page.getByRole('button', { name: 'New task · repository' }).click();
		await page.getByRole('textbox', { name: 'Message' }).fill('permission');
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Write example' })).toBeVisible({
			timeout: 20000,
		});
		key = await page.evaluate(async () => {
			const task = (await window.brigadir.readWorkspace()).tasks[0]!;
			return { projectId: task.projectId, id: task.id };
		});
		const hostPath = join(root, 'data/projects', key.projectId, 'tasks', key.id, 'host.json');
		const before = JSON.parse(await readFile(hostPath, 'utf8'));
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /permission/ }).click();
		await expect(page.getByRole('heading', { name: 'Write example' })).toBeVisible();
		expect(JSON.parse(await readFile(hostPath, 'utf8')).instance).toBe(before.instance);
		await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeEnabled();
		await page.getByRole('button', { name: 'Allow', exact: true }).focus();
		await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeFocused();
		await expect
			.poll(() =>
				app.evaluate(
					({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('review-send')!.enabled
				)
			)
			.toBe(true);
		await app.evaluate(({ Menu }) => {
			const items = Menu.getApplicationMenu()!.items.find((item) => item.label === 'View')!.submenu!
				.items;
			const always = items.find((item) => item.label === 'Submit and go or allow always')!;
			if (always.accelerator !== 'CmdOrCtrl+Shift+Enter')
				throw new Error('Missing allow-always shortcut');
			always.click();
		});
		await expect(page.getByRole('heading', { name: 'Write example' })).toBeVisible();
		await app.evaluate(({ Menu }) => {
			const submit = Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Submit')!;
			if (submit.accelerator !== 'CmdOrCtrl+Enter') throw new Error('Missing submit shortcut');
			submit.click();
		});
		await expect(page.getByRole('log')).toContainText('world');
		await page.getByRole('textbox', { name: 'Message' }).fill('question');
		await page.getByRole('button', { name: 'Send', exact: true }).click();
		// spec/chat#tool-calls: the card names the key that answers it (View ▸ Submit); an option hovers as a whole.
		const card = page.locator('[data-question-id]').first();
		await expect(card.getByText('Which color?', { exact: true })).toBeVisible();
		await expect(card).toContainText('⌘↩ to answer');
		await expect(card).not.toContainText('⎋');
		const blue = card.locator('label').filter({ hasText: 'Blue' });
		await blue.hover();
		await expect
			.poll(() => blue.evaluate((node) => getComputedStyle(node).backgroundColor))
			.not.toBe('rgba(0, 0, 0, 0)');
		await page.getByRole('textbox', { name: 'Answer', exact: true }).focus();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Submit')!
				.click()
		);
		expect(
			(await page.evaluate((key) => window.brigadir.readSession(key), key)).records.some(
				(record) => record.event.kind === 'question.resolved'
			)
		).toBe(false);
		await page.getByRole('checkbox', { name: 'Blue', exact: true }).check();
		await page.getByRole('checkbox', { name: 'Green', exact: true }).check();
		await page.getByRole('textbox', { name: 'Answer', exact: true }).fill('Both colors');
		await expect(card).toContainText('Selected: 3');
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('question-light.png') });
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'dark';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('question-dark.png') });
		await hideChat(page);
		await page.getByRole('textbox', { name: 'Answer', exact: true }).focus();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Submit')!
				.click()
		);
		await expect(page.getByRole('textbox', { name: 'Answer', exact: true })).toHaveCount(0);
		await showChat(page);
		await expect(page.getByRole('log')).toContainText('Both colors');
		await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
		const result = await page.evaluate(async (key) => window.brigadir.readSession(key), key);
		expect(result.records.filter((r) => r.event.kind === 'question.resolved')).toHaveLength(1);
		expect(result.records.filter((r) => r.event.kind === 'session.started')).toHaveLength(1);
		await app.evaluate(({ Menu }) => {
			const item = Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Turns')!;
			if (item.accelerator !== 'CmdOrCtrl+Shift+U') throw new Error('Missing shortcut');
			item.click();
		});
		const turns = page.getByRole('list', { name: 'Turns', exact: true });
		await expect(turns.getByRole('button')).toHaveCount(2);
		await turns.getByRole('button').filter({ hasText: 'question' }).click();
		await expect(turns.getByRole('button').filter({ hasText: 'question' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('question');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('turns-dark.png') });
		// spec/chat-turns-plans-and-questions#question-card: the question is the chat's Markdown — emphasis, code and a list, not the raw `**` and backticks.
		await page.getByRole('textbox', { name: 'Message', exact: true }).fill('question markdown');
		await page.getByRole('button', { name: 'Send', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
		const marked = page.locator('[data-question-id]').last();
		await expect(marked.locator('strong', { hasText: 'color' })).toBeVisible();
		await expect(marked.locator('code', { hasText: 'providers/Printers/**' })).toBeVisible();
		await expect(marked.locator('ol > li')).toHaveText(['Blue', 'Green']);
		await expect(marked).not.toContainText('**color**');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await marked.screenshot({
				animations: 'disabled',
				path: info.outputPath(`question-markdown-${theme}.png`),
			});
		}
		await page.getByRole('button', { name: 'Skip', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Skip', exact: true })).toHaveCount(0);
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readSession(key), key!)).records
						.filter((record) => record.event.kind === 'question.resolved')
						.at(-1)?.event
			)
			.toMatchObject({ kind: 'question.resolved', answer: null });
		expect(errors).toEqual([]);
		// Runtime IPC arguments are checked before accessing paths or host commands.
		expect(
			await page.evaluate(async () => {
				try {
					await window.brigadir.readSession({ projectId: '..', id: 'bad' });
					return false;
				} catch {
					return true;
				}
			})
		).toBe(true);
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }), key);
		await page.getByRole('button', { name: 'New task · repository' }).click();
		await expect(
			page.getByRole('dialog', { name: 'New task', exact: true }).locator('.cm-placeholder')
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect
			.poll(() => page.evaluate(async () => (await window.brigadir.readWorkspace()).tasks.length))
			.toBe(2);
		key = await page.evaluate(async () => {
			const task = (await window.brigadir.readWorkspace()).tasks.find(
				(task) => task.prompt === ''
			)!;
			return { projectId: task.projectId, id: task.id };
		});
		await expect
			.poll(() =>
				page.evaluate(
					async (key) =>
						(await window.brigadir.readSession(key)).records.some(
							(record) => record.event.kind === 'session.started'
						),
					key!
				)
			)
			.toBe(true);
		expect(
			(await page.evaluate((key) => window.brigadir.readSession(key), key)).records.some(
				(record) => record.event.kind === 'turn.started'
			)
		).toBe(false);
		await expect(page.getByRole('textbox', { name: 'Message' })).toBeEnabled();
		await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
	} finally {
		if (key)
			await page
				.evaluate(async (key) => {
					await window.brigadir.sendCommand(key, { kind: 'shutdown' }).catch(() => {});
				}, key)
				.catch(() => {});
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('virtualizes 10,000 rows and preserves a transcript with a newer schema @area:chat', async ({}, info) => {
	const { writeFile } = await import('node:fs/promises');
	const root = await mkdtemp(join(tmpdir(), 'brigadir-long-ui-'));
	const dir = join(root, 'data/projects/fixture/tasks/large');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'fixture', name: 'Fixture', path: root } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { id: 'large', projectId: 'fixture', title: 'Long conversation', status: 'done' },
		})
	);
	const lines = Array.from({ length: 10000 }, (_, i) =>
		JSON.stringify({
			schemaVersion: 1,
			seq: i + 1,
			at: '2026-09-09T00:00:00Z',
			event: { kind: 'turn.started', text: `Row ${i + 1}` },
		})
	);
	const future = JSON.stringify({
		schemaVersion: 99,
		seq: 10001,
		at: '2026-09-09T00:00:00Z',
		event: { kind: 'future' },
	});
	const bytes = [...lines, future, ''].join('\n');
	await writeFile(join(dir, 'events.jsonl'), bytes);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		const start = Date.now();
		await page.getByRole('button', { name: /Long conversation/ }).click();
		await expect(page.getByRole('log')).toContainText('Row 10000');
		expect(Date.now() - start).toBeLessThan(3000);
		expect(await page.locator('[data-row-id]').count()).toBeLessThan(100);
		await expect(page.getByRole('alert')).toContainText('The file uses a newer schema.');
		const frames = await page.getByRole('log').evaluate(async (node) => {
			const gaps: number[] = [];
			let last = performance.now();
			for (let i = 0; i < 45; i++) {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				const now = performance.now();
				gaps.push(now - last);
				last = now;
				node.scrollTop = node.scrollHeight * (1 - i / 44);
			}
			return gaps.sort((a, b) => a - b);
		});
		expect(frames[Math.floor(frames.length * 0.95)]!).toBeLessThan(50);
		await expect(page.getByRole('log')).toContainText('Row 1');
		expect(await page.locator('[data-row-id]').count()).toBeLessThan(100);
		// spec/task-window-workspace#layout-switch: the chat stands beside the work area; Find goes to the surface with the focus.
		await page.getByRole('log', { name: 'Conversation' }).focus();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'Editor')!
				.submenu!.items.find((item) => item.label === 'Find')!
				.click()
		);
		const find = page.getByRole('textbox', { name: 'Find in current panel' });
		await find.fill('Row 8765');
		await expect(page.getByRole('log').locator('[data-focused-row="true"]')).toContainText(
			'Row 8765'
		);
		expect(await page.locator('[data-row-id]').count()).toBeLessThan(100);
		await find.press('Escape');
		await expect(find).toHaveCount(0);
		expect(errors).toEqual([]);
		expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).toBe(bytes);
		await info.attach('row-performance.json', {
			body: JSON.stringify({
				rows: 10000,
				mounted: await page.locator('[data-row-id]').count(),
				p95FrameMs: frames[Math.floor(frames.length * 0.95)],
			}),
			contentType: 'application/json',
		});
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('scrolling up through rows not measured yet keeps the visible text in place @area:chat', async () => {
	const { writeFile } = await import('node:fs/promises');
	const root = await mkdtemp(join(tmpdir(), 'brigadir-scroll-ui-'));
	const dir = join(root, 'data/projects/fixture/tasks/tall');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'fixture', name: 'Fixture', path: root } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { id: 'tall', projectId: 'fixture', title: 'Tall conversation', status: 'done' },
		})
	);
	// Rows far taller than the 64 px estimate, like long answers with code: each one mounted while scrolling up resizes above the reader.
	const answer = (i: number) =>
		`## Answer ${i}\n\n${'A paragraph that wraps over several lines in the conversation column. '.repeat(6)}\n\n- one\n- two\n- three\n\n\`\`\`ts\n${Array.from({ length: 12 }, (_, line) => `const value${line} = ${i} * ${line};`).join('\n')}\n\`\`\`\n`;
	const lines = Array.from({ length: 80 }, (_, i) => [
		{ kind: 'turn.started', text: `Question ${i + 1}` },
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: `a${i}`,
			content: { kind: 'text', text: answer(i + 1) },
		},
		{ kind: 'turn.completed', reason: 'end_turn' },
	])
		.flat()
		.map((event, seq) =>
			JSON.stringify({ schemaVersion: 1, seq: seq + 1, at: '2026-09-09T00:00:00Z', event })
		);
	await writeFile(join(dir, 'events.jsonl'), [...lines, ''].join('\n'));
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Tall conversation/ }).click();
		const log = page.getByRole('log', { name: 'Conversation' });
		await expect(log).toContainText('Answer 80');
		const jumps = await log.evaluate(async (node) => {
			// A resize observer made after the log's own runs after it each frame, past layout and before paint. Nested deeper than
			// any row, the probe is read in the same observer pass as the rows, so what it reads is what the reader sees.
			let parent: HTMLElement = document.body;
			for (let depth = 0; depth < 120; depth++) {
				const next = document.createElement('div');
				parent.append(next);
				parent = next;
			}
			const outer = document.body.lastElementChild as HTMLElement;
			outer.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none';
			const probe = document.createElement('div');
			probe.style.cssText = 'width:1px;height:1px';
			parent.append(probe);
			let anchor: { id: string; top: number } | undefined,
				requested = 0;
			const jumps: number[] = [];
			const pick = () => {
				const box = node.getBoundingClientRect();
				const row = [...node.querySelectorAll<HTMLElement>('[data-row-id]')].find(
					(row) => row.getBoundingClientRect().top >= box.top
				);
				anchor = row && { id: row.dataset.rowId!, top: row.getBoundingClientRect().top };
			};
			const observer = new ResizeObserver(() => {
				const row = anchor && node.querySelector<HTMLElement>(`[data-row-id="${anchor.id}"]`);
				if (row && anchor)
					jumps.push(Math.abs(row.getBoundingClientRect().top - anchor.top - requested));
				requested = 0;
				pick();
			});
			observer.observe(probe);
			pick();
			for (let frame = 0; frame < 160 && node.scrollTop > 0; frame++) {
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => {
						const before = node.scrollTop;
						node.scrollTop -= 120;
						requested = before - node.scrollTop;
						probe.style.width = `${1 + (frame % 2)}px`;
						resolve();
					})
				);
			}
			for (let frame = 0; frame < 4; frame++)
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => {
						probe.style.width = `${1 + (frame % 2)}px`;
						resolve();
					})
				);
			observer.disconnect();
			outer.remove();
			return jumps;
		});
		expect(jumps.length).toBeGreaterThan(50);
		expect(Math.max(...jumps)).toBeLessThan(2);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
