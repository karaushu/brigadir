import {
	_electron as electron,
	expect,
	test,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { showPanel } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
// spec/architecture-and-platform#crash-recovery: a render error takes down only its surface; a missing chunk reloads once; a lost renderer comes back.
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-crash-'));
	const repo = join(root, 'repo');
	await mkdir(repo, { recursive: true });
	for (const [id, title] of [
		['task', 'Crash fixture'],
		['other', 'Other task'],
	]) {
		const dir = join(root, `data/projects/project/tasks/${id}`);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: { id, projectId: 'project', title, status: 'done', provider: 'claude' },
			})
		);
	}
	await writeFile(
		join(root, 'data/projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	return root;
}
async function launch(root: string, options: { crash?: string; app?: string } = {}) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [options.app ?? desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			HOME: root,
			ZDOTDIR: root,
			SHELL: '/bin/zsh',
			BRIGADIR_DATA_DIR: join(root, 'data'),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			...(options.crash ? { BRIGADIR_TEST_CRASH: options.crash } : {}),
		},
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 860));
	return { app, page };
}
const logLines = async (root: string) => {
	try {
		return (await readFile(join(root, 'data/logs/renderer.jsonl'), 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
};
async function themes(
	app: ElectronApplication,
	page: Page,
	shot: (theme: 'dark' | 'light') => Promise<unknown>
) {
	for (const theme of ['dark', 'light'] as const) {
		await app.evaluate(({ nativeTheme }, theme) => {
			nativeTheme.themeSource = theme;
		}, theme);
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 15_000 });
		await shot(theme);
	}
}

test('a console that throws leaves the chat and the panel working and shows again @area:shell @serial', async ({}, info) => {
	const root = await fixture();
	const { app, page } = await launch(root, { crash: 'console' });
	try {
		await page.getByRole('button', { name: /Crash fixture/ }).click();
		// spec/task-window-workspace#work-area: ⇧⌘Y opens a terminal tab of the work area.
		await app.evaluate(
			({ Menu }, label) =>
				Menu.getApplicationMenu()!
					.items.find((item) => item.label === 'View')!
					.submenu!.items.find((item) => item.label === label)!
					.click(),
			'Terminal'
		);
		const crash = page.locator('[data-crash="console"]');
		await expect(crash).toBeVisible();
		await expect(crash.getByRole('heading', { name: 'Console error' })).toBeVisible();
		await expect(crash.locator('p')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
		await expect(page.locator('[data-crash="window"]')).toHaveCount(0);
		const copy = crash.getByRole('button', { name: 'Copy details' });
		await copy.hover();
		await themes(app, page, (theme) =>
			page.screenshot({ animations: 'disabled', path: info.outputPath(`console-${theme}.png`) })
		);
		await copy.click();
		await expect(crash.getByRole('button', { name: 'Copied' })).toBeVisible();
		expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
			'Test crash in the console surface'
		);
		await expect
			.poll(async () => (await logLines(root)).map((line) => `${line.kind}/${line.surface}`))
			.toEqual(['boundary/console']);
		await crash.getByRole('button', { name: 'Show again' }).click();
		await expect(page.locator('.xterm')).toHaveCount(1);
		await expect(crash).toHaveCount(0);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('the window screen reloads the window and its details disclose the stack @area:shell @serial', async ({}, info) => {
	const root = await fixture();
	const { app, page } = await launch(root, { crash: 'window' });
	try {
		const crash = page.locator('[data-crash="window"]');
		await expect(crash.getByRole('heading', { name: 'Window error' })).toBeVisible();
		// The strip under the window buttons stays draggable.
		expect(
			await crash.evaluate((node) =>
				getComputedStyle(node.firstElementChild!).getPropertyValue('-webkit-app-region')
			)
		).toBe('drag');
		await themes(app, page, (theme) =>
			page.screenshot({ animations: 'disabled', path: info.outputPath(`window-${theme}.png`) })
		);
		await crash.getByText('Error details').click();
		await expect(crash.locator('pre')).toContainText('Test crash in the window surface');
		await crash.getByRole('button', { name: 'Reload the window' }).hover();
		await page.waitForTimeout(300);
		await page.screenshot({ animations: 'disabled', path: info.outputPath('window-details.png') });
		await crash.getByRole('button', { name: 'Reload the window' }).click();
		await expect(page.getByRole('button', { name: /Crash fixture/ })).toBeVisible();
		await expect(crash).toHaveCount(0);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('a task window that throws keeps the sidebar; the next task opens @area:shell @serial', async ({}, info) => {
	const root = await fixture();
	const { app, page } = await launch(root, { crash: 'task' });
	try {
		await page.getByRole('button', { name: /Crash fixture/ }).click();
		const crash = page.locator('[data-crash="task"]');
		await expect(crash.getByRole('heading', { name: 'Task window error' })).toBeVisible();
		await themes(app, page, (theme) =>
			page.screenshot({ animations: 'disabled', path: info.outputPath(`task-${theme}.png`) })
		);
		await page.getByRole('button', { name: /Other task/ }).click();
		await expect(crash).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('the browser and the panel fall in their own columns @area:shell @serial', async ({}, info) => {
	for (const surface of ['browser', 'panel'] as const) {
		const root = await fixture();
		const { app, page } = await launch(root, { crash: surface });
		try {
			await page.getByRole('button', { name: /Crash fixture/ }).click();
			// spec/task-window-workspace#work-area: the browser falls in its tab of the work area; the panel in the panel.
			if (surface === 'browser')
				await app.evaluate(({ Menu }) =>
					Menu.getApplicationMenu()!
						.items.find((item) => item.label === 'View')!
						.submenu!.items.find((item) => item.label === 'Browser')!
						.click()
				);
			// A new task opens without the panel (spec/task-window-workspace#layout-switch): it falls as its switch shows it.
			if (surface === 'panel') await showPanel(page);
			const crash = page.locator(`[data-crash="${surface}"]`);
			await expect(crash).toBeVisible();
			if (surface === 'browser')
				expect(
					Math.abs(
						(await crash.boundingBox())!.width -
							(await page.locator('[data-work-area]').boundingBox())!.width
					)
				).toBeLessThan(2);
			await themes(app, page, (theme) =>
				page.screenshot({
					animations: 'disabled',
					path: info.outputPath(`${surface}-${theme}.png`),
				})
			);
			await crash.getByRole('button', { name: 'Show again' }).click();
			await expect(crash).toHaveCount(0);
		} finally {
			await app.close();
			await rm(root, { recursive: true, force: true });
		}
	}
});

test('a chunk the build no longer has reloads the window once, then explains @area:shell @serial', async () => {
	test.setTimeout(90_000);
	const root = await fixture();
	// A copy of the build inside apps/desktop resolves the same node_modules; its console chunk is gone, as after a rebuild.
	const copy = join(desktop, '.launch', `test-${process.pid}`);
	await rm(copy, { recursive: true, force: true });
	await cp(join(desktop, 'out'), join(copy, 'out'), { recursive: true });
	await writeFile(
		join(copy, 'package.json'),
		JSON.stringify({ name: '@brigadir/desktop', main: 'out/main/index.js' })
	);
	const assets = join(copy, 'out/renderer/assets');
	for (const file of await readdir(assets))
		if (/^TerminalPanel-.*\.js$/.test(file)) await rm(join(assets, file));
	const { app, page } = await launch(root, { app: copy });
	try {
		await page.getByRole('button', { name: /Crash fixture/ }).click();
		await app.evaluate(
			({ Menu }, label) =>
				Menu.getApplicationMenu()!
					.items.find((item) => item.label === 'View')!
					.submenu!.items.find((item) => item.label === label)!
					.click(),
			'Terminal'
		);
		await expect
			.poll(
				async () => (await logLines(root)).filter((line) => line.kind === 'chunk-reload').length
			)
			.toBe(1);
		await page.waitForLoadState('load');
		await page.getByRole('button', { name: /Crash fixture/ }).click();
		if (!(await page.locator('[data-tool=terminal]').count()))
			await app.evaluate(
				({ Menu }, label) =>
					Menu.getApplicationMenu()!
						.items.find((item) => item.label === 'View')!
						.submenu!.items.find((item) => item.label === label)!
						.click(),
				'Terminal'
			);
		const crash = page.locator('[data-crash="console"]');
		await expect(crash).toContainText('The application files changed. Restart Brigadir.');
		expect((await logLines(root)).filter((line) => line.kind === 'chunk-reload')).toHaveLength(1);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
		await rm(copy, { recursive: true, force: true });
	}
});

test('a lost renderer process reloads the window on its own @area:shell @serial', async () => {
	const root = await fixture();
	const { app, page } = await launch(root);
	try {
		await expect(page.getByRole('button', { name: /Crash fixture/ })).toBeVisible();
		await app.evaluate(({ webContents }) =>
			webContents
				.getAllWebContents()
				.find((item) => item.getURL().includes('index.html'))!
				.forcefullyCrashRenderer()
		);
		await expect
			.poll(async () => (await logLines(root)).map((line) => line.kind))
			.toEqual(['process-gone']);
		await expect
			.poll(() =>
				app.evaluate(({ webContents }) => {
					const item = webContents
						.getAllWebContents()
						.find((item) => item.getURL().includes('index.html'))!;
					return !item.isCrashed() && !item.isLoading();
				})
			)
			.toBe(true);
		await expect
			.poll(() =>
				app.evaluate(({ webContents }) =>
					webContents
						.getAllWebContents()
						.find((item) => item.getURL().includes('index.html'))!
						.executeJavaScript('document.body.innerText')
				)
			)
			.toContain('Crash fixture');
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
