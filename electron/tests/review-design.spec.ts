import { refreshChanges } from './refresh-changes';
import { openReview } from './open-review';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hideChat } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
test('review groups repositories and file routes, jumps to notes, and removes only confirmed versions @area:diff', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-review-design-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		taskDir = join(data, 'projects/project/tasks/task');
	await mkdir(join(repo, 'kit'), { recursive: true });
	await mkdir(taskDir, { recursive: true });
	const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });
	await git(repo, 'init', '-q');
	await git(join(repo, 'kit'), 'init', '-q');
	await writeFile(join(repo, 'Button.ts'), 'export const size = 1;\n');
	await writeFile(join(repo, 'kit/Button.ts'), 'export const color = 1;\n');
	await writeFile(
		join(repo, 'notes.ts'),
		Array.from({ length: 100 }, (_, i) => `// Note ${i + 1}`).join('\n')
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Review design fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'choice', path: repo } })
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
		}),
		key = { projectId: 'project', id: 'task' };
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Review design fixture/ }).click();
		// An empty review has no panel.
		await hideChat(page);
		await expect(page.locator('[data-review-footer]')).toHaveCount(0);
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'checkpoint' }), key);
		await writeFile(join(repo, 'Button.ts'), 'export const size = 2;\n');
		await writeFile(join(repo, 'kit/Button.ts'), 'export const color = 2;\n');
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'checkpoint' }), key);
		await page.evaluate(async (key) => {
			const changes = await window.brigadir.readChanges(key);
			for (const file of changes.files) {
				await window.brigadir.addComment(key, {
					fileId: file.id,
					side: 'new',
					start: 1,
					end: 1,
					text:
						file.scopeId === changes.scopes[0]!.id
							? 'Use the shared size token.'
							: 'Keep the color consistent in both themes.',
				});
				if (file.scopeId === changes.scopes[0]!.id)
					await window.brigadir.addComment(key, {
						fileId: file.id,
						side: 'new',
						start: 1,
						end: 1,
						text: 'Keep the keyboard focus visible.',
					});
			}
			const file = (await window.brigadir.listFiles(key, null)).entries.find(
					(file) => file.name === 'notes.ts'
				)!,
				doc = await window.brigadir.readEditorFile(key, file.id);
			await window.brigadir.addEditorComment(key, {
				fileId: file.id,
				version: doc.version,
				start: 80,
				end: 80,
				text: 'Clarify the keyboard behavior here.',
			});
			await window.brigadir.addReviewNote(key, 'Check both themes before finishing.');
		}, key);
		await writeFile(join(repo, 'Button.ts'), '// shifted\nexport const size = 2;\n');
		await writeFile(join(repo, 'kit/Button.ts'), 'export const contrast = 3;\n');
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'checkpoint' }), key);
		await refreshChanges(page);
		await openReview(page);
		const dialog = page.getByRole('dialog', { name: 'Review', exact: true }),
			deleteAll = dialog.getByRole('button', { name: 'Delete all', exact: true }),
			list = dialog.getByRole('log', { name: 'Review', exact: true });
		await expect(dialog.locator('header').first()).toContainText('5 comments · 3 files');
		await expect(list.getByRole('heading')).toHaveCount(2);
		await expect(list.getByRole('button', { name: 'Button.ts', exact: true })).toHaveCount(2);
		const notes = list
			.getByRole('article')
			.filter({ has: page.getByRole('button', { name: 'notes.ts', exact: true }) });
		await expect(notes).toContainText('Editor');
		await expect(notes.getByRole('status')).toHaveCount(0);
		await expect(list.locator('[data-outdated=true]')).not.toHaveCount(0);
		// No file editor opened; the chat's composer may stay beside the review (spec/task-window-workspace#empty-work-area).
		await expect(page.locator('.cm-editor:not([data-task-chat] .cm-editor)')).toHaveCount(0);
		await list.getByText('Show comments', { exact: true }).first().click();
		await expect(list).toContainText('Relocated');
		await list.getByText('Show comments', { exact: true }).first().click();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`review-${theme}.png`),
			});
		}
		const box = await dialog.boundingBox();
		expect(box?.y).toBe(48);
		expect(box?.width).toBe(620);
		expect(box!.height).toBeLessThanOrEqual(520);
		await expect(dialog.locator('[data-review-footer]')).toHaveCount(0);
		await list.getByRole('button', { name: 'notes.ts', exact: true }).click();
		await expect(page.getByRole('textbox', { name: 'File content' })).toBeVisible();
		await expect(
			page
				.locator('section')
				.filter({ has: page.getByRole('textbox', { name: 'File content' }) })
				.last()
				.locator(':scope > footer')
		).toContainText('80:1');
		await page.getByRole('button', { name: '5 comments · 3 files', exact: false }).click();
		const first = list.getByRole('button', { name: 'Button.ts', exact: true }).first();
		await first.focus();
		await first.press('ArrowDown');
		await expect(list.getByRole('button', { name: 'notes.ts', exact: true })).toBeFocused();
		await first.click();
		await expect(
			page.getByRole('log', { name: 'Diff', exact: true }).locator('[data-focused-row="true"]')
		).toContainText('Use the shared size token.');
		await openReview(page);
		await dialog
			.getByRole('button', { name: 'Remove file comments: Button.ts', exact: true })
			.first()
			.click();
		await expect(dialog.locator('header').first()).toContainText('3 comments · 2 files');
		const confirmation = page.getByRole('dialog', {
			name: 'Delete all review comments?',
			exact: true,
		});
		await app.evaluate(({ dialog }) => {
			(globalThis as any).nativeReviewConfirmations = 0;
			dialog.showMessageBox = async () => {
				(globalThis as any).nativeReviewConfirmations++;
				return { response: 0, checkboxChecked: false };
			};
		});
		await deleteAll.click();
		await expect(confirmation).toBeVisible();
		await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
		await expect(confirmation).toContainText('3 comments in 2 files');
		await expect(confirmation.getByRole('button', { name: 'Delete', exact: true })).toHaveAttribute(
			'data-appearance',
			'danger'
		);
		// The shared confirm (320) with the name, the warning sign and Esc in the header (rule 14).
		expect((await confirmation.boundingBox())!.width).toBe(320);
		await expect(confirmation.getByRole('button', { name: 'Close', exact: true })).toHaveText(
			'Esc'
		);
		await expect.poll(async () => Math.round((await confirmation.boundingBox())!.y)).toBe(150);
		expect(
			await confirmation.evaluate((node) =>
				getComputedStyle(node)
					.transitionDuration.split(',')
					.some((value) => parseFloat(value) > 0)
			)
		).toBe(true);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await confirmation.screenshot({
				animations: 'disabled',
				path: info.outputPath(`review-delete-${theme}.png`),
			});
		}
		await confirmation.press('Escape');
		await expect(confirmation).toHaveCount(0);
		await expect(deleteAll).toBeFocused();
		await expect(dialog.locator('header').first()).toContainText('3 comments · 2 files');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await deleteAll.click();
		expect(
			await confirmation.evaluate((node) =>
				getComputedStyle(node)
					.transitionDuration.split(',')
					.every((value) => parseFloat(value) === 0)
			)
		).toBe(true);
		await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(confirmation).toHaveCount(0);
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await dialog.press('Escape');
		await page.getByRole('textbox', { name: 'General note', exact: true }).fill('Initial draft');
		await openReview(page);
		await deleteAll.click();
		await page.evaluate(async (key) => {
			const review = await window.brigadir.readReview(key, null);
			await window.brigadir.editComment(
				key,
				review.notes![0]!.id,
				'Edited while confirmation was open.'
			);
			await window.brigadir.addReviewNote(key, 'Added while confirmation was open.');
		}, key);
		await expect(confirmation).toContainText('3 comments in 2 files');
		await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(confirmation.getByRole('alert')).toContainText('The review changed.');
		expect(
			await page.evaluate(async (key) => {
				const review = await window.brigadir.readReview(key, null);
				return review.comments.length + review.notes!.length;
			}, key)
		).toBe(4);
		await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(dialog.locator('header').first()).toContainText('4 comments · 2 files');
		await expect(dialog).toContainText('Edited while confirmation was open.');
		await deleteAll.click();
		await page.evaluate(
			(key) => window.brigadir.addReviewNote(key, 'Added after the new confirmation.'),
			key
		);
		await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(confirmation).toHaveCount(0);
		await expect(dialog.locator('header').first()).toContainText('1 comment · 0 files');
		await expect(dialog).toContainText('Added after the new confirmation.');
		await deleteAll.click();
		await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(confirmation).toHaveCount(0);
		await expect(dialog.locator('header').first()).toContainText('0 comments · 0 files');
		await expect(deleteAll).toHaveCount(0);
		await expect(dialog.getByRole('status')).toContainText('No review comments yet');
		await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveText('Esc');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await dialog.screenshot({
				animations: 'disabled',
				path: info.outputPath(`review-empty-${theme}.png`),
			});
		}
		await dialog.press('Escape');
		const footer = page.locator('[data-review-footer]'),
			footerDelete = footer.getByRole('button', { name: 'Delete all', exact: true }),
			footerNote = footer.getByRole('textbox', { name: 'General note', exact: true });
		await expect(footer).toHaveCount(0);
		await page.evaluate((key) => window.brigadir.addReviewNote(key, 'Saved note'), key);
		await expect(footer).toContainText('1 comment · 0 files');
		await expect(footerNote).toHaveValue('');
		await footerNote.fill('Draft to clear');
		await expect(footerDelete).toBeEnabled();
		await footerDelete.click();
		await expect(confirmation).toContainText(
			'1 comment will be deleted along with the general note.'
		);
		await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(confirmation).toHaveCount(0);
		await expect(footer).toHaveCount(0);
		expect(await app.evaluate(() => (globalThis as any).nativeReviewConfirmations)).toBe(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
