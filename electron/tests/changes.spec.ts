import { refreshChanges } from './refresh-changes';
import { selectCode } from './select-code';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPanelTab, showChat } from './layout';
const run = promisify(execFile);
const desktop = resolve('apps/desktop');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
test('host snapshots drive immutable diffs, explicit modes, draft parking and restart @area:diff @smoke', async ({}, info) => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-diff-ui-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(join(repo, 'example.ts'), 'export const count = 1;\n');
	await writeFile(
		join(repo, 'context.txt'),
		Array.from({ length: 100 }, (_, i) => `unchanged_${i}\n`).join('')
	);
	await git('add', '-A');
	await git('commit', '-qm', 'Baseline');
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
	try {
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		await page.getByRole('button', { name: 'Add a project…' }).click();
		await page.getByRole('button', { name: 'New task · repository' }).click();
		await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello');
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('log')).toContainText('world', { timeout: 20000 });
		key = await page.evaluate(async () => {
			const task = (await window.brigadir.readWorkspace()).tasks[0]!;
			return { projectId: task.projectId, id: task.id };
		});
		const index = await readFile(join(repo, '.git/index'));
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readSession(key), key!)).records.findLast(
						(record) => record.event.kind === 'turn.completed'
					)?.event
			)
			.toMatchObject({ reason: 'end_turn' });
		await page.evaluate(
			(key) => window.brigadir.sendCommand(key, { kind: 'prompt', text: 'hold' }),
			key
		);
		const longBefore = Array.from({ length: 50000 }, (_, i) => `before ${i}\n`).join('');
		await writeFile(
			join(repo, 'example.ts'),
			'export const count = 2;\nexport const label = "' + 'wide '.repeat(40) + '";\n'
		);
		await writeFile(
			join(repo, 'context.txt'),
			Array.from({ length: 100 }, (_, i) => (i === 70 ? 'changed_70\n' : `unchanged_${i}\n`)).join(
				''
			)
		);
		await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 2, 255]));
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'cancel' }), key);
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readSession(key), key!)).records.findLast(
						(record) => record.event.kind === 'turn.completed'
					)?.event
			)
			.toMatchObject({ reason: 'cancelled' });
		await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft');
		await refreshChanges(page);
		await openPanelTab(page, 'changes');
		await page.getByRole('tab', { name: 'Turns', exact: true }).click();
		await page
			.getByRole('list', { name: 'Turns', exact: true })
			.getByRole('button')
			.filter({ hasText: 'hello' })
			.click();
		await page.getByRole('tab', { name: 'Diff', exact: true }).click();
		await page.getByRole('button', { name: 'Diff options', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Base', exact: true })).toContainText('#0');
		await expect(page.getByRole('button', { name: 'End', exact: true })).toContainText('#0');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page
				.getByRole('dialog', { name: 'Diff options', exact: true })
				.screenshot({ animations: 'disabled', path: info.outputPath(`diff-options-${theme}.png`) });
		}
		await page.getByRole('button', { name: 'End', exact: true }).click();
		const checkpointMenu = page.getByRole('listbox', { name: 'End', exact: true });
		await checkpointMenu.screenshot({
			animations: 'disabled',
			path: info.outputPath('checkpoint-menu.png'),
		});
		await checkpointMenu.press('Escape');
		await expect(
			page
				.getByRole('list', { name: 'Files', exact: true })
				.getByRole('button', { name: /example.ts/ })
		).toHaveCount(0);
		await page
			.getByLabel('Checkpoints', { exact: true })
			.getByRole('button', { name: 'All changes', exact: true })
			.click();
		await page.getByRole('button', { name: 'Diff options', exact: true }).click();
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /example.ts/ })
			.click();
		const log = page.getByRole('log', { name: 'Diff', exact: true });
		await expect(log).toContainText('export const count = 2;');
		expect(await readFile(join(repo, '.git/index'))).toEqual(index);
		const why = log.getByRole('button', { name: 'Why did this change? · new:1', exact: true });
		await why.hover();
		await why.click();
		const explanation = page.getByRole('dialog', { name: 'Why did this change?', exact: true });
		await expect(explanation).toContainText('These lines');
		await expect(explanation).toContainText('During agent turn');
		await expect(explanation).toContainText('Turn 2');
		await expect(explanation).toContainText('hold');
		await expect(explanation.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(explanation).toHaveCount(0);
		await expect(why).toBeFocused();
		await why.press('Enter');
		await expect(explanation).toBeVisible();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await explanation.screenshot({
				animations: 'disabled',
				path: info.outputPath(`line-attribution-${theme}.png`),
			});
		}
		await explanation.getByRole('button', { name: 'Go to turn', exact: true }).first().click();
		await expect(
			page
				.getByRole('log', { name: 'Conversation', exact: true })
				.locator('[data-focused-row="true"]')
		).toContainText('hold');
		await page.getByRole('button', { name: 'Back to diff', exact: true }).click();
		await expect(log).toContainText('count = 2');
		// Exercise the actual native menu model without opening an OS menu over the developer's work.
		await app.evaluate(({ Menu }) => {
			const original = Menu.prototype.popup;
			Menu.prototype.popup = function (options) {
				Menu.prototype.popup = original;
				const why = this.items.find((item) => item.label === 'Why did this change?')!;
				why.click();
				options?.callback?.();
			};
		});
		await log.locator('[data-code-line="1"][data-side="new"]').click({ button: 'right' });
		await expect(explanation).toContainText('These lines');
		await explanation.getByRole('button', { name: 'Close', exact: true }).click();
		expect(
			await page.evaluate(async (key) => {
				const file = (await window.brigadir.readChanges(key)).files.find(
					(file) => file.path === 'example.ts'
				)!;
				try {
					await window.brigadir.readAttribution(key, file.id, { start: 0, end: 1 });
					return false;
				} catch {
					return true;
				}
			}, key)
		).toBe(true);

		await page.getByRole('radio', { name: 'Side by side', exact: true }).click();
		await expect(log.locator('[data-kind="removed"]')).toContainText('count = 1');
		// spec/chat#code-pills: lines wrap by default; the button turns it off and on.
		const wrap = page.getByRole('button', { name: 'Wrap lines', exact: true });
		await expect(wrap).toHaveAttribute('aria-pressed', 'true');
		await wrap.click();
		await expect(wrap).toHaveAttribute('aria-pressed', 'false');
		expect(await log.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
		await wrap.click();
		await expect(wrap).toHaveAttribute('aria-pressed', 'true');
		expect(await log.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('diff-light.png') });
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'dark';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('diff-dark.png') });
		await selectCode(log, 'new', 1);
		await page.getByRole('button', { name: 'Comment', exact: true }).click();
		await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Use a named constant');
		await expect(page.getByText('The draft has not been added.', { exact: true })).toBeVisible();
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('review-selection-dark.png'),
		});
		await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
		await expect(
			page.getByRole('article').filter({ hasText: 'Use a named constant' })
		).toBeVisible();
		expect(
			(await page.evaluate(async (key) => window.brigadir.readReview(key, null), key)).comments
		).toHaveLength(1);
		await page.screenshot({ animations: 'disabled', path: info.outputPath('review-dark.png') });
		await page.getByRole('button', { name: 'Send review', exact: true }).click();
		await expect(page.getByText('Sent', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Resolve', exact: true }).click();
		await expect(page.getByText('Resolved', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Reopen', exact: true }).click();
		await expect(page.getByText('Sent', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Edit comment', exact: true }).click();
		await page
			.getByRole('textbox', { name: 'Comment', exact: true })
			.fill('Keep the name descriptive');
		await page
			.locator('[data-comment-draft]')
			.getByRole('button', { name: 'Save', exact: true })
			.click();
		await expect(
			page.getByRole('article').filter({ hasText: 'Keep the name descriptive' })
		).toBeVisible();
		await showChat(page);
		await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
			'Keep this draft'
		);
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /binary.bin/ })
			.click();
		await expect(page.getByRole('paragraph').filter({ hasText: /^Binary file$/ })).toBeVisible();
		expect(
			await page.evaluate(async (key) => {
				try {
					await window.brigadir.readFileDiff(key, '../../etc/passwd');
					return false;
				} catch {
					return true;
				}
			}, key)
		).toBe(true);
		await writeFile(join(repo, 'large.txt'), longBefore);
		await refreshChanges(page);
		const started = Date.now();
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /large.txt/ })
			.click();
		const large = page.getByRole('log', { name: 'Diff', exact: true });
		await expect(large).toContainText('before 0');
		expect(Date.now() - started).toBeLessThan(3000);
		expect(await large.locator('[data-row-id]').count()).toBeLessThan(120);
		const frames = await large.evaluate(async (node) => {
			const gaps: number[] = [];
			let last = performance.now();
			for (let i = 0; i < 45; i++) {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				const now = performance.now();
				gaps.push(now - last);
				last = now;
				node.scrollTop = (node.scrollHeight * i) / 44;
			}
			return gaps.sort((a, b) => a - b);
		});
		await expect(large).toContainText('before 49999');
		expect(frames[Math.floor(frames.length * 0.95)]!).toBeLessThan(50);
		await info.attach('diff-performance.json', {
			body: JSON.stringify({
				rows: 50000,
				mounted: await large.locator('[data-row-id]').count(),
				p95FrameMs: frames[Math.floor(frames.length * 0.95)],
			}),
			contentType: 'application/json',
		});
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /context.txt/ })
			.click();
		await expect(log).toContainText('changed_70');
		await expect(log).not.toContainText('unchanged_10');
		const nativeDiff = async (label: string) =>
			app.evaluate(
				({ Menu }, label) =>
					Menu.getApplicationMenu()!
						.items.find((item) => item.label === 'Diff')!
						.submenu!.items.find((item) => item.label === label)!
						.click(),
				label
			);
		await page.getByRole('radio', { name: 'Unified', exact: true }).click();
		await nativeDiff('Toggle diff layout');
		await expect(page.getByRole('radio', { name: 'Side by side', exact: true })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await nativeDiff('Expand all context');
		await expect(log.getByRole('button', { name: /Show unchanged lines/ })).toHaveCount(0);
		await nativeDiff('Collapse all context');
		await expect(log.getByRole('button', { name: /Show unchanged lines/ }).first()).toBeVisible();
		await nativeDiff('Previous hunk');
		await expect(log.locator('[data-focused-row="true"]')).toContainText('changed_70');
		// spec/task-window-workspace#layout-switch: the chat and the diff are on screen together; Find goes to the surface with the focus.
		await log.focus();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'Editor')!
				.submenu!.items.find((item) => item.label === 'Find')!
				.click()
		);
		const find = page.getByRole('textbox', { name: 'Find in current panel' });
		await find.fill('unchanged_10');
		await expect(log.locator('[data-focused-row="true"]')).toContainText('unchanged_10');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('diff-find.png') });
		await find.press('Escape');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('diff-commands.png') });
		const hostPath = join(root, 'data/projects', key.projectId, 'tasks', key.id, 'host.json');
		const identity = JSON.parse(await readFile(hostPath, 'utf8'));
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page.locator('[data-sidebar-task]').filter({ hasText: 'hello' }).click();
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /example.ts/ })
			.click();
		await expect(page.getByRole('log', { name: 'Diff', exact: true })).toContainText('count = 2');
		await expect(
			page.getByRole('article').filter({ hasText: 'Keep the name descriptive' })
		).toBeVisible();
		expect(JSON.parse(await readFile(hostPath, 'utf8')).instance).toBe(identity.instance);
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
