import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
// Picks one item of the next native menu instead of showing it.
const choose = (application: ElectronApplication, label: string) =>
	application.evaluate(({ Menu }, label) => {
		const original = Menu.buildFromTemplate;
		Menu.buildFromTemplate = (items: any[]) => {
			Menu.buildFromTemplate = original;
			const item = items.find((item) => item.label === label);
			if (!item) throw new Error(`No menu item ${label}`);
			return {
				popup: ({ callback }: any) => {
					item.click();
					callback?.();
				},
			} as any;
		};
	}, label);

// spec/notifications-slack-notes-and-schedules#note-file: Copy note puts the text, or a `<title>.md` file, on the clipboard.
test('Copy note copies the Markdown or the note as a titled file @area:notes', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-notes-copy-')),
		data = join(root, 'data'),
		text = '# Migration: plan/v2\n\n- [ ] step one\n';
	await mkdir(join(data, 'notes'), { recursive: true });
	await writeFile(join(data, 'notes/note-copy1.md'), text);
	await writeFile(
		join(data, 'notes/note-copy1.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: null,
			createdAt: new Date().toISOString(),
			tasks: [],
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
	try {
		const page = await app.firstWindow();
		await page.getByRole('button', { name: 'Notes', exact: true }).first().click();
		await page.getByText('Migration: plan/v2').first().click();
		const copy = page.getByRole('button', { name: 'Copy note' });
		await expect(copy).toBeVisible();

		await choose(app, 'Copy Markdown');
		await copy.click();
		await expect(page.getByText('Copied')).toBeVisible();
		expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);

		await choose(app, 'Copy as file');
		await copy.click();
		const formats = await app.evaluate(async ({ clipboard }) =>
			(await clipboard.read()).flatMap((item) => item.types)
		);
		expect(formats).toContain('text/uri-list');
		const url = await app.evaluate(async ({ clipboard }) => {
			const item = (await clipboard.read()).find((entry) => entry.types.includes('text/uri-list'));
			return item ? await (await item.getType('text/uri-list')).text() : '';
		});
		const path = fileURLToPath(url.trim().split(/\r?\n/)[0]);
		expect(basename(path)).toBe('Migration plan v2.md');
		expect(await readFile(path, 'utf8')).toBe(text);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
