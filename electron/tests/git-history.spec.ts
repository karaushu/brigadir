import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { squashBranch } from '../packages/git/src/merge';
import { hideWorkArea, openPanelTab, showWorkArea } from './layout';
import { refreshChanges } from './refresh-changes';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
const day = 86_400_000;

// spec/git#merge: History of one branch, a commit's file as a diff tab, a merge with search, a conflict and its resolution.
test('history reads one branch, opens a commit file as a diff tab, merges through the dialog and walks a conflict to the merge commit @area:diff', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-git-history-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	const git = async (...args: string[]) =>
		(await promisify(execFile)('git', args, { cwd: repo })).stdout.trim();
	await mkdir(repo);
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(
		join(repo, 'total.ts'),
		'export function total(items) {\n  return sum(items);\n}\n'
	);
	await writeFile(join(repo, 'notes.md'), 'base\n');
	await git('add', '.');
	await git('commit', '-m', 'Seed');
	await git('checkout', '-b', 'feature/cart');
	await writeFile(
		join(repo, 'total.ts'),
		'export function total(items) {\n  return sum(items) * rate;\n}\n'
	);
	await writeFile(join(repo, 'rates.ts'), 'export const rate = 1.2;\n');
	await writeFile(join(repo, 'notes.md'), 'theirs note\n');
	await git('add', '.');
	await git('commit', '-m', 'Apply rate');
	await git('checkout', 'main');
	await writeFile(
		join(repo, 'total.ts'),
		'export function total(items) {\n  return round(sum(items), 2);\n}\n'
	);
	await writeFile(join(repo, 'notes.md'), 'ours note\n');
	await git('add', '.');
	await git('commit', '-m', 'Round total');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const task = await page.evaluate(async () => {
			const task = await window.brigadir.createTask(
				'project',
				'Merge the cart work',
				'claude',
				'gui',
				false
			);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(async () =>
				(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
					(record) => record.event.kind === 'turn.completed'
				)
			)
			.toBe(true);
		await page
			.locator('aside')
			.getByRole('button', { name: /Merge the cart work/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		await openPanelTab(page, 'changes');
		const panel = page.getByRole('complementary', { name: 'Changes', exact: true });
		const views = panel.getByRole('tablist', { name: 'Changes view', exact: true });
		await expect(views.getByRole('tab', { name: 'Diff', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		// One header for both modes: the switch does not remount or shift, the pill slides.
		const before = await views.boundingBox();
		await views.evaluate((node) => {
			node.dataset.kept = 'true';
		});
		await views.getByRole('tab', { name: 'History', exact: true }).click();
		await expect(views).toHaveAttribute('data-kept', 'true');
		await expect(views).toHaveAttribute('data-motion-ready', 'true');
		expect(await views.boundingBox()).toEqual(before);

		// One branch of one repo: the repo and branch selectors, then the commits.
		await expect(panel.getByRole('button', { name: 'Branch', exact: true })).toContainText('main');
		const commits = panel.getByRole('list', { name: 'History', exact: true });
		await expect(commits.getByRole('button', { name: /Round total/ })).toBeVisible();
		await expect(commits.getByRole('button', { name: /Apply rate/ })).toHaveCount(0);
		// spec/git#history-search: the search asks git over the whole history of the branch, not the page on screen.
		const scopeId = (
			await page.evaluate((task) => window.brigadir.readHistoryScopes(task), task)
		)[0]!.id;
		const found = await page.evaluate(
			({ task, scopeId }) => window.brigadir.readHistory(task, scopeId, 'main', null, 1, 'SEED'),
			{ task, scopeId }
		);
		expect(found.commits.map((commit) => commit.subject)).toEqual(['Seed']);
		await panel.getByRole('button', { name: 'Find a commit' }).click();
		const search = panel.getByRole('searchbox', { name: 'Find a commit' });
		await search.fill('seed');
		await expect(commits.getByRole('button', { name: /Seed/ })).toBeVisible();
		await expect(commits.getByRole('button', { name: /Round total/ })).toHaveCount(0);
		await expect(commits).toContainText('1 commit');
		await search.fill('no such commit');
		await expect(commits).toContainText('Nothing found');
		await search.fill('');
		await expect(commits.getByRole('button', { name: /Round total/ })).toBeVisible();
		await search.press('Escape');
		await commits.getByRole('button', { name: /Round total/ }).click();
		const sha = (await git('rev-parse', 'HEAD')).slice(0, 7);
		await commits.getByRole('button', { name: /total\.ts/ }).click();
		await expect(page.getByRole('tab', { name: 'Diff · total.ts', exact: true })).toContainText(
			`@${sha}`
		);
		await expect(page.locator('[class*=sides]')).toContainText(sha);
		await expect(
			page.getByRole('button', { name: 'Revert file changes…', exact: true })
		).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Open in editor', exact: true })).toBeDisabled();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({ path: info.outputPath(`history-${theme}.png`) });
		}
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});

		// spec/diff-and-review#changes-header: in the 1180 px window the work area squeezes the panel, but only down to its header in one line —
		// every control inside the header, none under another, in History and Diff, in English and Ukrainian.
		const header = page.locator('aside[data-task-right] header[class*=diffToolbar]');
		const fits = () =>
			header.evaluate((node) => {
				const box = node.getBoundingClientRect(),
					buttons = [...node.querySelectorAll('button')].map((button) => ({
						button,
						rect: button.getBoundingClientRect(),
					}));
				return buttons.every(
					({ button, rect }, index) =>
						rect.left >= box.left - 0.5 &&
						rect.right <= box.right + 0.5 &&
						buttons.every(
							(other, at) =>
								at <= index ||
								button.contains(other.button) ||
								other.button.contains(button) ||
								rect.right <= other.rect.left + 0.5 ||
								other.rect.right <= rect.left + 0.5
						)
				);
			});
		const width = async () => (await panel.boundingBox())!.width;
		expect(await width()).toBeLessThan(400);
		await expect.poll(fits).toBe(true);
		await views.getByRole('tab', { name: 'Diff', exact: true }).click();
		await expect.poll(fits).toBe(true);
		// The window takes the language with the appearance main publishes (as desktop.spec does).
		const appearance = await page.evaluate(() => window.brigadir.readAppearance());
		const language = (locale: 'en' | 'uk') =>
			app.evaluate(
				({ BrowserWindow }, value) =>
					BrowserWindow.getAllWindows()[0]!.webContents.send('appearance:changed', value),
				{ ...appearance, locale }
			);
		await language('uk');
		await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
		const ukViews = page.getByRole('tablist', { name: 'Вигляд змін', exact: true });
		await expect(ukViews).toBeVisible();
		await expect.poll(fits).toBe(true);
		await ukViews.getByRole('tab', { name: 'Історія', exact: true }).click();
		await expect(header.getByRole('button', { name: 'Змерджити…', exact: true })).toBeVisible();
		await expect.poll(fits).toBe(true);
		await language('en');
		await expect(views).toBeVisible();
		await expect.poll(fits).toBe(true);
		expect(await width()).toBeLessThan(400);
		// spec/diff-and-review#changes-header: a header still wider than the panel (a long range label on a panel past 360 px, where the chip shows its
		// label) scrolls sideways by wheel to its last button.
		await hideWorkArea(page);
		await views.getByRole('tab', { name: 'Diff', exact: true }).click();
		await header.evaluate((node) => {
			node.querySelector('[data-diff-base-chip] [class*=label]')!.textContent =
				'Snapshots #0–#1 · a much longer range label';
		});
		const box = (await header.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.wheel(0, 600);
		await expect
			.poll(() =>
				header.evaluate((node) => {
					const last = [...node.querySelectorAll('button')].at(-1)!.getBoundingClientRect();
					return node.scrollLeft > 0 && last.right <= node.getBoundingClientRect().right + 0.5;
				})
			)
			.toBe(true);
		await showWorkArea(page);
		await views.getByRole('tab', { name: 'History', exact: true }).click();

		// The modal: «Into» is the current branch, the search is focused at once; Esc closes it.
		await panel.getByRole('button', { name: 'Merge…', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Merge a branch', exact: true });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('combobox')).toBeFocused();
		await expect(dialog).toContainText('main');
		await expect(dialog).toContainText('current');
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await panel.getByRole('button', { name: 'Merge…', exact: true }).click();
		await expect(dialog.getByRole('combobox')).toBeFocused();
		await page.keyboard.type('feat');
		await expect(dialog.getByRole('option', { name: /feature\/cart/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await page.screenshot({ path: info.outputPath('merge-dialog.png') });
		await page.keyboard.press('Enter');
		await expect(dialog.getByRole('status')).toContainText('Conflict expected');
		await expect(dialog.getByRole('status')).toContainText('total.ts');
		// Clearing the chosen branch brings the search back focused; choosing again restores the preview.
		await dialog.locator('[class*=chosen]').click();
		await expect(dialog.getByRole('combobox')).toBeFocused();
		await page.keyboard.type('feat');
		await page.keyboard.press('Enter');
		await expect(dialog.getByRole('status')).toContainText('Conflict expected');
		expect(await git('status', '--porcelain')).toBe('');
		await dialog.getByRole('button', { name: 'Merge', exact: true }).click();

		// spec/appearance#evolution-redesign: «did not resolve itself» leads straight into the Conflicts dialog; nothing resolves by itself.
		await expect(dialog).toHaveCount(0);
		const merge = page.locator('[data-conflicts-dialog]');
		await expect(merge).toBeVisible();
		await expect(merge.getByRole('heading')).toContainText('Merging feature/cart into main');
		const finish = merge.getByRole('button', { name: 'Continue', exact: true });
		await expect(finish).toBeDisabled();
		await page.screenshot({ path: info.outputPath('merge-conflict.png') });
		const totalRow = merge.locator('[data-conflict-row="total.ts"]'),
			notesRow = merge.locator('[data-conflict-row="notes.md"]');
		await expect(totalRow).toContainText('1 conflict');
		await totalRow.getByRole('button', { name: 'Accept yours', exact: true }).click();
		await expect(totalRow).toContainText('Yours');
		await expect(finish).toBeDisabled();
		// ✦ on a row — a separate turn with the English prompt for that file only; the commit stays with the person.
		await notesRow.getByRole('button', { name: 'Resolve with the agent', exact: true }).click();
		await expect
			.poll(async () =>
				(await page.evaluate((task) => window.brigadir.readSession(task), task)).records
					.filter((record) => record.event.kind === 'turn.started')
					.map((record) => (record.event as { text: string }).text)
					.join('\n')
			)
			.toContain('Resolve the merge conflicts in the repo');
		const prompt = (
			await page.evaluate((task) => window.brigadir.readSession(task), task)
		).records.findLast((record) => record.event.kind === 'turn.started')!.event as { text: string };
		expect(prompt.text).toContain('- notes.md');
		expect(prompt.text).not.toContain('- total.ts');
		expect(prompt.text).toContain('Do not commit');
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.at(-1)
						?.event.kind
			)
			.not.toBe('turn.started');
		// The fixture agent leaves the markers: the row says so, the person's ways stay.
		await expect(notesRow).toContainText('Agent failed');
		await expect(merge.getByRole('alert')).toContainText('The agent could not resolve notes.md.');
		// The second file — in three columns: « takes theirs, Apply writes it and resolves it.
		await notesRow.getByRole('button', { name: 'Merge…', exact: true }).click();
		const view = page.locator('[data-merge-view="notes.md"]');
		await expect(view.locator('[data-merge-counter]')).toHaveText('1 of 1 conflict');
		await view
			.getByRole('button', { name: 'Take theirs into the result · 1', exact: true })
			.click();
		await view.getByRole('button', { name: 'Apply', exact: true }).click();
		await expect(view).toHaveCount(0);
		await expect.poll(async () => readFile(join(repo, 'notes.md'), 'utf8')).toBe('theirs note\n');
		await expect(notesRow).toContainText('Merged');
		await expect(finish).toBeEnabled();
		expect(await readFile(join(repo, 'total.ts'), 'utf8')).toContain('round(sum(items), 2)');
		await finish.click();
		await expect(merge).toHaveCount(0);
		await expect(
			commits.getByRole('button', { name: /Merge feature\/cart into main/ })
		).toBeVisible();
		expect(await git('log', '-1', '--format=%s')).toBe('Merge feature/cart into main');
		expect(await git('rev-list', '--count', '--merges', 'HEAD')).toBe('1');

		// Nothing new after the merge: the Merge button stays disabled.
		await panel.getByRole('button', { name: 'Merge…', exact: true }).click();
		await page.keyboard.type('feature');
		await page.keyboard.press('Enter');
		await expect(dialog.getByRole('status')).toContainText('Already up to date');
		await expect(dialog.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
		await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(dialog).toHaveCount(0);

		await views.getByRole('tab', { name: 'Diff', exact: true }).click();
		await expect(panel.getByRole('list', { name: 'Files', exact: true })).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = await app.firstWindow();
			await page.evaluate(async () => {
				for (const task of (await window.brigadir.readWorkspace()).tasks)
					await window.brigadir.sendCommand(task, { kind: 'shutdown' }).catch(() => {});
			});
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// spec/crew#accept: accepting a crew leaves a `merge --squash` conflict with no MERGE_HEAD; the merge band leads it to a plain commit with a generated message.
test('a crew squash conflict shows as a merge in progress and finishes as one commit with the generated message @area:diff', async () => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-squash-conflict-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		branch = 'main-developer-cart-rate-1';
	const git = async (...args: string[]) =>
		(await promisify(execFile)('git', args, { cwd: repo })).stdout.trim();
	await mkdir(repo);
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(
		join(repo, 'total.ts'),
		'export function total(items) {\n  return sum(items);\n}\n'
	);
	await writeFile(join(repo, 'notes.md'), 'one\n');
	await git('add', '.');
	await git('commit', '-m', 'feat: [Cart] seed');
	await git('checkout', '-b', branch);
	// A modify/delete conflict as well: the branch deletes notes.md, main changes it.
	await git('rm', '-q', 'notes.md');
	await writeFile(
		join(repo, 'total.ts'),
		'export function total(items) {\n  return sum(items) * rate;\n}\n'
	);
	await writeFile(join(repo, 'rates.ts'), 'export const rate = 1.2;\n');
	await git('add', '.');
	await git('commit', '-m', 'Developer: Apply rate');
	await git('checkout', 'main');
	await writeFile(
		join(repo, 'total.ts'),
		'export function total(items) {\n  return round(sum(items), 2);\n}\n'
	);
	await writeFile(join(repo, 'notes.md'), 'kept on main\n');
	await git('add', '.');
	await git('commit', '-m', 'fix: [Cart] round total');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const task = await page.evaluate(async () => {
			const task = await window.brigadir.createTask(
				'project',
				'Accept the cart part',
				'claude',
				'gui',
				false
			);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(async () =>
				(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
					(record) => record.event.kind === 'turn.completed'
				)
			)
			.toBe(true);
		// What accept_task leaves after a conflict: the squash in the tree, the message in SQUASH_MSG, the record in git-merge.json.
		const message =
			'feat: [Cart] apply the tax rate to the total\n\nThe total multiplies the sum by the rate.';
		expect(await squashBranch(repo, branch, message)).toMatchObject({
			merged: false,
			conflicts: ['notes.md', 'total.ts'],
		});
		const [scope] = await page.evaluate((task) => window.brigadir.readHistoryScopes(task), task);
		await writeFile(
			join(data, 'projects/project/tasks', task.id, 'git-merge.json'),
			JSON.stringify({
				schemaVersion: 1,
				merges: {
					[scope!.id]: {
						from: branch,
						into: 'main',
						conflicts: ['notes.md', 'total.ts'],
						agent: [],
					},
				},
			})
		);
		await page
			.locator('aside')
			.getByRole('button', { name: /Accept the cart part/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		await openPanelTab(page, 'changes');
		const panel = page.getByRole('complementary', { name: 'Changes', exact: true });
		await panel
			.getByRole('tablist', { name: 'Changes view', exact: true })
			.getByRole('tab', { name: 'History', exact: true })
			.click();
		// spec/appearance#evolution-redesign: the banner over the panel is the way in, in History as in Diff.
		const banner = panel.locator('[data-conflicts-banner="stopped"]');
		await expect(banner).toContainText('Merge stopped · 2 conflicts');
		await expect(banner).toContainText(`${branch} →main`);
		await banner.getByRole('button', { name: 'Resolve…', exact: true }).click();
		const merge = page.locator('[data-conflicts-dialog]');
		const finish = merge.getByRole('button', { name: 'Continue', exact: true });
		await expect(finish).toBeDisabled();
		// The deleted file is a conflict, not «resolved»: keep it or delete it.
		const notes = merge.locator('[data-conflict-row="notes.md"]');
		await expect(notes).toContainText(`deleted in ${branch}`);
		await expect(notes.getByRole('button', { name: 'Delete the file', exact: true })).toBeVisible();
		await notes.getByRole('button', { name: 'Keep the file', exact: true }).click();
		await expect(notes).toContainText('Kept');
		await merge
			.locator('[data-conflict-row="total.ts"]')
			.getByRole('button', { name: 'Accept theirs', exact: true })
			.click();
		await expect(finish).toBeEnabled();
		await finish.click();
		await expect(merge).toHaveCount(0);
		expect(await git('log', '-1', '--format=%B')).toBe(message);
		expect(await git('log', '-1', '--format=%P')).not.toContain(' ');
		expect(await git('rev-list', '--count', '--merges', 'HEAD')).toBe('0');
		expect(await readFile(join(repo, 'total.ts'), 'utf8')).toContain('sum(items) * rate');
		expect(await readFile(join(repo, 'notes.md'), 'utf8')).toBe('kept on main\n');
		expect(await git('status', '--porcelain')).toBe('');
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = await app.firstWindow();
			await page.evaluate(async () => {
				for (const task of (await window.brigadir.readWorkspace()).tasks)
					await window.brigadir.sendCommand(task, { kind: 'shutdown' }).catch(() => {});
			});
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/editor#line-author: the line author after the caret line, its card, and one file's history in the repo that owns the file.
test('line author and file history follow the Git root that owns the file @area:diff', async () => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-line-author-')),
		project = join(root, 'mono'),
		kit = join(project, 'kit'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	const git =
		(cwd: string) =>
		async (args: string[], env: Record<string, string> = {}) =>
			(
				await promisify(execFile)('git', args, { cwd, env: { ...process.env, ...env } })
			).stdout.trim();
	await mkdir(join(kit, 'src'), { recursive: true });
	await mkdir(dir, { recursive: true });
	for (const run of [git(project), git(kit)]) {
		await run(['init', '-q', '-b', 'main']);
		await run(['config', 'user.name', 'Fixture']);
		await run(['config', 'user.email', 'f@example.invalid']);
	}
	await writeFile(join(project, '.gitignore'), 'kit/\n');
	await git(project)(['add', '-A']);
	await git(project)(['commit', '-qm', 'root']);
	const commit = async (message: string, author: string, days: number) => {
		const date = new Date(Date.now() - days * day).toISOString();
		await git(kit)(['add', '-A']);
		await git(kit)(['-c', `user.name=${author}`, 'commit', '-qm', message], {
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date,
		});
	};
	await writeFile(join(kit, 'src/a.ts'), 'export const one = 1;\nexport const two = 2;\n');
	await commit('feat: first\n\nWhy the file exists.', 'Ada Lovelace', 580);
	await mkdir(join(kit, 'src/lib'));
	await git(kit)(['mv', 'src/a.ts', 'src/lib/a.ts']);
	await commit('chore: own folder', 'Olha Shevchenko', 40);
	await writeFile(join(kit, 'src/lib/a.ts'), 'export const one = 1;\nexport const two = 22;\n');
	await commit('fix: two', 'Olha Shevchenko', 3);
	await writeFile(
		join(kit, 'src/lib/a.ts'),
		'export const one = 1;\nexport const two = 22;\nexport const three = 3;\n'
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: { appearance: 'light', language: 'en', editor: { languageServers: false } },
		})
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'mono', path: project } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Line author',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	await app.evaluate(({ Menu }) => {
		const state = globalThis as any;
		Menu.prototype.popup = function (options) {
			state.menu = this;
			state.options = options;
		};
	});
	const menu = async () => {
		await expect.poll(() => app.evaluate(() => !!(globalThis as any).menu)).toBe(true);
		return app.evaluate(
			() =>
				(globalThis as any).menu.items.map((item: any) =>
					item.type === 'separator' ? '-' : `${item.label}${item.enabled ? '' : ' (off)'}`
				) as string[]
		);
	};
	const choose = (label: string) =>
		app.evaluate((_, label) => {
			const state = globalThis as any,
				item = state.menu.items.find((item: any) => item.label === label);
			item.click();
			state.options?.callback?.();
			state.menu = null;
		}, label);
	try {
		const page: Page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Line author/ }).click();
		await refreshChanges(page);
		await expect
			.poll(() =>
				page.evaluate(
					async () =>
						(await window.brigadir.readChanges({ projectId: 'project', id: 'task' })).checkpoint
				)
			)
			.not.toBeNull();
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree');
		for (const name of [/^kit\b/, /^src\b/, /^lib\b/]) {
			const item = tree.getByRole('treeitem', { name }).first();
			if ((await item.getAttribute('aria-expanded')) !== 'true') {
				await item.click();
				if ((await item.getAttribute('aria-expanded')) !== 'true') await item.press('ArrowRight');
			}
		}
		await tree.getByRole('treeitem', { name: 'a.ts', exact: true }).dblclick();
		const line = (text: string) => page.locator('.cm-line').filter({ hasText: text }).first(),
			tail = page.locator('.cm-line-author'),
			card = page.locator('[data-line-author-card]');
		// A committed line names its author from the kit repo's blame; the tail waits until the caret rests.
		await line('one').click({ position: { x: 20, y: 5 } });
		await page.keyboard.press('End');
		await expect(tail).toContainText('Ada Lovelace');
		await line('two').click({ position: { x: 20, y: 5 } });
		await page.keyboard.press('End');
		await expect(tail).toContainText('Olha Shevchenko');
		// spec/editor#line-author: changed on disk since the commit, then changed only in the buffer: no tail at all.
		await line('three').click({ position: { x: 20, y: 5 } });
		await page.keyboard.press('End');
		await page.waitForTimeout(600);
		await expect(tail).toHaveCount(0);
		await page.keyboard.type(';');
		await page.waitForTimeout(600);
		await expect(tail).toHaveCount(0);
		await page.keyboard.press('Backspace');
		// The card: subject, message, and the file's diff in that commit at the line.
		await line('two').click({ position: { x: 20, y: 5 } });
		await page.keyboard.press('End');
		await expect(tail).toContainText('Olha Shevchenko');
		await tail.hover();
		await expect(card).toContainText('fix: two');
		await card.getByRole('button', { name: 'Open commit', exact: true }).click();
		await expect(page.getByRole('tab', { name: /a\.ts/ }).filter({ hasText: '@' })).toBeVisible();
		// History narrowed to the file in its own repo (kit, not the root).
		await page.getByRole('tab', { name: 'kit/src/lib/a.ts', exact: true }).click();
		// Back on the tab the editor reads its blame again; until then both Git items are rightly off (spec/editor#line-author).
		// The tail on a committed line is the sign the blame is in.
		await line('one').click({ position: { x: 20, y: 5 } });
		await page.keyboard.press('End');
		await expect(tail).toContainText('Ada Lovelace');
		// On the text, not the middle of the line where the tail now sits.
		await line('one').click({ button: 'right', position: { x: 20, y: 5 } });
		const items = await menu();
		expect(items).toContain('File history');
		expect(items).toContain('Commit of this line');
		await choose('File history');
		const panel = page.getByRole('complementary', { name: 'Changes', exact: true });
		await expect(panel.getByRole('button', { name: 'Repo', exact: true })).toContainText('kit');
		const chip = panel.locator('[data-file-filter]');
		await expect(chip).toContainText('a.ts');
		// All three commits of the file, across its rename.
		for (const subject of ['fix: two', 'chore: own folder', 'feat: first'])
			await expect(panel.getByRole('listitem').filter({ hasText: subject })).toBeVisible();
		await expect(panel.getByText(/src\/a\.ts/)).toBeVisible();
		await panel
			.getByRole('listitem')
			.filter({ hasText: 'feat: first' })
			.getByRole('button')
			.click();
		await expect(
			page.getByRole('tab', { name: /a\.ts/ }).filter({ hasText: '@' }).first()
		).toBeVisible();
		await chip.getByRole('button', { name: 'Remove the file filter', exact: true }).click();
		await expect(chip).toHaveCount(0);
		await expect(
			panel.getByRole('listitem').filter({ hasText: 'chore: own folder' })
		).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
