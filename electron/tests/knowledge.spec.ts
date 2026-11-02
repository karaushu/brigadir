import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
test('project knowledge mines real questions, reviews before writes, preserves edits, and restores rejected proposals @area:tasks', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-knowledge-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		state = join(root, 'writer.json');
	await mkdir(repo);
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	for (const id of ['first', 'second']) {
		const task = {
			id,
			projectId: 'project',
			title: id === 'first' ? 'Build the screen' : 'Check the buttons',
			status: 'done',
			provider: 'claude',
			transport: 'gui',
			hasStarted: true,
		};
		const dir = join(data, 'projects/project/tasks', id);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'task.json'), JSON.stringify({ schemaVersion: 1, task }));
		const events = [
			{ kind: 'turn.started', text: task.title },
			{
				kind: 'question.requested',
				question: {
					id: 'q-' + id,
					header: 'Tests',
					question: 'How do we run the tests?',
					options: [],
					allowsFreeText: true,
					allowsMultiple: false,
				},
			},
			{
				kind: 'question.resolved',
				id: 'q-' + id,
				answer: { labels: [], text: 'Run pnpm test from the repository root.' },
			},
			{ kind: 'turn.completed', reason: 'end_turn' },
		];
		await writeFile(
			join(dir, 'events.jsonl'),
			events
				.map((event, index) =>
					JSON.stringify({ schemaVersion: 1, seq: index + 1, at: '2026-09-21T10:00:00Z', event })
				)
				.join('\n') + '\n'
		);
	}
	await writeFile(state, JSON.stringify({ mode: 'fail' }));
	const logs = async () => {
		try {
			return (await readFile(state + '.log', 'utf8'))
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	};
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
				BRIGADIR_TEST_KNOWLEDGE: resolve('packages/transport/fixtures/ghost.mjs'),
				BRIGADIR_TEST_GHOST_STATE: state,
			},
		});
	let app = await launch();
	const choose = async (application: ElectronApplication, label: string) =>
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
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const project = page.locator('aside').getByRole('button', { name: 'repository', exact: true });
		await project.click();
		const card = page.locator('[data-knowledge-card]');
		await expect(card).toHaveCount(1);
		await expect(card).toContainText('2 tasks');
		expect(await logs()).toEqual([]);
		await page.screenshot({
			path: info.outputPath('knowledge-card-light.png'),
			animations: 'disabled',
		});
		// A collapsed Add only expands and requests a preview; generation errors never write or retry themselves.
		const toasts = page.locator('[data-toast-region]');
		await card.getByRole('button', { name: 'Add', exact: true }).first().click();
		await expect(toasts.getByRole('alert')).toContainText('Could not generate the text.');
		await expect(card.getByRole('alert')).toHaveCount(0);
		await expect
			.poll(async () => (await logs()).filter((item) => item.event === 'prompt').length)
			.toBe(1);
		await expect(readFile(join(repo, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
		const editor = card.getByRole('textbox', { name: 'Addition', exact: true });
		await editor.fill('Keep this draft');
		await writeFile(
			state,
			JSON.stringify({ mode: 'reply', text: '## Tests\nRun `pnpm test` from the repository root.' })
		);
		await card.getByRole('button', { name: 'Generate again', exact: true }).click();
		await expect(editor).toHaveValue('## Tests\nRun `pnpm test` from the repository root.');
		expect((await logs()).filter((item) => item.event === 'prompt')).toHaveLength(2);
		await editor.fill('## Tests\nRun `pnpm test` before publishing.');
		await page.getByRole('radio', { name: 'List', exact: true }).click();
		await expect(editor).toHaveValue('## Tests\nRun `pnpm test` before publishing.');
		// The disclosure is interruptible and has real intermediate sizes.
		await card.getByRole('button', { name: 'Collapse', exact: true }).click();
		await page.waitForTimeout(260);
		const heights = await card.evaluate(async (node) => {
			const reveal = node
				.querySelector('[data-open]')!
				.closest('article')!
				.querySelector('div[data-open]')!;
			const button = [...node.querySelectorAll('button')].find((button) =>
				button.textContent?.includes('Show text')
			)!;
			button.click();
			const values: number[] = [];
			for (let i = 0; i < 20; i++) {
				await new Promise(requestAnimationFrame);
				values.push(reveal.getBoundingClientRect().height);
			}
			return values;
		});
		expect(heights.some((value) => value > 0 && value < Math.max(...heights))).toBe(true);
		await card.getByRole('button', { name: 'Collapse', exact: true }).click();
		await page.waitForTimeout(35);
		await card.getByRole('button', { name: 'Show text', exact: true }).click();
		await expect(editor).toBeVisible();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				path: info.outputPath(`knowledge-edit-${theme}.png`),
				animations: 'disabled',
			});
		}
		await page.emulateMedia({ reducedMotion: 'reduce' });
		expect(
			await card.locator('div[data-open]').evaluate((node) =>
				getComputedStyle(node)
					.transitionDuration.split(',')
					.every((value) => value.trim() === '0s')
			)
		).toBe(true);
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await card
			.getByRole('textbox', { name: 'Instruction file', exact: true })
			.fill('../outside.md');
		await card.getByRole('button', { name: 'Refresh preview', exact: true }).click();
		await expect(toasts.getByText('Could not read the instruction file.')).toBeVisible();
		await card.getByRole('textbox', { name: 'Instruction file', exact: true }).fill('CLAUDE.md');
		await card.getByRole('button', { name: 'Refresh preview', exact: true }).click();
		await expect(card.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
		await writeFile(join(repo, 'CLAUDE.md'), 'Existing instruction\n');
		await card.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(toasts.getByText('Could not add the text. Text saved.')).toBeVisible();
		await expect(editor).toHaveValue('## Tests\nRun `pnpm test` before publishing.');
		await card.getByRole('button', { name: 'Refresh preview', exact: true }).click();
		await card.getByRole('button', { name: 'Add', exact: true }).click();
		const added = page.locator('[data-knowledge-added]');
		await expect(added).toBeVisible();
		const after = 'Existing instruction\n\n## Tests\nRun `pnpm test` before publishing.\n';
		expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe(after);
		await expect(added).toContainText('Uncommitted change');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await page.screenshot({
				path: info.outputPath(`knowledge-added-${theme}.png`),
				animations: 'disabled',
			});
		}
		await added.getByRole('button', { name: 'Show the file' }).click();
		await expect(page.getByRole('dialog')).toContainText('Existing instruction');
		await page.keyboard.press('Escape');
		await expect(added.getByRole('button', { name: 'Show the file' })).toBeFocused();
		await writeFile(join(repo, 'CLAUDE.md'), after + 'Foreign edit\n');
		await added.getByRole('button', { name: 'Undo', exact: true }).click();
		await expect(toasts.getByText('Could not undo the addition.')).toBeVisible();
		expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe(after + 'Foreign edit\n');
		await writeFile(join(repo, 'CLAUDE.md'), after);
		await added.getByRole('button', { name: 'Undo', exact: true }).click();
		await expect(card).toBeVisible();
		expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe('Existing instruction\n');
		await card.getByRole('button', { name: 'Reject', exact: true }).first().click();
		await expect(card).toHaveCount(0);
		await choose(app, 'Project knowledge…');
		await project.click({ button: 'right' });
		const sheet = page.getByRole('dialog', { name: 'Project knowledge', exact: true });
		await expect(sheet).toContainText('How do we run the tests?');
		await page.screenshot({
			path: info.outputPath('knowledge-rejected-dark.png'),
			animations: 'disabled',
		});
		const beforeRestore = (await logs()).filter((item) => item.event === 'prompt').length;
		await sheet.getByRole('button', { name: 'Restore', exact: true }).click();
		await expect(sheet).toContainText('No rejected proposals');
		await page.keyboard.press('Escape');
		await expect(card).toBeVisible();
		await page.waitForTimeout(150);
		expect((await logs()).filter((item) => item.event === 'prompt')).toHaveLength(beforeRestore);
		await page.getByRole('button', { name: 'Project knowledge', exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect(editor).toBeVisible();
		await card.getByRole('button', { name: /Build the screen/ }).click();
		await expect(page.getByRole('log')).toContainText('Build the screen');
		await project.click();
		await expect(card).toBeVisible();
		expect(errors).toEqual([]);
		// Cancelling an explicit writer terminates the real fixture process and preserves the draft.
		await card.getByRole('button', { name: 'Show text', exact: true }).click();
		await expect(editor).toHaveValue('## Tests\nRun `pnpm test` from the repository root.');
		await expect(card.getByRole('button', { name: 'Generate again', exact: true })).toBeEnabled();
		await writeFile(state, JSON.stringify({ mode: 'hold' }));
		const beforeCalls = (await logs()).filter((item) => item.event === 'prompt').length;
		await card.getByRole('button', { name: 'Generate again', exact: true }).click();
		await expect
			.poll(async () => (await logs()).filter((item) => item.event === 'prompt').length)
			.toBe(beforeCalls + 1);
		const held = (await logs()).filter((item) => item.event === 'prompt').at(-1)!.pid;
		await page.locator('aside').getByRole('button', { name: 'All projects', exact: true }).click();
		await expect
			.poll(async () =>
				(await logs()).some((item) => item.event === 'terminated' && item.pid === held)
			)
			.toBe(true);
		await app.close();
		await writeFile(
			join(data, 'settings.json'),
			JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'uk' } })
		);
		await writeFile(
			state,
			JSON.stringify({ mode: 'reply', text: '## Тести\nЗапускай `pnpm test` перед публікацією.' })
		);
		app = await launch();
		const uk = await app.firstWindow();
		await uk.locator('aside').getByRole('button', { name: 'repository', exact: true }).click();
		const ukCard = uk.locator('[data-knowledge-card]');
		await expect(ukCard).toContainText('2 задачі');
		await uk.getByRole('button', { name: 'Знання проєкту', exact: true }).click();
		await expect(ukCard.getByRole('textbox', { name: 'Доповнення', exact: true })).toHaveValue(
			'## Тести\nЗапускай `pnpm test` перед публікацією.'
		);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(uk.locator('html')).toHaveAttribute('data-theme', theme);
			await uk.screenshot({
				path: info.outputPath(`knowledge-uk-${theme}.png`),
				animations: 'disabled',
			});
		}
		await ukCard.getByRole('button', { name: 'Додати', exact: true }).click();
		const ukAdded = uk.locator('[data-knowledge-added]');
		await expect(ukAdded).toBeVisible();
		const content = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
		await ukAdded.getByRole('button', { name: 'Закрити', exact: true }).focus();
		await uk.keyboard.press('Escape');
		await expect(ukAdded).toHaveCount(0);
		expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe(content);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
