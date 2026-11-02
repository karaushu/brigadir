import { refreshChanges } from './refresh-changes';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionEvent } from '../packages/core/src/session';
import { showChat } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
const launchApp = (root: string, data: string) =>
	electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
test('activity shows a real tool diff and opens turn chips at their own checkpoint range @area:chat @serial', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-activity-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
	const before = '.button:focus-visible {\n  outline: none;\n}\n',
		after =
			'.button:focus-visible {\n  outline: 2px solid var(--focus-ring);\n  outline-offset: 2px;\n}\n';
	await writeFile(join(repo, 'Button.module.css'), before);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'choice', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Fix the Button focus ring',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const launch = () => launchApp(root, data);
	let app = await launch();
	try {
		let page = await app.firstWindow();
		await page.getByRole('button', { name: /Fix the Button focus ring/ }).click();
		async function checkpoint(id: number) {
			await refreshChanges(page);
			await expect
				.poll(() =>
					page.evaluate(
						async () =>
							(await window.brigadir.readChanges({ projectId: 'project', id: 'task' })).checkpoint
					)
				)
				.toBe(id);
		}
		await checkpoint(0);
		await writeFile(join(repo, 'Button.module.css'), after);
		await checkpoint(1);
		await writeFile(join(repo, 'later.txt'), 'outside the completed turn\n');
		await checkpoint(2);
		await app.close();
		const events: SessionEvent[] = [
			{ kind: 'checkpoint.created', checkpoint: 0 },
			{
				kind: 'turn.started',
				text: 'Fix the focus ring on the Button. It disappears when you Tab into it in Safari.',
			},
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'intro',
				content: {
					kind: 'text',
					text: 'The focus rule removes the outline. I will keep the ring visible for keyboard navigation.',
				},
			},
			{
				kind: 'tool.changed',
				patch: {
					id: 'edit',
					category: 'edit',
					title: 'Edit Button.module.css',
					content: [{ kind: 'diff', path: 'Button.module.css', before, after }],
				},
			},
			{ kind: 'tool.changed', patch: { id: 'edit', status: 'completed' } },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'answer',
				content: {
					kind: 'text',
					text: 'The keyboard focus rule now uses `var(--focus-ring)` and a two-pixel offset. Please check the result in Safari.',
				},
			},
			{ kind: 'checkpoint.created', checkpoint: 1 },
			{ kind: 'turn.completed', reason: 'end_turn' },
			{ kind: 'checkpoint.created', checkpoint: 2 },
			{ kind: 'host.stopped', reason: 'Fixture offline' },
		];
		await writeFile(
			join(dir, 'events.jsonl'),
			events
				.map((event, index) =>
					JSON.stringify({
						schemaVersion: 1,
						seq: index + 1,
						at: new Date(Date.UTC(2026, 8, 10, 10, 0, index)).toISOString(),
						event,
					})
				)
				.join('\n') + '\n'
		);
		app = await launch();
		await app.evaluate(({ clipboard }) => {
			(globalThis as any).savedActivityClipboard = clipboard.readText();
		});
		page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
		await page.getByRole('button', { name: /Fix the Button focus ring/ }).click();
		const preview = page.getByRole('log', { name: 'Tool diff · Button.module.css', exact: true });
		await expect(preview).toContainText('outline: none');
		await expect(preview).toContainText('outline: 2px solid');
		await expect(preview.locator('[data-kind="removed"]')).toHaveCount(1);
		await expect(preview.locator('[data-kind="added"]')).toHaveCount(2);
		await expect(
			preview.locator('[data-kind="added"] [data-changed="true"]').first()
		).toBeVisible();
		const footer = page.getByLabel('Turn 1', { exact: true });
		await expect(footer).toContainText('Button.module.css');
		await expect(footer).not.toContainText('later.txt');
		await footer.getByRole('button', { name: 'Copy response', exact: true }).click();
		await expect
			.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
			.toBe(
				'The focus rule removes the outline. I will keep the ring visible for keyboard navigation.\n\nThe keyboard focus rule now uses `var(--focus-ring)` and a two-pixel offset. Please check the result in Safari.'
			);
		await app.evaluate(({ Menu }) => {
			const original = Menu.prototype.popup;
			Menu.prototype.popup = function (options) {
				(globalThis as any).turnMenuItems = this.items.map((item) => ({
					label: item.label,
					enabled: item.enabled,
				}));
				this.items.find((item) => item.label === 'Show changes')!.click();
				options?.callback?.();
				Menu.prototype.popup = original;
			};
		});
		await footer.getByRole('button', { name: 'Turn actions', exact: true }).click();
		await expect(page.getByRole('list', { name: 'Files', exact: true })).toContainText(
			'Button.module.css'
		);
		await expect(page.getByRole('list', { name: 'Files', exact: true })).not.toContainText(
			'later.txt'
		);
		expect(await app.evaluate(() => (globalThis as any).turnMenuItems)).toEqual([
			{ label: 'Copy response', enabled: true },
			{ label: 'Show changes', enabled: true },
		]);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`activity-${theme}.png`),
			});
		}
		await footer.getByRole('button', { name: /Button.module.css/ }).click();
		await expect(
			page.getByRole('tab', { name: 'Diff · Button.module.css', exact: true })
		).toBeVisible();
		await page.getByRole('button', { name: 'Diff options', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Base', exact: true })).toContainText('#0');
		await expect(page.getByRole('button', { name: 'End', exact: true })).toContainText('#1');
		await page.getByRole('button', { name: 'Diff options', exact: true }).click();
		await expect(page.getByRole('log', { name: 'Diff', exact: true })).toContainText(
			'outline-offset'
		);
		await expect(page.getByRole('list', { name: 'Files', exact: true })).not.toContainText(
			'later.txt'
		);
		await showChat(page);
		await page
			.getByRole('button', { name: 'Open current diff · Button.module.css', exact: true })
			.press('Enter');
		await page.getByRole('button', { name: 'Diff options', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Base', exact: true })).toContainText('#0');
		await expect(page.getByRole('button', { name: 'End', exact: true })).toContainText('#2');
		await page.getByRole('button', { name: 'Diff options', exact: true }).click();
		await expect(page.getByRole('list', { name: 'Files', exact: true })).toContainText('later.txt');
		await showChat(page);
		await writeFile(join(repo, 'Button.module.css'), before);
		await checkpoint(3);
		await page
			.getByRole('button', { name: 'Open current diff · Button.module.css', exact: true })
			.click();
		await expect(
			page
				.getByRole('status')
				.filter({ hasText: 'This file has no changes in the current snapshot.' })
		).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(
					async () =>
						(await window.brigadir.readChanges({ projectId: 'project', id: 'task' })).checkpoint
				)
			)
			.toBe(3);
		expect(errors).toEqual([]);
	} finally {
		await app
			.evaluate(({ clipboard }) => {
				if (typeof (globalThis as any).savedActivityClipboard === 'string')
					clipboard.writeText((globalThis as any).savedActivityClipboard);
			})
			.catch(() => {});
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('activity navigates grouped and virtual tools, parks collapse state and keeps a scroll anchor @area:chat', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-activity-navigation-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await writeFile(join(repo, 'example.ts'), 'export const value = 1;');
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Activity navigation fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	const events: any[] = [
		{ kind: 'turn.started', text: 'Review the example.' },
		{
			kind: 'message.delta',
			role: 'thought',
			messageId: 'thought',
			content: {
				kind: 'text',
				text: Array.from({ length: 40 }, (_, index) => `Thinking line ${index}`).join('\n'),
			},
		},
		{
			kind: 'tool.changed',
			patch: { id: 'read-one', title: 'Read first', category: 'read', status: 'completed' },
		},
		{
			kind: 'tool.changed',
			patch: { id: 'read-two', title: 'Read second', category: 'read', status: 'completed' },
		},
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'answer',
			content: {
				kind: 'text',
				text:
					'Visible anchor\n\nSee example.ts.\n\n```ts\n' +
					Array.from({ length: 10 }, (_, i) => `export const value${i} = ${i};`).join('\n') +
					'\n```\n\n' +
					Array.from(
						{ length: 40 },
						(_, index) =>
							`Paragraph ${index}. ` + 'Text for a stable transcript viewport. '.repeat(5)
					).join('\n\n'),
			},
		},
		{
			kind: 'tool.changed',
			patch: { id: 'last', title: 'Edit last', category: 'edit', status: 'completed' },
		},
		{ kind: 'turn.completed', reason: 'end_turn' },
		{ kind: 'host.stopped', reason: 'Offline fixture' },
	];
	await writeFile(
		join(dir, 'events.jsonl'),
		events
			.map((event, index) =>
				JSON.stringify({
					schemaVersion: 1,
					seq: index + 1,
					at: new Date(Date.UTC(2026, 8, 10, 12, 0, index)).toISOString(),
					event,
				})
			)
			.join('\n') + '\n'
	);
	const app = await launchApp(root, data);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Activity navigation fixture/ }).click();
		const log = page.getByRole('log', { name: 'Conversation' });
		const action = async (label: string) => {
			await app.evaluate(({ Menu }, label) => {
				function find(items: Electron.MenuItem[]): Electron.MenuItem | undefined {
					for (const item of items) {
						if (item.label === label) return item;
						const child = item.submenu && find(item.submenu.items);
						if (child) return child;
					}
				}
				find(Menu.getApplicationMenu()!.items)!.click();
			}, label);
		};
		await log.focus();
		await action('Next tool or hunk');
		await expect(page.locator('[data-tool-target="1/tool/read-one"]')).toBeFocused();
		await action('Next tool or hunk');
		await expect(page.locator('[data-tool-target="1/tool/read-two"]')).toBeFocused();
		await action('Next tool or hunk');
		await expect(page.locator('[data-tool-target="1/tool/last"]')).toBeFocused();
		await action('Previous tool or hunk');
		await expect(page.locator('[data-tool-target="1/tool/read-two"]')).toBeFocused();
		// spec/chat#layout: «Collapse» folds a long code block to 8 lines with «Show all · N»; «Expand» shows it whole.
		await action('Collapse conversation');
		await expect(log.getByRole('button', { name: 'Show all · 10', exact: true })).toHaveCount(1);
		await log.getByRole('button', { name: 'example.ts', exact: true }).click();
		await expect(page.getByRole('textbox', { name: 'File content' })).toBeVisible();
		await showChat(page);
		// The folded block is taller than the old one-line block: bring it back into the mounted rows first.
		await log.evaluate((node) => (node.scrollTop = 0));
		await expect(log.getByRole('button', { name: 'Show all · 10', exact: true })).toHaveCount(1);
		await log.focus();
		await action('Expand conversation');
		await expect(log.getByRole('button', { name: 'Show less', exact: true })).toHaveCount(1);
		await action('Collapse conversation');
		await log.evaluate((node) => (node.scrollTop = 0));
		const anchor = log.getByText('Visible anchor', { exact: true });
		await expect(anchor).toBeVisible();
		await anchor.evaluate((node) => {
			const viewport = node.closest('[role="log"]')!;
			viewport.scrollTop +=
				node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 30;
		});
		await anchor.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		);
		const before = (await anchor.boundingBox())!.y;
		const thought = log
			.locator('details')
			.filter({ has: page.locator('summary', { hasText: /^(thinking|thought)/ }) });
		await thought.evaluate((node: HTMLDetailsElement) => (node.open = true));
		await thought.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		);
		await expect
			.poll(async () => Math.abs((await anchor.boundingBox())!.y - before))
			.toBeLessThan(2);
		await expect(thought.locator('p')).toBeAttached();
		const latest = page.getByRole('button', { name: 'To latest ↓', exact: true });
		await expect(latest).toBeVisible();
		await latest.click();
		await expect(latest).toBeHidden();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.webContents.send('session:event', {
				key: { projectId: 'project', id: 'task' },
				record: {
					schemaVersion: 1,
					seq: 9,
					at: new Date().toISOString(),
					event: {
						kind: 'message.delta',
						role: 'assistant',
						messageId: 'late',
						content: { kind: 'text', text: 'Newest output' },
					},
				},
			})
		);
		await expect(log.getByText('Newest output', { exact: true })).toBeVisible();
		await expect(latest).toBeHidden();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
