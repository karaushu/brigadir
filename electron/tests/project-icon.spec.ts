import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { crc32, deflateSync } from 'node:zlib';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
/** An orange PNG (8 × 8 by default): the app icon «Found in the repo» finds. */
function orangePng(width = 8, height = width, rgb: [number, number, number] = [245, 158, 11]) {
	const size = width,
		row = Buffer.from([0, ...Array.from({ length: size }, () => rgb).flat()]),
		chunk = (type: string, body: Buffer) => {
			const length = Buffer.alloc(4),
				crc = Buffer.alloc(4),
				named = Buffer.concat([Buffer.from(type, 'ascii'), body]);
			length.writeUInt32BE(body.length);
			crc.writeUInt32BE(crc32(named));
			return Buffer.concat([length, named, crc]);
		},
		header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
		chunk('IEND', Buffer.alloc(0)),
	]);
}
/** spec/appearance#evolution-redesign, spec/sidebar#project-groups: the agent picks the icon (fixture model), the sidebar says so meanwhile; the picker changes it. */
test('the agent picks a project icon and «Project icon» changes it: search, colour, pick again, monogram, from repo @area:tasks', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-project-icon-')),
		data = join(root, 'data');
	const project = async (id: string, name: string, description: string) => {
		const repo = join(root, name);
		await mkdir(join(repo, 'assets'), { recursive: true });
		await writeFile(join(repo, 'package.json'), JSON.stringify({ name, description }));
		await writeFile(join(repo, 'README.md'), `# ${name}\n\nThe ${description}.\n`);
		await writeFile(join(repo, 'assets', 'icon.png'), orangePng());
		await mkdir(join(data, 'projects', id), { recursive: true });
		await writeFile(
			join(data, 'projects', id, 'project.json'),
			JSON.stringify({ schemaVersion: 1, project: { id, name, path: repo } })
		);
	};
	// «slow» keeps the fixture model thinking for 1.5 s; «unknown» answers a name outside Lucide.
	await project('couriers', 'couriers-slow', 'Courier app for deliveries');
	await project('odd', 'unknown-tool', 'Something odd');
	// A project whose icon the person chose still gets the agent's pick; its icon stays.
	await project('kept', 'kept-couriers', 'Courier app for deliveries');
	{
		const file = join(data, 'projects', 'kept', 'project.json'),
			doc = JSON.parse(await readFile(file, 'utf8'));
		doc.project.icon = { kind: 'lucide', name: 'hard-hat', color: 'yellow', by: 'person' };
		await writeFile(file, JSON.stringify(doc));
	}
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { language: 'en', appearance: 'light' } })
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
			BRIGADIR_ICON_PICK: '1',
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	const stored = async (id: string) =>
		JSON.parse(await readFile(join(data, 'projects', id, 'project.json'), 'utf8')).project;
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const button = page.locator('[data-project-icon-button=couriers]');
		// While the agent thinks: the spinner and «Picking an icon…» in the group header, no archive or «+».
		await expect(page.locator('[data-icon-picking]')).toHaveText('Picking an icon…');
		await expect(button).toHaveAttribute('data-picking', 'true');
		await expect(button.locator('[data-icon-name=truck]')).toBeVisible({ timeout: 20000 });
		await expect(page.locator('[data-icon-picking]')).toHaveCount(0);
		expect(await stored('couriers')).toMatchObject({
			icon: { kind: 'lucide', name: 'truck', color: 'orange', by: 'agent' },
			iconPick: { name: 'truck', suggested: ['bike', 'package', 'route'] },
		});
		await expect(button.locator('svg[data-lucide=truck] path').first()).toBeAttached();
		// A name outside the set: the monogram, written once so the next start does not ask again.
		await expect
			.poll(async () => (await stored('odd')).icon?.kind, { timeout: 20000 })
			.toBe('monogram');
		await expect(
			page.locator('[data-project-icon-button=odd] [data-project-icon=monogram]')
		).toHaveText('UT');
		await expect
			.poll(async () => (await stored('kept')).iconPick?.name, { timeout: 20000 })
			.toBe('truck');
		expect((await stored('kept')).icon).toEqual({
			kind: 'lucide',
			name: 'hard-hat',
			color: 'yellow',
			by: 'person',
		});
		// The start asks each project once: the answered ones are listed, the next start leaves them be.
		expect(JSON.parse(await readFile(join(data, 'project-icon-asks.json'), 'utf8')).asked).toEqual(
			expect.arrayContaining(['couriers', 'kept', 'odd'])
		);
		// spec/sidebar#project-groups: a click on the tile folds the project; the picker button is reached by keyboard (or the project menu).
		await page.locator('[data-project-icon-button=kept]').press('Enter');
		const kept = page.locator('[data-project-icon-picker=kept]');
		await expect(kept.locator('[data-icon-agent]')).toContainText('Picked by the agent');
		await expect(kept.locator('[data-icon-suggested=hard-hat]')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(kept).toHaveCount(0);
		// «Not picked by the agent» wraps beside «Ask the agent», not under it.
		await page.locator('[data-project-icon-button=odd]').press('Enter');
		const odd = page.locator('[data-project-icon-picker=odd]');
		await odd.getByRole('radio', { name: 'Icon', exact: true }).click();
		await expect(odd.locator('[data-icon-agent]')).toContainText('Not picked by the agent');
		const status = (await odd
				.locator('[data-icon-agent] [class*=agentTitle] > span')
				.boundingBox())!,
			ask = (await odd.locator('[data-icon-pick-again]').boundingBox())!;
		expect(ask.x - (status.x + status.width)).toBeGreaterThanOrEqual(8);
		await page.keyboard.press('Escape');
		await expect(odd).toHaveCount(0);

		// The picker: the agent's pick and its reason, the suggestions without the name outside Lucide.
		await button.press('Enter');
		const picker = page.locator('[data-project-icon-picker=couriers]');
		await expect(picker).toBeVisible();
		await expect(picker.locator('[data-icon-agent]')).toContainText('Picked by the agent');
		await expect(picker.locator('[data-icon-agent]')).toContainText(
			'Courier app: name and package.json description'
		);
		await expect(picker.locator('[data-icon-suggested]')).toHaveCount(4);
		await expect(picker.locator('[data-icon-suggested=truck]')).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(picker.locator('[data-icon-count]')).toHaveText('1,899');
		// The tabs are a 28 px row, the agent's line keeps clear of its button, three whole rows of icons.
		await expect(picker.getByRole('radiogroup', { name: 'Project icon' })).toHaveCSS(
			'height',
			'28px'
		);
		const besideButton = async () => {
			const title = (await picker
					.locator('[data-icon-agent] [class*=agentTitle] > span')
					.boundingBox())!,
				again = (await picker.locator('[data-icon-pick-again]').boundingBox())!;
			return again.x - (title.x + title.width);
		};
		expect(await besideButton()).toBeGreaterThanOrEqual(8);
		expect((await picker.locator('[data-icon-grid]').boundingBox())!.height).toBeCloseTo(106, 2);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await picker.screenshot({ path: info.outputPath(`project-icon-picker-${theme}.png`) });
		}
		// The search reads names and Lucide tags: «bicycle» is a tag of «bike».
		await picker.getByRole('searchbox', { name: 'Search icons' }).fill('bicycle');
		await expect(picker.locator('[data-icon-suggested]')).toHaveCount(0);
		await picker.locator('[data-icon-grid] [data-icon-cell=bike]').click();
		await expect(button.locator('[data-icon-name=bike]')).toBeVisible();
		await expect
			.poll(async () => (await stored('couriers')).icon)
			.toEqual({
				kind: 'lucide',
				name: 'bike',
				color: 'orange',
				by: 'person',
			});
		// The colour applies to the chosen icon.
		await picker.getByRole('radio', { name: 'Green', exact: true }).click();
		await expect(button.locator('[data-icon-color=green]')).toBeVisible();
		// «Pick again» asks the agent: its pick comes back.
		await picker.locator('[data-icon-pick-again]').click();
		await expect(button.locator('[data-icon-name=truck]')).toBeVisible({ timeout: 20000 });
		// Monogram: the tab is the choice; «Reset to monogram» has nothing left to do.
		await picker.getByRole('radio', { name: 'Monogram', exact: true }).click();
		await expect(button.locator('[data-project-icon=monogram]')).toHaveText('CS');
		await expect(picker.locator('[data-icon-reset]')).toBeDisabled();
		// Image ▸ Found in the repo: the app icon of the repo, a PNG made by main.
		await picker.getByRole('radio', { name: 'Image', exact: true }).click();
		await picker.locator('[data-icon-repo="assets/icon.png"]').click();
		await expect(button.locator('[data-project-icon=repo] img')).toBeVisible();
		expect((await stored('couriers')).icon).toMatchObject({
			kind: 'repo',
			path: 'assets/icon.png',
		});
		await expect(picker.locator('[data-icon-repo="assets/icon.png"]')).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await picker.locator('[data-icon-reset]').click();
		await expect(button.locator('[data-project-icon=monogram]')).toBeVisible();
		// Esc closes it and gives focus back to the icon (rule 14).
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(button).toBeFocused();
		// spec/sidebar#project-groups: «Project icon…» in the project's context menu opens the same picker.
		await app.evaluate(({ Menu }) => {
			const state = globalThis as any;
			Menu.prototype.popup = function (options) {
				state.menu = this;
				state.menuClosed = options?.callback;
			};
		});
		await page.locator('aside [aria-label="couriers-slow"]').click({ button: 'right' });
		await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).menu))).toBe(true);
		expect(
			await app.evaluate(() => (globalThis as any).menu.items.map((item: any) => item.label))
		).toEqual([
			'New task',
			'Open main tree',
			'Project knowledge…',
			'Project icon…',
			'Show in file manager',
			'Copy path',
			'',
			'Remove project…',
		]);
		await app.evaluate(() => {
			const state = globalThis as any;
			state.menu.items.find((item: any) => item.label === 'Project icon…').click();
			state.menuClosed?.();
			state.menu = null;
		});
		await expect(picker).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
/** A fake `codex exec`: reads the prompt, saves a PNG where Codex saves its images and finishes the turn (spec/projects-and-board#project-icon). */
const fakeCodex = `
const { copyFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
	const thread = '01a16938-3731-7f50-b491-8675b25debde',
		folder = join(process.env.CODEX_HOME, 'generated_images', thread);
	writeFileSync(join(process.env.CODEX_HOME, 'prompt.txt'), prompt);
	process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: thread }) + '\\n');
	setTimeout(() => {
		mkdirSync(folder, { recursive: true });
		copyFileSync(process.env.FAKE_CODEX_PNG, join(folder, 'exec-1.png'));
		process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
	}, 1200);
});
`;
/** spec/projects-and-board#project-icon: the Image tab — the person's own image becomes `icon.png` in the project's data; Codex draws one too. */
test('«Project icon» ▸ Image: your own image is copied into the project data, and Codex generates one @area:tasks', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-project-image-')),
		data = join(root, 'data'),
		repo = join(root, 'couriers'),
		codexHome = join(root, 'codex-home');
	await mkdir(repo, { recursive: true });
	await mkdir(codexHome, { recursive: true });
	await writeFile(join(repo, 'package.json'), JSON.stringify({ description: 'Courier app' }));
	await mkdir(join(data, 'projects', 'couriers'), { recursive: true });
	await writeFile(
		join(data, 'projects', 'couriers', 'project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: {
				id: 'couriers',
				name: 'couriers',
				path: repo,
				icon: { kind: 'lucide', name: 'truck', color: 'orange', by: 'person' },
			},
		})
	);
	await writeFile(join(data, 'project-icon-asks.json'), JSON.stringify({ asked: ['couriers'] }));
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { language: 'en', appearance: 'light' } })
	);
	// A wide picture: it is cut to its centre square. Codex's image is blue.
	const picture = join(root, 'logo.png'),
		drawn = join(root, 'drawn.png'),
		script = join(root, 'codex.js');
	await writeFile(picture, orangePng(30, 20));
	await writeFile(drawn, orangePng(64, 64, [37, 99, 235]));
	await writeFile(script, fakeCodex);
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
			BRIGADIR_TEST_CODEX_IMAGE: script,
			CODEX_HOME: codexHome,
			FAKE_CODEX_PNG: drawn,
		},
	});
	const stored = async () =>
		JSON.parse(await readFile(join(data, 'projects', 'couriers', 'project.json'), 'utf8')).project;
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const button = page.locator('[data-project-icon-button=couriers]');
		await expect(button.locator('[data-icon-name=truck]')).toBeVisible({ timeout: 20000 });
		await button.press('Enter');
		const picker = page.locator('[data-project-icon-picker=couriers]');
		await picker.getByRole('radio', { name: 'Image', exact: true }).click();
		await expect(picker.locator('[data-icon-own]')).toContainText('No image yet');
		await expect(picker.locator('[data-icon-own]')).toBeDisabled();
		// «Choose file…»: the picture becomes the icon and a square PNG in the project's folder.
		await picker.locator('[data-icon-file]').setInputFiles(picture);
		await expect(button.locator('[data-project-icon=image] img')).toBeVisible();
		expect(await stored()).toMatchObject({
			icon: { kind: 'image', by: 'person', color: 'orange' },
		});
		const saved = await readFile(join(data, 'projects', 'couriers', 'icon.png'));
		expect(saved.subarray(1, 4).toString()).toBe('PNG');
		expect([saved.readUInt32BE(16), saved.readUInt32BE(20)]).toEqual([20, 20]);
		await expect(picker.locator('[data-icon-own]')).toContainText('Your image');
		await expect(picker.locator('[data-icon-own]')).toHaveAttribute('aria-pressed', 'true');
		// Another icon, then back: the file stays and «Your image» brings it back.
		await picker.getByRole('radio', { name: 'Monogram', exact: true }).click();
		await expect(button.locator('[data-project-icon=monogram]')).toBeVisible();
		await picker.getByRole('radio', { name: 'Image', exact: true }).click();
		await expect(picker.locator('[data-icon-own]')).toHaveAttribute('aria-pressed', 'false');
		await picker.locator('[data-icon-own]').click();
		await expect(button.locator('[data-project-icon=image] img')).toBeVisible();
		// «Generate with Codex»: the hint goes into the prompt, «Generating…» meanwhile, the image is the icon after.
		await picker.locator('[data-icon-hint]').fill('a scooter');
		await picker.locator('[data-icon-generate]').click();
		await expect(picker.locator('[data-icon-own]')).toContainText('Generating…');
		await expect(picker.locator('[data-icon-generate]')).toBeDisabled();
		await expect(picker.locator('[data-icon-own]')).toContainText('Drawn by Codex', {
			timeout: 20000,
		});
		expect(await stored()).toMatchObject({ icon: { kind: 'image', by: 'agent' } });
		const prompt = await readFile(join(codexHome, 'prompt.txt'), 'utf8');
		expect(prompt).toContain('image generation tool');
		expect(prompt).toContain('"wanted":"a scooter"');
		expect(prompt).toContain('"description":"Courier app"');
		const generated = await readFile(join(data, 'projects', 'couriers', 'icon.png'));
		expect([generated.readUInt32BE(16), generated.readUInt32BE(20)]).toEqual([64, 64]);
		// Codex's own image folder of that thread is gone.
		await expect
			.poll(() =>
				readFile(
					join(codexHome, 'generated_images', '01a16938-3731-7f50-b491-8675b25debde', 'exec-1.png')
				).then(
					() => true,
					() => false
				)
			)
			.toBe(false);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await picker.screenshot({ path: info.outputPath(`project-icon-image-${theme}.png`) });
		}
		// Codex off in Settings ▸ Agents: nothing runs, the toast says so.
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({
				...settings,
				agents: { ...settings.agents, enabled: { ...settings.agents.enabled, codex: false } },
			});
		});
		await picker.locator('[data-icon-generate]').click();
		await expect(page.getByText('Codex is not available.')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		expect(errors).toEqual([]);
		await app.close();
		// Ukrainian is longer: the row keeps the image, its note and «Вибрати файл…» inside the picker.
		await writeFile(
			join(data, 'settings.json'),
			JSON.stringify({ schemaVersion: 1, settings: { language: 'uk', appearance: 'light' } })
		);
		const again = await electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: { ...env, BRIGADIR_DATA_DIR: data },
		});
		try {
			const page = await again.firstWindow();
			await page.locator('[data-project-icon-button=couriers]').press('Enter');
			const picker = page.locator('[data-project-icon-picker=couriers]');
			await expect(picker.getByRole('radio', { name: 'Зображення', exact: true })).toBeChecked();
			await expect(picker.locator('[data-icon-own]')).toContainText('Намалював Codex');
			const box = (await picker.boundingBox())!,
				row = (await picker.locator('[data-icon-own]').boundingBox())!,
				choose = (await picker.locator('[data-icon-choose]').boundingBox())!;
			await expect(picker.locator('[data-icon-choose]')).toHaveText('Вибрати файл…');
			expect(choose.x).toBeGreaterThanOrEqual(row.x + row.width);
			expect(choose.x + choose.width).toBeLessThanOrEqual(box.x + box.width);
			await picker.screenshot({ path: info.outputPath('project-icon-image-uk.png') });
		} finally {
			await again.close();
		}
	} finally {
		await app.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
