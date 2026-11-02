import { refreshChanges } from './refresh-changes';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { launchPRFixture } from './pr-fixture';
import { hideChat, hidePanel, openPanelTab, showChat } from './layout';
const run = promisify(execFile);
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
const pr = 'https://github.com/acme/shop-app/pull/1062';
// One done task `title` over a fresh git repo; `answer` is the agent's reply in its log. Repo files go in before `launch`.
async function chatFixture(
	title: string,
	answer: string,
	options: { settings?: object; extra?: object[] } = {}
) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-chat-links-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await run('git', ['init', '-q'], { cwd: repo });
	if (options.settings)
		await writeFile(
			join(data, 'settings.json'),
			JSON.stringify({ schemaVersion: 1, settings: options.settings })
		);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { id: 'task', projectId: 'project', title, status: 'done', provider: 'claude' },
		})
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	const events = [
		{ kind: 'turn.started', text: 'Go.' },
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'answer',
			content: { kind: 'text', text: answer },
		},
		...(options.extra ?? []),
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
					at: new Date(Date.UTC(2026, 9, 2, 12, 0, index)).toISOString(),
					event,
				})
			)
			.join('\n') + '\n'
	);
	const launch = (args: string[] = []) =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`, ...args],
			env: { ...env, BRIGADIR_DATA_DIR: data },
		});
	return { root, repo, data, dir, launch };
}
// spec/chat#web-links: a bare URL and a Markdown link in the agent's answer open the system browser; paths stay editor links.
test('chat links: bare and Markdown URLs open the system browser, paths and code stay what they were @area:chat', async ({}, info) => {
	const answer = `Pushed the branch and opened a draft PR into staging: ${pr}.\n\nThe summary is in [the PR description](${pr}#issue) (background: https://en.wikipedia.org/wiki/Foo_(bar)). I followed docs/rules/pr-conventions.md, regenerated package-lock.json and changed src/foo.ts:3.\n\nNot links: \`https://example.com/in-code\`, www.example.com, team@example.com, [script](javascript:alert(1)) and [file](file:///etc/hosts).\n\n\`\`\`sh\ncurl https://example.com/in-fence\n\`\`\``;
	const { root, repo, launch } = await chatFixture('Chat links fixture', answer);
	await mkdir(join(repo, 'src'), { recursive: true });
	await mkdir(join(repo, 'docs/rules'), { recursive: true });
	await writeFile(join(repo, 'src/foo.ts'), 'export const foo = 1;\n\nexport const bar = 2;\n');
	await writeFile(join(repo, 'docs/rules/pr-conventions.md'), '# PR\n');
	await writeFile(join(repo, 'package-lock.json'), '{}\n');
	const app = await launch();
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ shell }) => {
			(globalThis as any).openedExternal = [];
			shell.openExternal = async (url) => {
				(globalThis as any).openedExternal.push(url);
			};
		});
		await page.getByRole('button', { name: /Chat links fixture/ }).click();
		const log = page.getByRole('log', { name: 'Conversation' });
		// The path links settle after the existence check; the screenshots wait for them.
		await expect(log.getByRole('button', { name: 'src/foo.ts:3', exact: true })).toHaveCount(1);
		const shoot = async (name: string) => {
			for (const theme of ['dark', 'light'] as const) {
				await app.evaluate(({ nativeTheme }, theme) => {
					nativeTheme.themeSource = theme;
				}, theme);
				await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
				await page.mouse.move(0, 0);
				await log.screenshot({
					animations: 'disabled',
					path: info.outputPath(`${name}-${theme}.png`),
				});
			}
		};
		await shoot('chat-links');
		const bare = log.getByRole('link', { name: pr, exact: true }),
			named = log.getByRole('link', { name: 'the PR description', exact: true });
		await expect(bare).toHaveCount(1);
		await expect(named).toHaveCount(1);
		await expect(
			log.getByRole('link', { name: 'https://en.wikipedia.org/wiki/Foo_(bar)', exact: true })
		).toHaveCount(1);
		// Paths are editor links, never domains; code, www., e-mail and unsafe schemes are not links.
		for (const path of ['docs/rules/pr-conventions.md', 'package-lock.json', 'src/foo.ts:3'])
			await expect(log.getByRole('button', { name: path, exact: true })).toHaveCount(1);
		await expect(log.locator('a[href]')).toHaveCount(3);
		await expect(log.locator('code a, pre a')).toHaveCount(0);
		for (const name of ['script', 'file', 'www.example.com', 'team@example.com'])
			await expect(log.getByRole('link', { name, exact: true })).toHaveCount(0);
		await expect(bare).toHaveAttribute('title', pr);
		const url = page.url();
		await bare.click();
		await named.click();
		await expect
			.poll(() => app.evaluate(() => (globalThis as any).openedExternal))
			.toEqual([pr, `${pr}#issue`]);
		expect(page.url()).toBe(url);
		expect(app.windows()).toHaveLength(1);
		// Keyboard: Enter on a focused link opens it too.
		await bare.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => app.evaluate(() => (globalThis as any).openedExternal.length)).toBe(3);
		// A path next to the URL still opens the editor.
		await log.getByRole('button', { name: 'src/foo.ts:3', exact: true }).click();
		await expect(
			page
				.locator('section')
				.filter({ has: page.getByRole('textbox', { name: 'File content' }) })
				.last()
				.locator(':scope > footer')
		).toContainText('3:1');
		// The main process refuses what the renderer would never send.
		for (const href of [
			'javascript:alert(1)',
			'file:///etc/hosts',
			'https://user:pass@example.com/',
			'data:text/html,x',
		])
			await expect(
				page.evaluate((href) => window.brigadir.openWebLink(href), href)
			).rejects.toThrow();
		expect(await app.evaluate(() => (globalThis as any).openedExternal.length)).toBe(3);
		expect(errors).toEqual([]);
	} finally {
		await app
			.evaluate(({ dialog }) => {
				dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
			})
			.catch(() => {});
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/chat#path-tails, spec/terminal-and-cli-agents#roles: a shortened path links the one file it names; a folder opens in Files, expanded down to it and selected.
test('chat links: a path tail opens its file, a folder shows in Files @area:chat', async ({}, info) => {
	const answer =
		'The header is `Header/index.tsx:2`, the panel is AsidePanel.tsx, and the docs live in docs/domains/dashboard.';
	const { root, repo, launch } = await chatFixture('Chat folders fixture', answer);
	await mkdir(join(repo, 'src/components/Header'), { recursive: true });
	await mkdir(join(repo, 'docs/domains/dashboard'), { recursive: true });
	await writeFile(
		join(repo, 'src/components/Header/index.tsx'),
		'export const a = 1;\nexport const b = 2;\n'
	);
	await writeFile(join(repo, 'docs/domains/dashboard/README.md'), '# Dashboard\n');
	const app = await launch();
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Chat folders fixture/ }).click();
		const log = page.getByRole('log', { name: 'Conversation' }),
			header = log.getByRole('button', { name: 'Header/index.tsx:2', exact: true }),
			folder = log.getByRole('button', { name: 'docs/domains/dashboard', exact: true });
		await expect(header).toHaveCount(1);
		await expect(folder).toHaveCount(1);
		await expect(log.getByRole('button', { name: 'AsidePanel.tsx', exact: true })).toHaveCount(0);
		await expect(header).toHaveAttribute('title', /src\/components\/Header\/index\.tsx:2$/);
		await expect(folder).toHaveAttribute('title', /docs\/domains\/dashboard$/);
		await folder.click();
		const tree = page.getByRole('tree', { name: 'Project files' }),
			row = tree.getByRole('treeitem', { name: 'dashboard', exact: true });
		await expect(row).toHaveAttribute('aria-selected', 'true');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		for (const name of ['docs', 'domains'])
			await expect(tree.getByRole('treeitem', { name, exact: true })).toHaveAttribute(
				'aria-expanded',
				'true'
			);
		await expect(tree.getByRole('treeitem', { name: 'README.md', exact: true })).toBeVisible();
		for (const theme of ['dark', 'light'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.mouse.move(0, 0);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`chat-folder-files-${theme}.png`),
			});
		}
		// The editor takes the chat's place, so the file goes last.
		await header.click();
		await expect(
			page
				.locator('section')
				.filter({ has: page.getByRole('textbox', { name: 'File content' }) })
				.last()
				.locator(':scope > footer')
		).toContainText('2:1');
		expect(errors).toEqual([]);
	} finally {
		await app
			.evaluate(({ dialog }) => {
				dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
			})
			.catch(() => {});
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/chat#web-links: a local page (the dev server) opens in the task's browser (spec/browser-and-simulator#browser); with the browser module off — the system one.
for (const browserModule of [true, false])
	test(`chat links: localhost goes to the ${browserModule ? 'task browser' : 'system browser while the browser module is off'} @area:chat`, async () => {
		const server = createServer((_req, res) => {
			res.setHeader('Content-Type', 'text/html');
			res.end('<title>Dev server</title><p>Local page</p>');
		});
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		const local = `http://localhost:${(server.address() as { port: number }).port}/`;
		const { root, launch } = await chatFixture(
			'Local links fixture',
			`The dev server is up at ${local} and the docs are at https://example.com/docs.`,
			{
				settings: {
					appearance: 'dark',
					language: 'en',
					modules: { browser: browserModule, simulator: false },
				},
			}
		);
		const app = await launch(['--no-proxy-server']);
		try {
			const page = await app.firstWindow(),
				errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()[0]!.setSize(1600, 950)
			);
			await app.evaluate(({ shell }) => {
				(globalThis as any).openedExternal = [];
				shell.openExternal = async (url) => {
					(globalThis as any).openedExternal.push(url);
				};
			});
			await page.getByRole('button', { name: /Local links fixture/ }).click();
			const log = page.getByRole('log', { name: 'Conversation' }),
				panel = page.getByRole('region', { name: 'Browser', exact: true }),
				url = page.url();
			await expect(panel).toHaveCount(0);
			await log.getByRole('link', { name: local, exact: true }).click();
			if (browserModule) {
				await expect(panel).toBeVisible();
				await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(
					// spec/task-window-workspace#tool-tab-look.1: the field at rest has no scheme and no root `/`.
					local.replace(/^http:\/\//, '').replace(/\/$/, '')
				);
				await expect
					.poll(() =>
						page.evaluate(() =>
							window.brigadir
								.browserCommand({ projectId: 'project', id: 'task' }, { kind: 'read' })
								.then((state) => (state as { title?: string }).title)
								.catch(() => null)
						)
					)
					.toBe('Dev server');
				expect(await app.evaluate(() => (globalThis as any).openedExternal)).toEqual([]);
			} else {
				await expect
					.poll(() => app.evaluate(() => (globalThis as any).openedExternal))
					.toEqual([local]);
				await expect(panel).toHaveCount(0);
			}
			// Any other address still goes to the system browser.
			await log.getByRole('link', { name: 'https://example.com/docs', exact: true }).click();
			await expect
				.poll(() => app.evaluate(() => (globalThis as any).openedExternal))
				.toEqual(
					browserModule ? ['https://example.com/docs'] : [local, 'https://example.com/docs']
				);
			// The task browser is a view inside the window, not a new window.
			expect(page.url()).toBe(url);
			expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
				1
			);
			expect(errors).toEqual([]);
		} finally {
			await app
				.evaluate(({ dialog }) => {
					dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
				})
				.catch(() => {});
			await app.close();
			server.close();
			await rm(root, { recursive: true, force: true });
		}
	});

// Paths in the transcript and tool titles link verified project files only.
test('transcript links verified project paths and tool targets, preserves dirty editors and refreshes new files @area:chat', async ({}, info) => {
	const outsideDir = await mkdtemp(join(tmpdir(), 'brigadir-file-links-outside-')),
		outside = join(outsideDir, 'outside.ts');
	await writeFile(outside, 'outside');
	const answer = `Read src/plain.ts:5 and \`src/My file.ts:42\`.\n\nThese are not links: missing.ts, escape.ts, ${outside}, https://example.invalid/file.ts and 2.23.1.\n\nCheck future.ts after the next refresh.\n\n\`\`\`ts\n// src/plain.ts stays code here.\n\`\`\``;
	const { root, repo, launch } = await chatFixture('File links fixture', answer, {
		extra: [
			{
				kind: 'tool.changed',
				patch: { id: 'edit', category: 'edit', status: 'completed', title: 'Edit src/plain.ts:5' },
			},
		],
	});
	await mkdir(join(repo, 'src'), { recursive: true });
	await writeFile(
		join(repo, 'src/plain.ts'),
		Array.from({ length: 60 }, (_, i) => `// Plain ${i + 1}`).join('\n')
	);
	await writeFile(
		join(repo, 'src/My file.ts'),
		Array.from({ length: 60 }, (_, i) => `// Spaced ${i + 1}`).join('\n')
	);
	await symlink(outside, join(repo, 'escape.ts'));
	const app = await launch();
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /File links fixture/ }).click();
		const log = page.getByRole('log', { name: 'Conversation' }),
			plain = log.getByRole('button', { name: 'src/plain.ts:5', exact: true });
		await expect(plain).toHaveCount(2);
		await expect(log.getByRole('button', { name: 'src/My file.ts:42', exact: true })).toHaveCount(
			1
		);
		for (const path of ['missing.ts', 'escape.ts', outside, 'future.ts', '2.23.1'])
			await expect(log.getByRole('button', { name: path, exact: true })).toHaveCount(0);
		await expect(log.locator('pre button')).toHaveCount(0);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`links-${theme}.png`),
			});
		}
		await plain.last().click();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toBeVisible();
		await expect(
			page
				.locator('section')
				.filter({ has: page.getByRole('textbox', { name: 'File content' }) })
				.last()
				.locator(':scope > footer')
		).toContainText('5:1');
		await editor.click();
		await editor.press('Meta+a');
		await page.keyboard.insertText('unsaved content survives another link');
		await showChat(page);
		await plain.first().click();
		await expect(editor).toContainText('unsaved content survives another link');
		await expect(page.getByRole('tab', { name: 'src/plain.ts', exact: true })).toHaveCount(1);
		await showChat(page);
		await log.getByRole('button', { name: 'src/My file.ts:42', exact: true }).click();
		await expect(
			page
				.locator('section')
				.filter({ has: page.getByRole('textbox', { name: 'File content' }) })
				.last()
				.locator(':scope > footer')
		).toContainText('42:1');
		await showChat(page);
		await writeFile(join(repo, 'future.ts'), 'export const future = true;');
		await refreshChanges(page);
		await expect(log.getByRole('button', { name: 'future.ts', exact: true })).toHaveCount(1);
		expect(errors).toEqual([]);
	} finally {
		await app
			.evaluate(({ dialog }) => {
				dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
			})
			.catch(() => {});
		await app.close();
		await rm(root, { recursive: true, force: true });
		await rm(outsideDir, { recursive: true, force: true });
	}
});

// spec/notifications-slack-notes-and-schedules#message-classes: a failure of the person's action is its own toast — it names the file, offers Retry, folds repeats into ×N,
// closes with PopupClose or Esc and gives the focus back; nothing sticks under the toolbar or the document tabs.
test('a failed file open is a toast with the file, Retry, ×2 and Esc; no sticky line @area:chat', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-toasts-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(join(repo, 'Button.tsx'), 'export const Button = 1;\n');
	await git('add', '.');
	await git('commit', '-qm', 'Baseline');
	const key = { projectId: 'project', id: 'task' };
	const taskDir = join(root, 'data/projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { ...key, title: 'Toasts fixture', status: 'done', provider: 'claude' },
		})
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Toasts fixture/ }).click();
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' }),
			region = page.locator('[data-toast-region]');
		// Every `files:read` fails until the test lets one through.
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				state = globalThis as any;
			state.readFiles = handlers.get('files:read');
			state.failRead = true;
			handlers.set('files:read', (...args: any[]) => {
				if (state.failRead) throw new Error('Fixture read failure');
				return state.readFiles(...args);
			});
		});
		await tree.getByRole('treeitem', { name: 'Button.tsx', exact: true }).dblclick();
		const toast = region.getByRole('alert');
		await expect(toast).toContainText('Button.tsx');
		await tree.getByRole('treeitem', { name: 'Button.tsx', exact: true }).dblclick();
		await expect(toast).toHaveCount(1);
		await expect(toast).toContainText('×2');
		for (const theme of ['dark', 'light'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => (nativeTheme.themeSource = theme), theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await toast.screenshot({
				animations: 'disabled',
				path: info.outputPath(`toast-error-${theme}.png`),
			});
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`window-${theme}.png`),
			});
		}
		// Esc on the focused toast closes it and gives the focus back to where it was.
		await tree.getByRole('treeitem', { name: 'Button.tsx', exact: true }).focus();
		const close = toast.getByRole('button', { name: 'Close', exact: true });
		await close.focus();
		await expect(close).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(region).toHaveCount(0);
		await expect(tree.getByRole('treeitem', { name: 'Button.tsx', exact: true })).toBeFocused();
		// Retry repeats the failed open; it succeeds once the read works again.
		await tree.getByRole('treeitem', { name: 'Button.tsx', exact: true }).dblclick();
		await expect(toast).toContainText('Button.tsx');
		await app.evaluate(() => {
			(globalThis as any).failRead = false;
		});
		await toast.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(region).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'File content' })).toContainText('Button = 1');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// spec/pull-requests-and-ci#pr-links: a PR page of a repo of the task opens in the PR panel; another repo, ⌘-click and an unreadable PR go to the system browser.
for (const module of [true, false])
	test(`chat links: a PR link of this project ${module ? 'opens in the PR panel, others in the system browser' : 'goes to the system browser while the PR module is off'} (spec/pull-requests-and-ci#pr-links) @area:chat`, async () => {
		test.setTimeout(120000);
		const { app, close, page, errors, root } = await launchPRFixture({
			task: false,
			...(module
				? {}
				: { modules: { browser: true, simulator: false, pullRequests: false, commands: true } }),
		});
		try {
			const mine = 'https://github.com/fixture/admin/pull/421',
				files = 'https://github.com/fixture/admin/pull/421/files',
				foreign = 'https://github.com/someone/else/pull/5',
				missing = 'https://github.com/fixture/admin/pull/9999',
				issue = 'https://github.com/fixture/admin/issues/3';
			const dir = join(root, 'data/projects/project/tasks/linker');
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, 'task.json'),
				JSON.stringify({
					schemaVersion: 1,
					task: {
						id: 'linker',
						projectId: 'project',
						title: 'Links fixture',
						status: 'done',
						provider: 'claude',
					},
				})
			);
			const answer = `Opened ${mine} and ${foreign}.\n\nAlso [the files](${files}), [a missing one](${missing}) and [an issue](${issue}).`;
			const events = [
				{ kind: 'turn.started', text: 'Links.' },
				{
					kind: 'message.delta',
					role: 'assistant',
					messageId: 'answer',
					content: { kind: 'text', text: answer },
				},
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
							at: new Date(Date.UTC(2026, 9, 8, 12, 0, index)).toISOString(),
							event,
						})
					)
					.join('\n') + '\n'
			);
			await page.reload();
			await app.evaluate(({ shell }) => {
				(globalThis as any).openedExternal = [];
				shell.openExternal = async (url) => {
					(globalThis as any).openedExternal.push(url);
				};
			});
			await page.getByRole('button', { name: /Links fixture/ }).click();
			const log = page.getByRole('log', { name: 'Conversation' }),
				opened = () => app.evaluate(() => (globalThis as any).openedExternal as string[]);
			const tabs = page.getByRole('tablist', { name: 'Pull request', exact: true });
			if (!module) {
				for (const [name, url] of [
					[mine, mine],
					['the files', files],
					['a missing one', missing],
				] as const) {
					await log.getByRole('link', { name, exact: true }).click();
					await expect.poll(opened).toContain(url);
				}
				await expect(tabs).toHaveCount(0);
				expect(errors).toEqual([]);
				return;
			}
			// The repo of the task: the PR opens in the panel on its Comments tab, the system browser stays untouched.
			await log.getByRole('link', { name: mine, exact: true }).click();
			await expect(tabs.getByRole('tab', { name: 'Comments', exact: true })).toHaveAttribute(
				'aria-selected',
				'true'
			);
			await expect(
				page.getByRole('button', { name: 'Back to the list', exact: true })
			).toBeVisible();
			expect(await opened()).toEqual([]);
			// The `/files` tail names the Files tab.
			await page.getByRole('button', { name: 'Back to the list', exact: true }).click();
			await log.getByRole('link', { name: 'the files', exact: true }).click();
			await expect(tabs.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute(
				'aria-selected',
				'true'
			);
			expect(await opened()).toEqual([]);
			// ⌘-click is the way out to the browser.
			await log.getByRole('link', { name: mine, exact: true }).click({ modifiers: ['Meta'] });
			await expect.poll(opened).toEqual([mine]);
			// Another repository, an issue: the system browser as before, with no toast.
			await log.getByRole('link', { name: foreign, exact: true }).click();
			await expect.poll(opened).toEqual([mine, foreign]);
			await log.getByRole('link', { name: 'an issue', exact: true }).click();
			await expect.poll(opened).toEqual([mine, foreign, issue]);
			await expect(page.locator('[data-toast-region]')).toHaveCount(0);
			// A PR that GitHub does not give: the browser and a toast.
			await log.getByRole('link', { name: 'a missing one', exact: true }).click();
			await expect.poll(opened).toEqual([mine, foreign, issue, missing]);
			await expect(page.locator('[data-toast-region]').getByRole('alert')).toBeVisible();
			expect(errors).toEqual([]);
		} finally {
			await close();
		}
	});

// spec/terminal-and-cli-agents#console-menu: the console's menu on a PR link has «Open in the PR panel» first; it opens the PR as ⌘-click does.
test('console menu: a PR link opens in the PR panel (spec/terminal-and-cli-agents#console-menu) @area:chat', async () => {
	test.setTimeout(120000);
	const { app, close, page, errors, root } = await launchPRFixture({ task: false });
	try {
		const dir = join(root, 'data/projects/project/tasks/linker');
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id: 'linker',
					projectId: 'project',
					title: 'Console links fixture',
					status: 'done',
					provider: 'claude',
				},
			})
		);
		await page.reload();
		await app.evaluate(({ Menu, shell }) => {
			const state = globalThis as any;
			state.openedExternal = [];
			shell.openExternal = async (url) => {
				state.openedExternal.push(url);
			};
			Menu.prototype.popup = function (options) {
				state.menu = this;
				state.options = options;
			};
		});
		const items = async () => {
			await expect.poll(() => app.evaluate(() => !!(globalThis as any).menu)).toBe(true);
			return app.evaluate(() =>
				(globalThis as any).menu.items.map((item: any) =>
					item.type === 'separator' ? '-' : item.label
				)
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
		await page.getByRole('button', { name: /Console links fixture/ }).click();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('terminal')!.click()
		);
		// One row per output line: the work area takes the window's width (spec/task-window-workspace#layout-switch) once the terminal is its tab (spec/task-window-workspace#empty-work-area).
		await expect(page.locator('.xterm')).toHaveCount(1);
		await hideChat(page);
		await hidePanel(page);
		const input = page.locator('.xterm-helper-textarea');
		await input.focus();
		// The command line has `$((400+21))`, the output line `421`: only the output is the link.
		await input.fill(`printf '%s\\n' "PR https://github.com/fixture/admin/pull/$((400+21))"`);
		await input.press('Enter');
		const key = { projectId: 'project', id: 'linker' },
			list = (await page.evaluate(
				(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
				key
			)) as { id: string }[],
			id = list[0]!.id;
		const text = () =>
			page.evaluate(({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'text', id }), {
				key,
				id,
			}) as Promise<string>;
		await expect.poll(text).toContain('fixture/admin/pull/421');
		const line = (await text())
				.split('\n')
				.find((entry) => entry.includes('pull/421') && !entry.includes('printf'))!,
			col = line.indexOf('github.com');
		const box = (await page.locator('.xterm-screen').boundingBox())!,
			cell = await page.evaluate(() => {
				const area = document.querySelector('.xterm-helper-textarea') as HTMLElement;
				return { h: parseFloat(area.style.height), w: parseFloat(area.style.width) };
			});
		await page.mouse.click(box.x + cell.w * (col + 4), box.y + cell.h * 1.5, { button: 'right' });
		await items();
		await choose('Open in the PR panel');
		await expect(
			page
				.getByRole('tablist', { name: 'Pull request', exact: true })
				.getByRole('tab', { name: 'Comments', exact: true })
		).toHaveAttribute('aria-selected', 'true');
		expect(await app.evaluate(() => (globalThis as any).openedExternal)).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});
