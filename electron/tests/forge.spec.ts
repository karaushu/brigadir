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
test('GitHub dialogs review real pushes, keep PR drafts on failure and refresh checks without polling @area:pr', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-forge-ui-')),
		repo = join(root, 'repo'),
		remote = join(root, 'remote.git'),
		data = join(root, 'data'),
		fixture = resolve('packages/transport/fixtures/agent.mjs'),
		stateFile = join(root, 'gh.json');
	await mkdir(repo);
	await mkdir(remote);
	const git = async (...args: string[]) =>
		(await promisify(execFile)('git', args, { cwd: repo })).stdout.trim();
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file.txt'), 'base\n');
	await git('add', '.');
	await git('commit', '-m', 'Baseline');
	await promisify(execFile)('git', ['init', '--bare', '-b', 'main'], { cwd: remote });
	await git('remote', 'add', 'origin', remote);
	await git('push', '-u', 'origin', 'main');
	await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
	await git('switch', '-c', 'brigadir/a3f2c1d9');
	await writeFile(join(repo, 'file.txt'), 'feature\n');
	await git('commit', '-am', 'Implement the feature');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	await writeFile(
		stateFile,
		JSON.stringify({
			prs: [],
			createError: true,
			checks: [
				{ name: 'build', bucket: 'pass', link: '' },
				{ name: 'unit tests', bucket: 'fail', link: '' },
				{ name: 'lint', bucket: 'pending', link: '' },
			],
		})
	);
	const changeState = async (update: object) => {
		await writeFile(
			stateFile,
			JSON.stringify({ ...JSON.parse(await readFile(stateFile, 'utf8')), ...update })
		);
	};
	const calls = async () => (await readFile(`${stateFile}.log`, 'utf8')).trim().split('\n');
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const launch = () =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: {
				...env,
				BRIGADIR_DATA_DIR: data,
				BRIGADIR_TEST_AGENT: fixture,
				BRIGADIR_TEST_GH: resolve('packages/forge/fixtures/gh.mjs'),
				BRIGADIR_TEST_GH_STATE: stateFile,
			},
		});
	let app = await launch();
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const task = await page.evaluate(async () => {
			const task = await window.brigadir.createTask(
				'project',
				'Publish fixture feature',
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
			.getByRole('button', { name: /Publish fixture feature/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		await openPanelTab(page, 'changes');
		// spec/task-window#repo-line: the repo is a root of Changes; its GitHub actions are in the root's «…», its open PR a mark on it.
		const scope = page
				.getByRole('complementary', { name: 'Changes', exact: true })
				.locator('[data-repo-root]')
				.first(),
			more = scope.getByRole('button', { name: 'Repo actions · repo', exact: true }),
			menu = page.getByRole('menu', { name: 'Repo actions · repo', exact: true }),
			create = menu.getByRole('menuitem', { name: 'Create PR…', exact: true }),
			checks = menu.getByRole('menuitem', { name: /^Checks…/ });
		const openMenu = async () => {
			await more.click();
			await expect(menu).toHaveAttribute('data-open', 'true');
		};
		await openMenu();
		await expect(create).toBeEnabled();
		await create.click();
		let dialog = page.getByRole('dialog', { name: 'New pull request', exact: true });
		await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
			'Publish fixture feature'
		);
		await expect(dialog).toHaveCSS('width', '580px');
		// spec/pull-requests-and-ci#ci-segment: Description and Generate are a row of S.
		await expect(dialog.getByRole('button', { name: 'Generate', exact: true })).toHaveCSS(
			'height',
			'24px'
		);
		await dialog.getByRole('textbox', { name: 'Branch', exact: false }).fill('feature/reviewed');
		await app.evaluate(() => {
			process.env.BRIGADIR_TEST_AGENT = '/missing/fixture.mjs';
		});
		await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
		await expect(dialog).toContainText('Could not generate the description');
		await dialog
			.getByRole('textbox', { name: 'Title', exact: true })
			.fill('Reviewed fixture title');
		await dialog
			.getByRole('textbox', { name: 'Description', exact: true })
			.fill('Reviewed body\n\nTesting in a local fixture.');
		const disclosure = dialog.getByRole('button', { name: 'Commits to push', exact: true });
		const heights = await disclosure.evaluate(async (button) => {
			const reveal = button.nextElementSibling!,
				values: number[] = [];
			(button as HTMLButtonElement).click();
			for (let i = 0; i < 24; i++) {
				await new Promise(requestAnimationFrame);
				values.push(reveal.getBoundingClientRect().height);
			}
			return values;
		});
		expect(heights.some((height) => height > 1 && height < heights.at(-1)! - 1)).toBe(true);
		await expect(dialog).toContainText('Implement the feature');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({ animations: 'disabled', path: info.outputPath(`pr-${theme}.png`) });
		}
		await dialog.getByRole('button', { name: 'Create PR', exact: true }).click();
		await expect(dialog.getByRole('alert')).toContainText('Fixture PR creation failed');
		await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
			'Reviewed fixture title'
		);
		expect(await git('branch', '--show-current')).toBe('feature/reviewed');
		expect(
			(
				await promisify(execFile)('git', ['rev-parse', 'refs/heads/feature/reviewed'], {
					cwd: remote,
				})
			).stdout.trim()
		).toBe(await git('rev-parse', 'HEAD'));
		await changeState({ createError: false });
		await dialog.getByRole('button', { name: 'Create PR', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		const badge = page.locator('[data-repo-chip] [data-repo-pr]');
		await expect(scope.locator('[data-repo-pr]')).toBeVisible();
		const saved = JSON.parse(
			await readFile(join(data, 'projects/project/tasks', task.id, 'task.json'), 'utf8')
		);
		expect(JSON.stringify(saved)).toContain('https://github.com/fixture/repo/pull/12');
		await openMenu();
		await checks.click();
		dialog = page.getByRole('dialog', { name: 'Checks', exact: true });
		await expect(dialog).toContainText('unit tests');
		await expect(dialog).toHaveCSS('width', '400px');
		await expect(dialog).toContainText('1 failed');
		// spec/pull-requests-and-ci#ci-segment: the check's name stands right after its glyph, not in the middle of the row.
		expect(
			(await dialog.getByText('unit tests', { exact: true }).boundingBox())!.x -
				(await dialog.boundingBox())!.x
		).toBeLessThan(48);
		await expect(badge).toHaveText('#12');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`checks-${theme}.png`),
			});
		}
		await changeState({ checksError: true });
		await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(dialog.getByRole('alert')).toContainText('Fixture GitHub network error');
		await expect(dialog.getByText('No checks', { exact: true })).toHaveCount(0);
		await changeState({ checksError: false, noChecks: true });
		await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(dialog.getByText('No checks', { exact: true })).toBeVisible();
		/* No empty list or counts under «No checks». */ expect(
			await dialog.evaluate(
				(node) =>
					[...node.children].filter(
						(child) => child.tagName === 'DIV' && !child.textContent?.trim()
					).length
			)
		).toBe(0);
		await expect(dialog.locator('footer button')).toHaveText([
			'Refresh',
			'Open on GitHub',
			'Open PR',
		]);
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		// The menu row leaves with the menu: focus goes back to the «…» it was opened from.
		await expect(more).toBeFocused();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await openMenu();
		await checks.click();
		dialog = page.getByRole('dialog', { name: 'Checks', exact: true });
		await expect(dialog).toBeVisible();
		expect(
			await dialog.evaluate((node) =>
				getComputedStyle(node)
					.transitionDuration.split(',')
					.every((value) => value.trim() === '0s')
			)
		).toBe(true);
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		// spec/pull-requests-and-ci#task-pr-badge: «Open PR» opens the PR in the task's PR panel and closes the popup.
		await openMenu();
		await checks.click();
		dialog = page.getByRole('dialog', { name: 'Checks', exact: true });
		await dialog.getByRole('button', { name: 'Open PR', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('[data-pr-panel]').first()).toBeVisible();
		await page.evaluate(() => window.brigadir.dispatchWorkspaceAction('diff'));
		await expect(scope.locator('[data-repo-pr]')).toBeVisible();
		await openMenu();
		const opacities = await checks.evaluate(async (button) => {
			(button as HTMLButtonElement).click();
			const values: number[] = [];
			for (let i = 0; i < 6; i++) {
				await new Promise(requestAnimationFrame);
				const dialog = document.querySelector('dialog[open]');
				if (dialog) values.push(Number(getComputedStyle(dialog).opacity));
			}
			return values;
		});
		expect(opacities.some((value) => value > 0 && value < 1)).toBe(true);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(more).toBeFocused();
		// Checkpoints refresh local Git only; no remote polling after the read settles.
		await page.waitForTimeout(2300);
		const before = (await calls()).length;
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }), task);
		await page.waitForTimeout(2500);
		expect((await calls()).length).toBe(before);
		await writeFile(join(repo, 'file.txt'), 'follow-up\n');
		await git('commit', '-am', 'Follow-up commit');
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }), task);
		const push = scope.getByRole('button', { name: /Push commits/ });
		await expect(push).toHaveText('↑1');
		await push.click();
		dialog = page.getByRole('dialog', { name: 'Push commits', exact: true });
		await expect(dialog).toContainText('Follow-up commit');
		await expect(dialog).toContainText('This push updates PR');
		await git('remote', 'set-url', 'origin', join(root, 'changed.git'));
		await dialog.getByRole('button', { name: 'Push', exact: true }).click();
		await expect(dialog.getByRole('alert')).toContainText('branch or remote changed');
		await git('remote', 'set-url', 'origin', remote);
		await dialog.getByRole('button', { name: 'Push', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(push).toHaveCount(0);
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'shutdown' }), task);
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).connected
			)
			.toBe(false);
		const state = JSON.parse(await readFile(stateFile, 'utf8'));
		await changeState({ prs: state.prs.map((pr: object) => ({ ...pr, state: 'MERGED' })) });
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(page.locator('[data-repo-pr]')).toHaveCount(0);
		expect(
			await readFile(join(data, 'projects/project/tasks', task.id, 'task.json'), 'utf8')
		).toContain('MERGED');
		await openMenu();
		await expect(create).toBeEnabled();
		await page.keyboard.press('Escape');
		await expect(menu).toHaveCount(0);
		await changeState({ auth: 'login' });
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(
			page.getByText('Sign in with gh auth login to use GitHub.', { exact: true })
		).toHaveCount(1);
		await changeState({ auth: 'ready' });
		await git('switch', 'main');
		await writeFile(join(repo, 'file.txt'), 'new work on main\n');
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await openMenu();
		// The reason stands under the row (spec/editor-code-intelligence#definition-and-usages); it does not disable it (spec/pull-requests-and-ci#from-into): the dialog picks another pair.
		await expect(menu).toContainText('No commits ahead of base');
		await expect(create).toBeEnabled();
		await expect(menu.getByRole('menuitem', { name: 'Create branch…', exact: true })).toHaveCount(
			0
		);
		await page.keyboard.press('Escape');
		await expect(menu).toHaveCount(0);
		await git('commit', '-am', 'Commit from main');
		const reviewed = await git('rev-parse', 'HEAD');
		await writeFile(join(repo, 'file.txt'), 'local changes stay here\n');
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await openMenu();
		await expect(create).toBeEnabled();
		await expect(create.locator('svg[data-glyph="pr-branch"]')).toHaveCount(1);
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('create-pr-main-dark.png'),
		});
		await create.click();
		dialog = page.getByRole('dialog', { name: 'New pull request', exact: true });
		await expect(dialog).toContainText('A branch will be created automatically.');
		await expect(dialog).toContainText('Uncommitted changes stay local');
		await expect(dialog.getByRole('textbox', { name: 'Branch', exact: true })).toHaveCount(0);
		expect(await git('branch', '--show-current')).toBe('main');
		await dialog.press('Escape');
		expect(await git('branch', '--show-current')).toBe('main');
		await openMenu();
		await create.click();
		await expect(dialog.getByRole('button', { name: 'Create PR', exact: true })).toBeEnabled();
		await dialog.screenshot({
			animations: 'disabled',
			path: info.outputPath('automatic-pr-dark.png'),
		});
		await dialog.getByRole('button', { name: 'Create PR', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		const automatic = await git('branch', '--show-current');
		expect(automatic).toMatch(/^brigadir\/publish-fixture-feature-[a-f0-9]{8}$/);
		expect(await git('rev-parse', 'main')).toBe(reviewed);
		expect(
			(
				await promisify(execFile)('git', ['rev-parse', `refs/heads/${automatic}`], { cwd: remote })
			).stdout.trim()
		).toBe(reviewed);
		expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('local changes stay here\n');
		await expect(scope.locator('[data-repo-pr]')).toBeVisible();
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('scope-actions-dark.png'),
		});
		const published = JSON.parse(await readFile(stateFile, 'utf8'));
		await changeState({ prs: published.prs.map((pr: object) => ({ ...pr, state: 'MERGED' })) });
		expect(errors).toEqual([]);
		await app.close();
		await writeFile(
			join(data, 'settings.json'),
			JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'uk' } })
		);
		app = await launch();
		const ukrainian = await app.firstWindow();
		await ukrainian
			.locator('aside')
			.getByRole('button', { name: /Publish fixture feature/ })
			.filter({ has: ukrainian.locator('[class*=taskCopy]') })
			.click();
		await openPanelTab(ukrainian, 'changes');
		await ukrainian
			.getByRole('complementary', { name: 'Зміни', exact: true })
			.locator('[data-repo-root]')
			.first()
			.getByRole('button', { name: 'Дії repo · repo', exact: true })
			.click();
		const createUk = ukrainian
			.getByRole('menu', { name: 'Дії repo · repo', exact: true })
			.getByRole('menuitem', { name: 'Створити PR…', exact: true });
		await expect(createUk).toBeEnabled();
		await createUk.click();
		const sheet = ukrainian.getByRole('dialog', { name: 'Новий PR', exact: true });
		await expect(sheet.getByRole('textbox', { name: 'Заголовок', exact: true })).toBeVisible();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(ukrainian.locator('html')).toHaveAttribute('data-theme', theme);
			await ukrainian.screenshot({
				animations: 'disabled',
				path: info.outputPath(`pr-uk-${theme}.png`),
			});
		}
		await ukrainian.keyboard.press('Escape');
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
