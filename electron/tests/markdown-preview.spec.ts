import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hideChat, openPanelTab } from './layout';

const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const filler = Array.from(
	{ length: 40 },
	(_, i) => `- Note ${i + 1} about reconnects and slices.`
).join('\n');
const live = `# Live updates\n\nHow the client keeps the store in sync. See [state overview](./README.md).\n\n## Event types\n\n| Event | Slice |\n|---|---|\n| order.created | orders |\n\n| Domain | Events | Mechanism, where |\n|---|---|---|\n| couriers | \`COURIER_ADDED\`, \`COURIER_CHANGED\`, \`COURIER_ENABLED\`, \`COURIER_DISABLED\`, \`COURIER_REMOVED\`, \`COURIER_RESTORED\` | loader, \`couriers.ts\`; page-local on \`src/pages/integrations/banners/[bannersName]/index.tsx\` and the delivery tab |\n\n## Applying a patch\n\n\`\`\`ts\nexport function apply(state: State) { return state; }\n\`\`\`\n\n## Notes\n\n${filler}\n\nThe slice refetches on resync.\n`;
const before = `# State management\n\nEach slice owns its data, its selectors and its loaders.\n\n- orders\n- tables\n\n## Polling\n\nOrders poll every 5 seconds.\n`;
const after = `# State management\n\nEach slice owns its data, its selectors, its loaders and its live patch.\n\n- orders\n- tables\n- staff\n\n## Live updates\n\nOrders update over a WebSocket.\n`;

// spec/editor#markdown-views: Markdown in the editor (Code | Side by side | Preview) and in the diff (the third view), the menu toggle and ⌘F.
test('Markdown shows rendered in the editor and the diff, keeps the place and toggles from the menu @area:editor', async () => {
	test.setTimeout(150000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-markdown-')),
		project = join(root, 'choice'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task'),
		docs = join(project, 'docs/state');
	const git = async (...args: string[]) =>
		(await promisify(execFile)('git', args, { cwd: project })).stdout.trim();
	await mkdir(docs, { recursive: true });
	await mkdir(dir, { recursive: true });
	await git('init', '-q', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'f@example.invalid');
	await writeFile(join(docs, 'README.md'), before);
	await git('add', '-A');
	await git('commit', '-qm', 'docs');
	await writeFile(join(docs, 'README.md'), after);
	await writeFile(join(docs, 'live-updates.md'), live);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: {
				appearance: 'light',
				accent: 'blue',
				language: 'en',
				editor: { languageServers: false, diffBase: 'head', lineAuthor: false },
			},
		})
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'choice', path: project } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Markdown docs',
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
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	const menuItem = (id: string) =>
		app.evaluate(({ Menu }, id) => {
			const item = Menu.getApplicationMenu()!.getMenuItemById(id)!;
			return {
				enabled: item.enabled,
				checked: item.checked,
				type: item.type,
				accelerator: item.accelerator,
			};
		}, id);
	const clickMenu = async (id: string) => {
		await expect.poll(async () => (await menuItem(id)).enabled).toBe(true);
		await app.evaluate(
			({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(),
			id
		);
	};
	try {
		const page: Page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page
			.getByRole('button', { name: /Markdown docs/ })
			.first()
			.click();
		await openPanelTab(page, 'changes');
		await page
			.getByRole('button', { name: 'Create snapshot and refresh changes', exact: true })
			.click();
		const files = page.getByRole('list', { name: 'Files', exact: true });
		await files.getByRole('button', { name: /live-updates\.md/ }).click();
		const layout = page.getByRole('radiogroup', { name: 'Diff', exact: true }),
			wrap = page.getByRole('button', { name: 'Wrap lines', exact: true });
		await expect(page.getByRole('log', { name: 'Diff', exact: true })).toContainText(
			'# Live updates'
		);
		expect(await menuItem('markdown-preview')).toMatchObject({
			type: 'checkbox',
			checked: false,
			accelerator: 'CmdOrCtrl+Shift+V',
		});

		// The diff: a third view; a new file is one rendered document with a green strip.
		await layout.getByRole('radio', { name: 'Preview', exact: true }).click();
		const diffPreview = page.getByRole('document', { name: 'Changes preview' });
		await expect(diffPreview.getByRole('heading', { name: 'Live updates' })).toBeVisible();
		await expect(diffPreview).toHaveAttribute('data-new-file', 'true');
		// A wide table keeps short words whole: the first column is not squeezed to a letter per line.
		expect(
			await diffPreview.locator('th', { hasText: 'Domain' }).evaluate((th) => {
				const range = document.createRange();
				range.selectNodeContents(th);
				return range.getClientRects().length;
			})
		).toBe(1);
		await expect(wrap).toBeDisabled();
		await expect.poll(async () => (await menuItem('markdown-preview')).checked).toBe(true);
		// One value per task: the next Markdown diff opens rendered too, old block above new, the added item green.
		await files.getByRole('button', { name: /README\.md/ }).click();
		await expect(diffPreview.locator('[data-change=removed]').first()).toHaveText(
			'Each slice owns its data, its selectors and its loaders.'
		);
		await expect(diffPreview.locator('li[data-change=added]')).toHaveText('staff');
		expect(
			await diffPreview.evaluate((node) => {
				const text = node.textContent ?? '';
				return (
					text.indexOf('selectors and its loaders') < text.indexOf('its live patch') &&
					text.indexOf('Polling') < text.indexOf('Live updates')
				);
			})
		).toBe(true);
		// ⌘F in the changes preview: the panels' field, matches in the rendered text.
		await diffPreview.click();
		await clickMenu('editor-find');
		await page.getByRole('searchbox', { name: 'Find', exact: true }).fill('orders');
		await expect
			.poll(() => page.evaluate(() => (CSS as any).highlights.get('md-find')?.size ?? 0))
			.toBe(3);
		await page.keyboard.press('Escape');
		// The menu toggles back to the last code layout.
		await clickMenu('markdown-preview');
		await expect(page.getByRole('log', { name: 'Diff', exact: true })).toBeVisible();
		await expect(layout.getByRole('radio', { name: 'Unified', exact: true })).toBeChecked();
		await clickMenu('markdown-preview');
		await expect(diffPreview).toBeVisible();

		// «Open in editor» from the rendered diff opens the editor rendered; the footer names Markdown.
		await files.getByRole('button', { name: /live-updates\.md/ }).click();
		await page.getByRole('button', { name: 'Open in editor', exact: true }).first().click();
		const views = page.getByRole('radiogroup', { name: 'Markdown view', exact: true }),
			preview = page.getByRole('document', { name: 'Preview', exact: true });
		await expect(views.getByRole('radio', { name: 'Preview', exact: true })).toBeChecked();
		await expect(preview.getByRole('heading', { name: 'Applying a patch' })).toBeVisible();
		await expect(page.locator('section[data-font-surface=editor] footer')).toContainText(
			'Markdown'
		);
		expect(
			await views.getByRole('radio', { name: 'Code', exact: true }).getAttribute('title')
		).toBe('Code · ⇧⌘V');

		// Switching keeps the place: the top block of the preview becomes the caret line, and back.
		await preview.evaluate((node) => {
			const heading = [...node.querySelectorAll('h2')].find(
				(item) => item.textContent === 'Notes'
			)!;
			node.scrollTop += heading.getBoundingClientRect().top - node.getBoundingClientRect().top;
		});
		await views.getByRole('radio', { name: 'Code', exact: true }).click();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toBeVisible();
		await expect(preview).toHaveCount(0);
		await expect(page.locator('.cm-activeLine')).toHaveText('## Notes');
		await expect.poll(async () => (await menuItem('markdown-preview')).checked).toBe(false);
		await page.locator('.cm-line').filter({ hasText: '## Event types' }).click();
		await views.getByRole('radio', { name: 'Preview', exact: true }).click();
		await expect
			.poll(() =>
				preview.evaluate((node) => {
					const heading = [...node.querySelectorAll('h2')].find(
						(item) => item.textContent === 'Event types'
					)!;
					return (
						Math.abs(heading.getBoundingClientRect().top - node.getBoundingClientRect().top) < 40
					);
				})
			)
			.toBe(true);
		// A double click on a block opens the code on its first line.
		await preview.getByRole('heading', { name: 'Applying a patch' }).dblclick();
		await expect(page.locator('.cm-activeLine')).toHaveText('## Applying a patch');

		// Side by side: both sides; the preview follows the code's scroll and shows unsaved edits.
		await views.getByRole('radio', { name: 'Side by side', exact: true }).click();
		await expect(preview).toBeVisible();
		await expect(editor).toBeVisible();
		await page.locator('[data-font-surface=editor] .cm-scroller').evaluate((node) => {
			node.scrollTop = 0;
		});
		await page.locator('[data-font-surface=editor] .cm-scroller').evaluate((node) => {
			node.scrollTop = node.scrollHeight;
		});
		await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
		await page
			.locator('.cm-line')
			.filter({ hasText: 'The slice refetches on resync.' })
			.click({ position: { x: 8, y: 6 } });
		await page.keyboard.press('End');
		await page.keyboard.type(' Pages subscribe on mount.');
		await expect(preview).toContainText('Pages subscribe on mount.');
		for (let i = 0; i < 4; i++) await page.keyboard.press('Meta+z');

		// ⌘F in the preview: the floating find panel without replace (spec/editor#editor-chrome), matches highlighted in the rendered
		// text; Enter moves to a match.
		await views.getByRole('radio', { name: 'Preview', exact: true }).click();
		await expect(preview).toBeVisible();
		await page
			.locator('section[data-font-surface=editor] header')
			.getByRole('button', { name: 'Find', exact: true })
			.click();
		const findPanel = page.getByRole('search', { name: 'Find in file' });
		const field = findPanel.getByRole('textbox', { name: 'Find', exact: true });
		await expect(field).toBeVisible();
		await expect(findPanel.getByRole('button', { name: 'Show replace' })).toHaveCount(0);
		await expect(findPanel.getByRole('textbox', { name: 'Replace', exact: true })).toHaveCount(0);
		await field.pressSequentially('slice');
		await expect
			.poll(() => page.evaluate(() => (CSS as any).highlights.get('md-find')?.size ?? 0))
			.toBeGreaterThan(2);
		await field.press('Enter');
		await expect
			.poll(() => page.evaluate(() => (CSS as any).highlights.get('md-find-current')?.size ?? 0))
			.toBe(1);
		await field.press('Escape');

		// The menu: from Preview to Code and back to the last view with the preview.
		await clickMenu('markdown-preview');
		await expect(views.getByRole('radio', { name: 'Code', exact: true })).toBeChecked();
		await clickMenu('markdown-preview');
		await expect(views.getByRole('radio', { name: 'Preview', exact: true })).toBeChecked();
		// ⌥⌘F in the preview switches to the code and focuses the replace field once it shows.
		await clickMenu('editor-replace');
		await expect(views.getByRole('radio', { name: 'Code', exact: true })).toBeChecked();
		await expect(
			page
				.getByRole('search', { name: 'Find in file' })
				.getByRole('textbox', { name: 'Replace', exact: true })
		).toBeFocused();
		await page.keyboard.press('Escape');
		await views.getByRole('radio', { name: 'Preview', exact: true }).click();
		await expect(views.getByRole('radio', { name: 'Preview', exact: true })).toBeChecked();

		// Opening at a line shows the code: ⌘+click a line number in the code diff.
		await files.getByRole('button', { name: /README\.md/ }).click();
		await layout.getByRole('radio', { name: 'Unified', exact: true }).click();
		await page
			.getByRole('button', { name: 'Open in editor · new:3', exact: true })
			.click({ modifiers: ['Meta'] });
		await expect(views.getByRole('radio', { name: 'Code', exact: true })).toBeChecked();
		await expect(page.locator('.cm-activeLine')).toContainText('its live patch');

		// A narrow editor keeps the icons; the labels come back with the width (the chat away gives the editor room).
		await hideChat(page);
		const label = views.getByRole('radio', { name: 'Code', exact: true }).locator('span').last();
		await expect(label).toBeVisible();
		await page.locator('section[data-font-surface=editor]').evaluate((node) => {
			(node as HTMLElement).style.maxWidth = '400px';
		});
		await expect(label).toBeHidden();
		await expect(
			views.getByRole('radio', { name: 'Code', exact: true }).locator('svg')
		).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
