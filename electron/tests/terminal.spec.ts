import { _electron as electron, expect, test } from '@playwright/test';
import { editorText } from './editor-text';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hideWorkArea, showWorkArea } from './layout';
import { openMainTree } from './repos';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
/** A project «repo» in `root/repo` with one finished task titled `title` (none when `title` is null). */
async function fixture(prefix: string, title: string | null, git = false) {
	const root = await mkdtemp(join(tmpdir(), `brigadir-${prefix}-`)),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(repo, { recursive: true });
	await mkdir(title === null ? join(data, 'projects/project') : dir, { recursive: true });
	if (git) await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	if (title !== null)
		await writeFile(
			join(dir, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: { id: 'task', projectId: 'project', title, status: 'done', provider: 'claude' },
			})
		);
	return { root, repo, data, dir };
}
const launch = (
	root: string,
	data: string,
	extra: Record<string, string> = {},
	args: string[] = []
) =>
	electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`, ...args],
		env: { ...env, BRIGADIR_DATA_DIR: data, ...extra },
	});
const shell = (root: string) => ({ HOME: root, ZDOTDIR: root, SHELL: '/bin/zsh' });
test('console opens without an agent, parks output and closes its real PTY @area:browser', async ({}, info) => {
	const { root, data } = await fixture('terminal-ui', 'Terminal fixture');
	const app = await launch(root, data, {
		...shell(root),
		BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
	});
	const key = { projectId: 'project', id: 'task' };
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Terminal fixture/ }).click();
		// spec/task-window-workspace#work-area: ⇧⌘Y opens a terminal tab in the work area when the task has none.
		const viewItem = (label: string) =>
			app.evaluate(
				({ Menu }, label) =>
					Menu.getApplicationMenu()!
						.items.find((item) => item.label === 'View')!
						.submenu!.items.find((item) => item.label === label)!
						.click(),
				label
			);
		await viewItem('Terminal');
		await expect(page.locator('.xterm')).toHaveCount(1);
		const input = page.locator('.xterm-helper-textarea');
		await input.focus();
		await input.fill(
			"printf 'VISIBLE_PTY\\n'; if [[ -z ${NO_COLOR+x} && -z ${FORCE_COLOR+x} ]]; then printf '\\033[31mANSI red\\033[0m  \\033[38;2;40;160;220mTruecolor blue\\033[0m\\n'; fi"
		);
		await input.press('Enter');
		const id = await expect
			.poll(async () => {
				const items = (await page.evaluate(
					(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
					key
				)) as { id: string }[];
				return items[0]?.id;
			})
			.not.toBeUndefined();
		const terminalId = (
			(await page.evaluate(
				(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
				key
			)) as { id: string }[]
		)[0]!.id;
		await expect
			.poll(() =>
				page.evaluate(({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'text', id }), {
					key,
					id: terminalId,
				})
			)
			.toContain('VISIBLE_PTY');
		await expect
			.poll(async () => {
				const snapshot = (await page.evaluate(
					({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'read', id }),
					{ key, id: terminalId }
				)) as { data: string };
				return snapshot.data;
			})
			.toContain('\x1b[31mANSI red');
		for (const theme of ['dark', 'light'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page
				.locator('section[data-role="console"]')
				.first()
				.screenshot({
					animations: 'disabled',
					path: info.outputPath(`terminal-colors-${theme}.png`),
				});
		}
		expect(
			(await page.evaluate((key) => window.brigadir.readSession(key), key)).records.some(
				(r) => r.event.kind === 'session.started'
			)
		).toBe(false);
		// spec/task-window-workspace#layout-switch: the work area hides with its terminal tab and brings it back with its output.
		await hideWorkArea(page);
		await expect(page.locator('.xterm')).toHaveCount(0);
		await showWorkArea(page);
		await expect(page.locator('.xterm')).toHaveCount(1);
		await expect
			.poll(() =>
				page.evaluate(({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'text', id }), {
					key,
					id: terminalId,
				})
			)
			.toContain('VISIBLE_PTY');
		await input.focus();
		await input.fill("for i in {1..100}; do printf 'SCROLL_%03d\\n' $i; done");
		await input.press('Enter');
		await expect
			.poll(() =>
				page.evaluate(({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'text', id }), {
					key,
					id: terminalId,
				})
			)
			.toContain('SCROLL_100');
		const viewport = page.locator('.xterm-scrollable-element');
		const slider = viewport.locator('.scrollbar.vertical .slider');
		await expect
			.poll(() => slider.evaluate((node) => parseFloat((node as HTMLElement).style.top)))
			.toBeGreaterThan(50);
		const bottom = await slider.evaluate((node) => parseFloat((node as HTMLElement).style.top));
		await viewport.hover();
		for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -600);
		await expect
			.poll(() => slider.evaluate((node) => parseFloat((node as HTMLElement).style.top)))
			.toBeLessThan(bottom - 20);
		const scrollTop = await slider.evaluate((node) => parseFloat((node as HTMLElement).style.top));
		await hideWorkArea(page);
		await expect(page.locator('.xterm')).toHaveCount(0);
		await showWorkArea(page);
		await expect
			.poll(() =>
				slider.evaluate(
					(node, previous) => Math.abs(parseFloat((node as HTMLElement).style.top) - previous),
					scrollTop
				)
			)
			.toBeLessThan(5);
		await input.focus();
		await input.fill("printf 'BUILD_FAILURE\\n'; (exit 7)");
		await input.press('Enter');
		await expect(page.getByRole('status').filter({ hasText: 'Exit 7' })).toBeVisible();
		await page.getByRole('status').getByRole('button', { name: 'Show the agent' }).click();
		// spec/composer#mentions: the output stands in the composer text as a pill, not on a shelf.
		const message = page.getByRole('textbox', { name: 'Message', exact: true }),
			pill = message.locator('[data-mention-pill]').filter({ hasText: 'Terminal output' });
		await expect(pill).toBeVisible();
		await pill.click();
		const preview = page.getByRole('dialog', { name: 'Terminal output' });
		await expect(preview).toContainText('BUILD_FAILURE');
		await expect(preview).not.toContainText('VISIBLE_PTY');
		await preview.getByRole('button', { name: 'Close', exact: true }).click();
		expect(await editorText(message)).not.toContain('BUILD_FAILURE');
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
		await page.getByRole('button', { name: 'Send', exact: true }).click();
		await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('hello world');
		await expect(page.locator('form').getByLabel('Attachments', { exact: true })).toHaveCount(0);
		await page
			.getByRole('log', { name: 'Conversation' })
			.getByRole('button', { name: 'Terminal output', exact: true })
			.click();
		await expect(preview).toContainText('BUILD_FAILURE');
		await preview.getByRole('button', { name: 'Close', exact: true }).click();
		await page.screenshot({ animations: 'disabled', path: info.outputPath('console-light.png') });
		await message.focus();
		const screen = await page.locator('.xterm-screen').elementHandle();
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'dark';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await expect(message).toBeFocused();
		expect(await screen!.evaluate((node) => node.isConnected)).toBe(true);
		await page.screenshot({ animations: 'disabled', path: info.outputPath('console-dark.png') });
		// A second terminal from Tools: two tabs of the group, each with its ×.
		await page.locator('[data-tools-button]').click();
		await page.getByRole('menuitem', { name: /New terminal/ }).click();
		const closeTerminal = page.getByRole('button', { name: /^Close terminal/ });
		await expect(closeTerminal).toHaveCount(2);
		await expect
			.poll(
				async () =>
					(
						(await page.evaluate(
							(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
							key
						)) as { id: string }[]
					).length
			)
			.toBe(2);
		await page.getByRole('tab', { name: 'repo', exact: true }).first().click();
		await expect
			.poll(() =>
				page.evaluate(({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'text', id }), {
					key,
					id: terminalId,
				})
			)
			.toContain('BUILD_FAILURE');
		// spec/task-window-workspace#terminal-close: × asks only while the shell runs a command.
		await page.getByRole('tab', { name: 'repo', exact: true }).last().click();
		await input.focus();
		await input.fill('sleep 30');
		await input.press('Enter');
		await expect
			.poll(
				async () =>
					(
						(await page.evaluate(
							(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
							key
						)) as { busy?: boolean }[]
					).at(-1)?.busy
			)
			.toBe(true);
		await closeTerminal.last().click();
		await expect(page.getByRole('alert')).toContainText('Stop this terminal process?');
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(closeTerminal).toHaveCount(2);
		await input.focus();
		await input.press('Control+C');
		await expect
			.poll(
				async () =>
					(
						(await page.evaluate(
							(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
							key
						)) as { busy?: boolean }[]
					).at(-1)?.busy
			)
			.toBe(false);
		// A running command names its tab; the name comes back once it ends.
		await expect(page.getByRole('tab', { name: 'repo', exact: true })).toHaveCount(2);
		await page.getByRole('tab', { name: 'repo', exact: true }).last().click();
		await input.focus();
		await input.fill('exit');
		await input.press('Enter');
		await expect
			.poll(
				async () =>
					(
						(await page.evaluate(
							(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
							key
						)) as { exited: boolean }[]
					).at(-1)?.exited
			)
			.toBe(true);
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				)
		);
		await expect(page.getByRole('alert')).toHaveCount(0);
		await closeTerminal.last().click();
		await expect(closeTerminal).toHaveCount(1);
		expect(
			(
				(await page.evaluate(
					(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
					key
				)) as { id: string }[]
			)[0]!.id
		).toBe(terminalId);
		// spec/task-window-workspace#terminal-close: at its prompt the shell closes without a question.
		await closeTerminal.click();
		await expect(page.locator('.xterm')).toHaveCount(0);
		await expect(page.getByRole('alert')).toHaveCount(0);
		expect(
			await page.evaluate((key) => window.brigadir.terminalCommand(key, { kind: 'list' }), key)
		).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		try {
			await (
				await app.firstWindow()
			).evaluate((key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }), key);
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/tasks#quick-tasks: the main tree has no provider; its console still opens, without the toasts «Could not read the terminal list» / «Could not open a new terminal».
test('a project without a task opens the console of its main tree (spec/tasks#quick-tasks) @area:browser', async () => {
	test.setTimeout(90000);
	const { root, repo, data } = await fixture('console-main-tree', null, true);
	await writeFile(join(repo, 'README.md'), 'hello\n');
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'dark', language: 'en' } })
	);
	const app = await launch(root, data, shell(root), ['--no-proxy-server']);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1500, 950));
		await openMainTree(app, page, 'repo');
		// spec/task-window-workspace#empty-work-area: no tabs — the work area stays with the helmet and three actions and the quick task
		// field stays at the bottom of the work area.
		const work = page.locator('[data-work-area]'),
			empty = work.locator('[data-empty-place="main-tree"]'),
			actions = empty.locator('[data-empty-action]');
		await expect(page.locator('[data-switch="work"]')).toHaveAttribute('aria-checked', 'true');
		await expect(empty).toBeVisible();
		await expect(actions).toHaveCount(3);
		await expect(work.locator('[data-quick-task-bar]')).toBeVisible();
		await expect(page.locator('[data-task-right] [data-quick-task-bar]')).toHaveCount(0);
		// Both zones may go: the panel off keeps the empty work area; the work area off too leaves the same empty
		// state in its place, with the quick task field; both come back.
		await page.locator('[data-switch="panel"]').click();
		await expect(page.locator('[data-task-right]')).toHaveCount(0);
		await expect(empty).toBeVisible();
		await page.locator('[data-switch="work"]').click();
		await expect(page.locator('[data-switch="work"]')).toHaveAttribute('aria-checked', 'false');
		await expect(work).toHaveCount(0);
		const bare = page.locator('[data-empty-place="main-tree"]');
		await expect(bare).toBeVisible();
		await expect(bare.locator('[data-empty-action]')).toHaveCount(3);
		await expect(page.locator('[data-quick-task-bar]')).toBeVisible();
		await page.locator('[data-switch="work"]').click();
		await page.locator('[data-switch="panel"]').click();
		await expect(page.locator('[data-task-right]')).toBeVisible();
		await expect(empty).toBeVisible();
		// «New file…» runs the menu's command: the New file popover.
		await actions.first().click();
		await expect(page.locator('[data-new-file]')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-new-file]')).toHaveCount(0);
		// spec/task-window-workspace#work-area: Tools opens a terminal tab in the main tree's work area.
		await page.locator('[data-tools-button]').click();
		await page.getByRole('menuitem', { name: /New terminal/ }).click();
		await expect(page.locator('.xterm')).toHaveCount(1);
		await expect(page.locator('[data-work-area] [data-quick-task-bar]')).toBeVisible();
		const input = page.locator('.xterm-helper-textarea');
		await input.focus();
		await input.fill("echo MAIN''_TREE_OK");
		await input.press('Enter');
		const key = { projectId: 'project', id: 'main-tree' };
		await expect
			.poll(() =>
				page.evaluate(async (key) => {
					const items = (await window.brigadir.terminalCommand(key, { kind: 'list' })) as {
						id: string;
					}[];
					return items[0]
						? window.brigadir.terminalCommand(key, { kind: 'text', id: items[0].id })
						: '';
				}, key)
			)
			.toContain('MAIN_TREE_OK');
		await expect(page.getByText('Could not read the terminal list.')).toHaveCount(0);
		await expect(page.getByText('Could not open a new terminal.')).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/terminal-and-cli-agents#render-and-theme: FitAddon takes off only the terminal's padding; with a padded mount it fits one row
// too many and the prompt falls under the edge. The one layout invariant kept in e2e: the grid never leaves its area.
test('the console grid stays inside its area at every window height (spec/terminal-and-cli-agents#render-and-theme) @area:browser', async () => {
	test.setTimeout(90000);
	const { root, data } = await fixture('terminal-fit', 'Fit fixture', true);
	const app = await launch(root, data, shell(root));
	try {
		const page = await app.firstWindow();
		await page.getByRole('button', { name: /Fit fixture/ }).click();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Terminal')!
				.click()
		);
		await expect(page.locator('.xterm-screen')).toHaveCount(1);
		const overflow = () =>
			page.evaluate(() => {
				const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect(),
					area = document.querySelector('.xterm')!.parentElement!.getBoundingClientRect();
				return {
					bottom: Math.round(screen.bottom - area.bottom),
					right: Math.round(screen.right - area.right),
				};
			});
		// Every remainder of the height modulo a row, 12 px among them.
		const input = page.locator('.xterm-helper-textarea');
		await input.focus();
		await input.fill('printf "%s\\n" $(seq 1 120)');
		await input.press('Enter');
		for (let height = 700; height < 720; height++) {
			await app.evaluate(
				({ BrowserWindow }, height) =>
					BrowserWindow.getAllWindows()[0]!.setSize(1300 + height, height),
				height
			);
			await expect
				.poll(
					async () => {
						const value = await overflow();
						return value.bottom <= 0 && value.right <= 0 ? 'ok' : JSON.stringify(value);
					},
					{ message: `height ${height}` }
				)
				.toBe('ok');
		}
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('execute output uses one read-only terminal, bounded tail, measured duration and live theme @area:browser', async () => {
	const { root, data, dir } = await fixture('tool-terminal', 'Tool terminal fixture');
	const raw = '\u001b[31mFAIL one\u001b[0m\nsecond line\n',
		large = 'old prefix\n' + 'long output line\n'.repeat(15000) + 'TAIL_END';
	// spec/chat#tool-groups: calls in a row would fold into a group; messages between them keep each call its own row here.
	const events = [
		{ kind: 'turn.started', text: 'Run the checks.' },
		{
			kind: 'tool.changed',
			patch: {
				id: 'failed',
				name: 'Bash',
				title: 'pnpm test',
				category: 'execute',
				status: 'in_progress',
			},
		},
		{
			kind: 'tool.changed',
			patch: {
				id: 'failed',
				status: 'failed',
				output: raw,
				content: [{ kind: 'text', text: '```console\n' + raw + '```' }],
			},
		},
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'between-1',
			content: { kind: 'text', text: 'Now the directory.' },
		},
		{
			kind: 'tool.changed',
			patch: {
				id: 'success',
				category: 'execute',
				name: 'Bash',
				title: 'pwd',
				status: 'completed',
				content: [{ kind: 'text', text: '```console\nfixture directory\n```' }],
			},
		},
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'between-2',
			content: { kind: 'text', text: 'And the long check.' },
		},
		{
			kind: 'tool.changed',
			patch: {
				id: 'large',
				category: 'execute',
				name: 'Bash',
				title: 'long check',
				status: 'failed',
				output: large,
			},
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
	const app = await launch(root, data);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setSize(1280, 1000)
		);
		await page.getByRole('button', { name: /Tool terminal fixture/ }).click();
		const log = page.getByRole('log', { name: 'Conversation' }),
			failed = log.locator('details').filter({ has: page.locator('summary [title="pnpm test"]') });
		await expect(failed).toHaveAttribute('open', '');
		await expect(failed.locator('summary small')).toHaveText('1s');
		await expect(failed.locator('.xterm-accessibility-tree')).toContainText('FAIL one');
		await expect(failed.locator('.xterm')).toHaveCount(1);
		await expect(failed.locator('pre')).toHaveCount(0);
		const success = log.locator('details').filter({ has: page.locator('summary [title="pwd"]') });
		await expect(success).not.toHaveAttribute('open', '');
		await success.locator('summary').click();
		await expect(success.locator('.xterm-accessibility-tree')).toContainText('fixture directory');
		const huge = log
			.locator('details')
			.filter({ has: page.locator('summary [title="long check"]') });
		await expect(huge.getByRole('status')).toBeVisible();
		await expect(huge.locator('.xterm-accessibility-tree')).toContainText('TAIL_END');
		await expect(log.getByRole('button', { name: /kill/i })).toHaveCount(0);
		// The same terminal lives through theme changes.
		await failed
			.locator('.xterm')
			.evaluate((node) => node.setAttribute('data-same-terminal', 'yes'));
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await expect(failed.locator('.xterm')).toHaveAttribute('data-same-terminal', 'yes');
		}
		const input = failed.locator('textarea');
		await expect(input).toHaveJSProperty('readOnly', true);
		await input.press('x');
		await expect(failed.locator('.xterm-accessibility-tree')).not.toContainText('must not run');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
