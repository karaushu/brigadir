import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { hideChat } from './layout';
const desktop = resolve('apps/desktop');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
const wire = async (log: string) =>
	(await readFile(log, 'utf8').catch(() => ''))
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; params: any });

async function start(page: Page, text: string) {
	await page.getByRole('button', { name: 'New task · repository' }).click();
	await page.getByRole('textbox', { name: 'Message' }).fill(text);
	await page.getByRole('button', { name: 'Start', exact: true }).click();
}

/** spec/chat-turns-plans-and-questions#plan-approval: the plan for approval as a card, its menu, the copy in the editor, edits and feedback, then the folded row. */
test('a plan for approval reads as a card, opens as .md, sends edits and feedback, then folds @area:chat', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-plan-approval-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const log = join(root, 'wire.jsonl');
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: join(root, 'data'),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_FIXTURE_LOG: log,
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	try {
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		await page.getByRole('button', { name: 'Add a project…' }).click();
		await start(page, 'plan');
		const card = page.getByRole('region', { name: 'Plan for approval' });
		await expect(card).toBeVisible({ timeout: 20000 });
		await expect(
			card.getByRole('heading', { name: 'Keep the focus ring in Safari' })
		).toBeVisible();
		await expect(card).not.toContainText('planFilePath');
		await expect(card.getByText('Claude is waiting for approval')).toBeVisible();
		const whole = card.getByRole('button', { name: /^Whole plan · \d+ lines$/ });
		await expect(whole).toBeVisible();
		await whole.click();
		await expect(card.getByRole('button', { name: 'Collapse plan' })).toBeVisible();
		await expect(card.getByText(/^keep-the-focus-ring-in-safari-[0-9a-f]{8}\.md$/)).toBeVisible();

		// The chevron lists every allow option of the agent as it is; Esc closes it and returns focus.
		await card.getByRole('button', { name: 'How to approve' }).click();
		const menu = page.getByRole('menu', { name: 'How to approve' });
		await expect(menu.getByRole('menuitemradio')).toHaveText([
			'Yes, manually approve edits',
			'Yes, and use auto mode',
		]);
		await page.keyboard.press('Escape');
		await expect(menu).toHaveCount(0);
		await expect(card.getByRole('button', { name: 'How to approve' })).toBeFocused();
		for (const theme of ['dark', 'light'] as const) {
			await page.evaluate(async (appearance) => {
				const { settings } = await window.brigadir.readSettings();
				await window.brigadir.saveSettings({ ...settings, appearance });
			}, theme);
			await page.waitForTimeout(300);
			await card.screenshot({ path: info.outputPath(`plan-approval-${theme}.png`) });
		}

		// The copy opens in the editor; while the chat is hidden the request stays a row with a way back.
		await card.getByRole('button', { name: 'Open in editor' }).click();
		await expect(
			page.getByRole('tab', { name: /keep-the-focus-ring-in-safari-[0-9a-f]{8}\.md/ })
		).toBeVisible();
		// spec/task-window-workspace#layout-switch: the chat hides with its Layout switch; the request stays as a row over the work area.
		await hideChat(page);
		const notice = page.locator('[data-plan-approval-notice]');
		await expect(notice).toContainText('Plan for approval');
		const key = await page.evaluate(async () => {
			const task = (await window.brigadir.readWorkspace()).tasks[0]!;
			return { projectId: task.projectId, id: task.id };
		});
		const plans = join(root, 'data/projects', key.projectId, 'tasks', key.id, 'plans');
		const [file] = await readdir(plans);
		const edited = (await readFile(join(plans, file!), 'utf8')).replace(
			'- Chrome: the ring stays.',
			'- Chrome: the ring stays.\n- Edge: the ring stays.'
		);
		await writeFile(join(plans, file!), edited);
		await notice.getByRole('button', { name: 'Back to chat' }).click();
		await expect(card.getByText('edited in the editor')).toBeVisible({ timeout: 10000 });
		await expect(card.getByRole('button', { name: 'Approve plan' })).toHaveCount(0);
		await card.getByRole('button', { name: 'Send edits' }).click();
		await expect
			.poll(async () =>
				(await wire(log))
					.filter((entry) => entry.event === 'plan-result')
					.map((entry) => entry.params.outcome.optionId)
			)
			.toEqual(['reject']);
		await expect
			.poll(
				async () =>
					(await wire(log)).filter((entry) => entry.event === 'plan-prompt').at(-1)?.params ?? ''
			)
			.toContain('- Edge: the ring stays.');

		// The agent shows the plan again; Approve answers with its allow_once and the card folds.
		const again = page.locator('[data-plan-approval]');
		await expect(again).toHaveCount(1, { timeout: 20000 });
		await again.getByRole('button', { name: 'Approve plan' }).click();
		await expect
			.poll(async () =>
				(await wire(log))
					.filter((entry) => entry.event === 'plan-result')
					.map((entry) => entry.params.outcome.optionId)
			)
			.toEqual(['reject', 'exit-plan-default']);
		await expect(page.locator('[data-plan-approval-summary="approved"]')).toContainText(
			'The plan is approved'
		);
		await expect(page.locator('[data-plan-approval-summary="revision"]')).toHaveCount(1);
		// spec/chat-turns-plans-and-questions#plan-row: the checklist the agent keeps opens the approved plan in place, with the plan card's button.
		const checklist = page.locator('[data-plan-row]').last();
		const wholePlan = checklist.getByRole('button', { name: /^Whole plan · \d+ lines$/ });
		await expect(wholePlan).toBeVisible({ timeout: 10000 });
		await wholePlan.click();
		const read = page.locator('[data-plan-read-only]');
		await expect(
			read.getByRole('heading', { name: 'Keep the focus ring in Safari' })
		).toBeVisible();
		await expect(read).toContainText('Test that Tab keeps the ring.');
		await expect(checklist).not.toHaveAttribute('open', '');
		for (const theme of ['dark', 'light'] as const) {
			await page.evaluate(async (appearance) => {
				const { settings } = await window.brigadir.readSettings();
				await window.brigadir.saveSettings({ ...settings, appearance });
			}, theme);
			await page.waitForTimeout(300);
			await checklist.screenshot({ path: info.outputPath(`plan-checklist-${theme}.png`) });
			await read.screenshot({ path: info.outputPath(`plan-read-${theme}.png`) });
		}
		await read.getByRole('button', { name: 'Collapse plan' }).click();
		await expect(read).toHaveCount(0);
		await expect(checklist.getByRole('button', { name: /^Whole plan · / })).toHaveAttribute(
			'aria-expanded',
			'false'
		);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('a Codex plan comes from plan_update, and Plan further rejects with the person’s words @area:chat', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-plan-codex-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const log = join(root, 'wire.jsonl');
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: join(root, 'data'),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_FIXTURE_LOG: log,
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	try {
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		await page.getByRole('button', { name: 'Add a project…' }).click();
		await start(page, 'plan-codex');
		const card = page.getByRole('region', { name: 'Plan for approval' });
		await expect(card.getByRole('heading', { name: 'Keep the focus ring in Safari' })).toBeVisible({
			timeout: 20000,
		});
		await expect(page.locator('[data-plan-document]')).toHaveCount(0);
		await expect(card.getByRole('button', { name: 'How to approve' })).toHaveCount(0);
		await card.getByRole('button', { name: 'Plan further…' }).click();
		const field = card.getByRole('textbox', { name: 'What should change in the plan?' });
		await expect(field).toBeFocused();
		await field.fill('Keep the old outline for Firefox.');
		await page.keyboard.press('Meta+Enter');
		await expect
			.poll(async () =>
				(await wire(log))
					.filter((entry) => entry.event === 'plan-result')
					.map((entry) => entry.params.outcome.optionId)
			)
			.toEqual(['revise']);
		await expect
			.poll(
				async () =>
					(await wire(log)).filter((entry) => entry.event === 'plan-prompt').at(-1)?.params ?? ''
			)
			.toBe(
				'I did not approve the plan. Change it as follows, then present the revised plan for approval again:\n\nKeep the old outline for Firefox.'
			);
		const summary = page.locator('[data-plan-approval-summary="revision"]').first();
		await expect(summary).toContainText('Plan in revision');
		await expect(summary).toContainText('Keep the old outline for Firefox.');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

/** spec/chat-turns-plans-and-questions#plan-approval: `Approve plan` brings back the mode the session had before the plan — the agent's own option for `auto`, and
 *  `allow_once` plus the host's `set_mode` for `Accept edits`, which has no option while `auto` exists. */
test('Approve plan returns the session to its mode from before the plan @area:chat', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-plan-mode-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const log = join(root, 'wire.jsonl');
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: join(root, 'data'),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_FIXTURE_LOG: log,
			BRIGADIR_FIXTURE_SCENARIO: 'plan-modes',
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	const results = async () =>
		(await wire(log))
			.filter((entry) => entry.event === 'plan-result')
			.map((entry) => entry.params.outcome.optionId);
	try {
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		await page.getByRole('button', { name: 'Add a project…' }).click();
		await start(page, 'plan');
		const card = page.getByRole('region', { name: 'Plan for approval' });
		await expect(card).toBeVisible({ timeout: 20000 });
		// The chevron still lists every allow option; the tick is on the one Approve sends.
		await card.getByRole('button', { name: 'How to approve' }).click();
		const menu = page.getByRole('menu', { name: 'How to approve' });
		await expect(menu.getByRole('menuitemradio')).toHaveText([
			'Yes, clear context (12% used) and use auto mode',
			'Yes, and use auto mode',
			'Yes, and bypass permissions',
			'Yes, manually approve edits',
		]);
		await expect(
			menu.getByRole('menuitemradio', { name: 'Yes, and use auto mode' }).locator('svg')
		).toHaveCount(1);
		await page.keyboard.press('Escape');
		await card.getByRole('button', { name: 'Approve plan' }).click();
		await expect.poll(results).toEqual(['exit-plan-auto']);
		const approved = page.locator('[data-plan-approval-summary="approved"]');
		await expect(approved).toContainText('The plan is approved');
		await expect(approved).toContainText('· Auto');
		await approved.screenshot({ path: info.outputPath('plan-approved-auto.png') });

		await page.getByRole('textbox', { name: 'Message' }).fill('plan accept-edits');
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-plan-approval]')).toHaveCount(1, { timeout: 20000 });
		await page
			.locator('[data-plan-approval]')
			.getByRole('button', { name: 'Approve plan' })
			.click();
		await expect.poll(results).toEqual(['exit-plan-auto', 'exit-plan-default']);
		await expect
			.poll(async () =>
				(await wire(log))
					.filter((entry) => entry.event === 'mode')
					.map((entry) => entry.params.modeId)
			)
			.toEqual(['acceptEdits']);
		await expect(page.locator('[data-plan-approval-summary="approved"]').nth(1)).toContainText(
			'· Accept edits'
		);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
