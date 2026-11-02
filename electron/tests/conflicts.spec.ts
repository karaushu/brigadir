import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPanelTab } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;

const base = [
	"import { api } from './client';",
	"import type { Printer } from '../types';",
	'',
	'export async function listPrinters(id: string) {',
	'  const r = await api.get(`/c/${id}/printers`);',
	'  return r.data.items as Printer[];',
	'}',
	'',
	'export function testPrinter(p: string) {',
	'  return api.post(`/printers/${p}/test`);',
	'}',
	'',
].join('\n');

// spec/appearance#evolution-redesign, spec/git#conflicts: a merge stopped in the terminal shows as the banner in Changes; the Conflicts dialog takes a
// side, keeps a file deleted on the other side, merges one file in three columns (» and Accept both, Apply), brings a file
// back to the conflict and commits the merge with Continue.
test('a merge stopped with conflicts walks the Conflicts dialog and the three columns to the merge commit @area:diff', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-conflicts-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		branch = 'brigadir/experimental-printer-method';
	const git = async (...args: string[]) =>
		(await promisify(execFile)('git', args, { cwd: repo })).stdout.trim();
	await mkdir(join(repo, 'src/api'), { recursive: true });
	await git('init', '-b', branch);
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'src/api/Printers.ts'), base);
	await writeFile(join(repo, 'notes.md'), 'base note\n');
	await writeFile(join(repo, 'gone.ts'), 'export const gone = 1;\n');
	await git('add', '.');
	await git('commit', '-m', 'Seed');
	await git('checkout', '-b', 'stage');
	await writeFile(
		join(repo, 'src/api/Printers.ts'),
		base
			.replace("import { api } from './client';", "import { http } from './http';")
			.replace('await api.get(', 'await http.get(')
			.replace('return api.post(', 'return http.post(')
	);
	await writeFile(join(repo, 'notes.md'), 'theirs note\n');
	await git('rm', '-q', 'gone.ts');
	await git('add', '.');
	await git('commit', '-m', 'Move to the http client');
	await git('checkout', branch);
	await writeFile(
		join(repo, 'src/api/Printers.ts'),
		base
			.replace("import { api } from './client';", "import { api, rawApi } from './client';")
			.replace(
				"import type { Printer } from '../types';",
				"import type { Printer } from '../types';\nimport type { PrintMethod } from '../types';"
			)
			.replace('/printers`);', '/printers?raw`);')
	);
	await writeFile(join(repo, 'notes.md'), 'ours note\n');
	await writeFile(join(repo, 'gone.ts'), 'export const gone = 2;\n');
	await git('add', '.');
	await git('commit', '-m', 'Raw printers');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'business', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
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
				'Merge stage',
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
		// The merge stops in the terminal, not in the app: the banner reads the state from git.
		await git('merge', 'stage').catch(() => {});
		expect(await git('diff', '--name-only', '--diff-filter=U')).toBe(
			'gone.ts\nnotes.md\nsrc/api/Printers.ts'
		);
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }), task);
		await page
			.locator('aside')
			.getByRole('button', { name: /Merge stage/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		await openPanelTab(page, 'changes');
		const banner = page.locator('[data-conflicts-banner="stopped"]');
		await expect(banner).toContainText('Merge stopped · 3 conflicts', { timeout: 20000 });
		await expect(banner).toContainText(`stage →${branch}`);
		// The commit steps aside for the banner (the row keeps the snapshot picker alone, spec/git#commit-dialog), without a
		// toast about the commit list.
		const commitRow = page.getByRole('region', { name: 'Commit', exact: true });
		await expect(commitRow.getByRole('button', { name: /Commit changes/ })).toHaveCount(0);
		const toasts = page.locator('[data-toast-region]');
		await banner.getByRole('button', { name: 'Resolve…', exact: true }).click();

		const dialog = page.locator('[data-conflicts-dialog]');
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('heading')).toContainText(
			`business·Merging stage into ${branch}`
		);
		const row = (path: string) => dialog.locator(`[data-conflict-row="${path}"]`);
		await expect(row('src/api/Printers.ts')).toContainText('2 conflicts');
		await expect(row('gone.ts')).toContainText('deleted in stage');
		const progress = dialog.locator('[data-conflicts-progress]');
		await expect(progress).toHaveText('0 of 3 resolved');
		const resume = dialog.getByRole('button', { name: 'Continue', exact: true });
		await expect(resume).toBeDisabled();
		await expect(resume).toHaveAttribute('title', 'Resolve all conflicts first.');
		await page.screenshot({ path: info.outputPath('conflicts-light.png') });
		const appearance = await page.evaluate(() => window.brigadir.readAppearance());
		const dark = (on: boolean) =>
			app.evaluate(
				({ BrowserWindow }, value) =>
					BrowserWindow.getAllWindows()[0]!.webContents.send('appearance:changed', value),
				{ ...appearance, dark: on }
			);
		await dark(true);
		await page.screenshot({ path: info.outputPath('conflicts-dark.png') });
		await dark(false);

		// A side for a whole file; the file deleted on the other side is kept.
		await row('notes.md').getByRole('button', { name: 'Accept theirs', exact: true }).click();
		await expect(row('notes.md')).toContainText('Theirs');
		await row('gone.ts').getByRole('button', { name: 'Keep the file', exact: true }).click();
		await expect(row('gone.ts')).toContainText('Kept');
		await expect(progress).toHaveText('2 of 3 resolved');

		// Merge…: three columns, the base with the conflicts in the Result, non-conflicting changes already in.
		await row('src/api/Printers.ts').getByRole('button', { name: 'Merge…', exact: true }).click();
		const view = page.locator('[data-merge-view="src/api/Printers.ts"]');
		await expect(view).toBeVisible();
		const counter = view.locator('[data-merge-counter]');
		await expect(counter).toHaveText('1 of 2 conflicts');
		await expect(view.locator('[data-merge-progress]')).toHaveText(
			'2 conflicts left · 2 changes applied'
		);
		const apply = view.getByRole('button', { name: 'Apply', exact: true });
		await expect(apply).toBeDisabled();
		const result = view.getByRole('textbox', { name: 'Result' });
		await expect(result).toContainText("import type { PrintMethod } from '../types';");
		await expect(result).toContainText('return http.post(`/printers/${p}/test`);');
		await expect(result).toContainText("import { api } from './client';");
		await page.screenshot({ path: info.outputPath('merge-view-light.png') });
		await dark(true);
		await page.screenshot({ path: info.outputPath('merge-view-dark.png') });
		await dark(false);
		// A narrow window: Yours / Theirs become tabs over the Result.
		const size = await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.getSize()
		);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(860, 760));
		await expect(view.getByRole('radiogroup', { name: 'Yours / Theirs' })).toBeVisible();
		await page.screenshot({ path: info.outputPath('merge-view-narrow.png') });
		await app.evaluate(
			({ BrowserWindow }, [width, height]) =>
				BrowserWindow.getAllWindows()[0]!.setSize(width!, height!),
			size
		);
		await expect(view.getByRole('radiogroup', { name: 'Yours / Theirs' })).toHaveCount(0);
		// » takes yours into the first conflict; the cursor moves to the second, where Accept both takes yours, then theirs.
		await view.getByRole('button', { name: 'Take yours into the result · 1', exact: true }).click();
		await expect(result).toContainText("import { api, rawApi } from './client';");
		await expect(counter).toHaveText('2 of 2 conflicts');
		await view.getByRole('button', { name: 'Accept both', exact: true }).click();
		await expect(counter).toHaveText('All 2 resolved');
		await page.screenshot({ path: info.outputPath('merge-view-resolved.png') });
		await expect(apply).toBeEnabled();
		await apply.click();
		await expect(view).toHaveCount(0);
		await expect(row('src/api/Printers.ts')).toContainText('Merged');
		expect(await readFile(join(repo, 'src/api/Printers.ts'), 'utf8')).toBe(
			base
				.replace("import { api } from './client';", "import { api, rawApi } from './client';")
				.replace(
					"import type { Printer } from '../types';",
					"import type { Printer } from '../types';\nimport type { PrintMethod } from '../types';"
				)
				.replace(
					'  const r = await api.get(`/c/${id}/printers`);',
					'  const r = await api.get(`/c/${id}/printers?raw`);\n  const r = await http.get(`/c/${id}/printers`);'
				)
				.replace('return api.post(', 'return http.post(')
		);

		// Back to the conflict: the markers and the stages come back; then yours.
		await expect(resume).toBeEnabled();
		await row('notes.md').hover();
		await row('notes.md')
			.getByRole('button', { name: 'Back to the conflict', exact: true })
			.click();
		await expect(row('notes.md')).toContainText('1 conflict');
		await expect(resume).toBeDisabled();
		expect(await readFile(join(repo, 'notes.md'), 'utf8')).toContain('<<<<<<<');
		await row('notes.md').getByRole('button', { name: 'Accept yours', exact: true }).click();
		await expect(row('notes.md')).toContainText('Yours');
		await expect(progress).toHaveText('All 3 resolved');

		// Continue commits the merge; the banner goes.
		await resume.click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByText(`Merged stage into ${branch}.`)).toBeVisible();
		expect(await git('log', '-1', '--format=%P')).toContain(' ');
		expect(await readFile(join(repo, 'notes.md'), 'utf8')).toBe('ours note\n');
		expect(await readFile(join(repo, 'gone.ts'), 'utf8')).toBe('export const gone = 2;\n');
		expect(await git('status', '--porcelain')).toBe('');
		await expect(banner).toHaveCount(0);
		await expect(toasts).not.toContainText('Could not load the changes to commit');
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
