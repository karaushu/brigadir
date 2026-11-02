import {
	_electron as electron,
	expect,
	test,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { t, type Locale } from '../packages/core/src/messages';
import { editorText } from './editor-text';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;

/** A task on the fixture agent; `scenario` and the hold timings come from the env (spec/composer-steering-queue-and-ghost#steering, spec/composer-steering-queue-and-ghost#steering-hold). */
async function launch(
	env: Record<string, string>,
	{ language = 'en', appearance = 'light' }: { language?: Locale; appearance?: string } = {}
) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-steering-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Steering task',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance, language } })
	);
	const base = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...base,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			...env,
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const l = (key: Parameters<typeof t>[1]) => t(language, key);
	await page.getByRole('button', { name: /Steering task/ }).click();
	await page.getByRole('button', { name: l('Start'), exact: true }).click();
	const message = page.getByRole('textbox', { name: l('Message'), exact: true });
	await expect(message).toHaveAttribute('aria-busy', 'false');
	return {
		app,
		page,
		errors,
		message,
		l,
		close: async () => {
			await app.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}
const menuEnabled = (app: ElectronApplication, id: string) =>
	app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.enabled, id);
const heldRow = (page: Page, text: string) =>
	page.getByRole('log').locator('[data-held]').filter({ hasText: text });

// spec/composer-steering-queue-and-ghost#steering: Enter during a turn sends the message into that turn; the queue deck never shows it.
test('a message sent during a turn goes into it and shows in the log, not in the queue @area:chat @smoke', async ({}, info) => {
	test.setTimeout(120000);
	const { page, errors, message, close } = await launch({
		BRIGADIR_FIXTURE_SCENARIO: 'steering',
		BRIGADIR_STEER_HOLD_MS: '300',
	});
	try {
		await message.fill('steer-wait');
		await message.press('Enter');
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
		await message.fill('make it faster');
		await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
		await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toHaveCount(0);
		await message.press('Enter');
		const log = page.getByRole('log');
		await expect(log).toContainText('heard: make it faster');
		await expect(log).toContainText('make it faster');
		await expect(page.getByRole('region', { name: 'Queued messages' })).toHaveCount(0);
		await expect.poll(() => editorText(message)).toBe('');
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		await page
			.locator('main')
			.screenshot({ animations: 'disabled', path: info.outputPath('steered.png') });
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

// spec/composer-steering-queue-and-ghost#steering-hold: the host holds the message until the step boundary; meanwhile the log row says so and offers Edit and Remove.
test('a held message waits for the agent and can be edited or removed; ⌘↩ and the send menu queue, the deck sends now @area:chat', async () => {
	test.setTimeout(120000);
	const { app, page, errors, message, close } = await launch({
		BRIGADIR_FIXTURE_SCENARIO: 'steering',
		BRIGADIR_STEER_HOLD_MS: '600000',
	});
	try {
		await message.fill('steer-wait');
		await message.press('Enter');
		const stop = page.getByRole('button', { name: 'Stop', exact: true }),
			send = page.getByRole('button', { name: 'Send', exact: true });
		await expect(stop).toBeVisible();
		await expect(send).toHaveCount(0);
		await expect(message).toHaveAttribute('aria-placeholder', '↩ send now · ⌘↩ to the queue');
		await expect(stop).toHaveAttribute('title', 'Stop · ⌘.');
		await message.fill('first thought');
		await expect(send).toHaveAttribute('title', 'Send now · ↩ · To the queue · ⌘↩');
		await expect(stop).toBeVisible();
		await message.press('Enter');
		const held = heldRow(page, 'first thought');
		await expect(held).toContainText('Waiting for the agent');
		await expect.poll(() => editorText(message)).toBe('');
		await expect(page.getByRole('region', { name: 'Queued messages' })).toHaveCount(0);
		// Edit: the row goes, the text comes back into the field.
		await held.getByRole('button', { name: 'Edit message', exact: true }).click();
		await expect(held).toHaveCount(0);
		await expect.poll(() => editorText(message)).toBe('first thought');
		await expect(message).toBeFocused();
		await message.press('Enter');
		await expect(held).toContainText('Waiting for the agent');
		await held.getByRole('button', { name: 'Remove message', exact: true }).click();
		await expect(held).toHaveCount(0);
		await expect(page.getByRole('log')).not.toContainText('first thought');
		// ⌘↩ is View ▸ Add to queue only for the focused composer with text; Submit (also ⌘↩) is off there.
		await message.fill('later');
		await message.focus();
		await expect.poll(() => menuEnabled(app, 'composer-queue')).toBe(true);
		expect(await menuEnabled(app, 'review-send')).toBe(false);
		expect(
			await app.evaluate(({ Menu }) => {
				const item = Menu.getApplicationMenu()!.getMenuItemById('composer-queue')!;
				return [item.label, item.accelerator];
			})
		).toEqual(['Add to queue', 'CmdOrCtrl+Enter']);
		// The send menu: right click, Escape returns focus to Send; «To the queue» queues.
		await send.click({ button: 'right' });
		const menu = page.getByRole('menu', { name: 'Send', exact: true });
		await expect(menu.getByRole('menuitem')).toHaveText([
			/Send now.*Sent at the agent’s next step.*↩/,
			/To the queue.*Sent after the turn ends.*⌘↩/,
		]);
		await page.keyboard.press('Escape');
		await expect(menu).toHaveCount(0);
		await expect(send).toBeFocused();
		await send.press('Shift+F10');
		await expect(menu.getByRole('menuitem', { name: /Send now/ })).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(menu.getByRole('menuitem', { name: /To the queue/ })).toBeFocused();
		await page.keyboard.press('Enter');
		const deck = page.getByRole('region', { name: 'Queued messages' });
		await expect(deck).toContainText('Queued · 1');
		await expect(deck).toContainText('later');
		await expect.poll(() => editorText(message)).toBe('');
		await expect(deck.getByRole('button', { name: 'Send now', exact: true })).toBeVisible();
		// Behind a queue Enter queues as well: the hint says so; ⌘↩ queues.
		await expect(message).toHaveAttribute('aria-placeholder', '↩ to the queue');
		await message.fill('second');
		await expect(send).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeVisible();
		await message.press('Meta+Enter');
		await expect(deck).toContainText('Queued · 2');
		await expect.poll(() => editorText(message)).toBe('');
		// «Send now» in the deck moves a queued message into the hold: it leaves the deck and waits in the log.
		await deck
			.locator('li')
			.filter({ hasText: 'later' })
			.getByRole('button', { name: 'Send now', exact: true })
			.click();
		await expect(deck).toContainText('Queued · 1');
		await expect(deck).not.toContainText('later');
		await expect(heldRow(page, 'later')).toContainText('Waiting for the agent');
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('a held message goes in at the step boundary: the row loses its status and buttons @area:chat', async () => {
	test.setTimeout(120000);
	const { page, errors, message, close } = await launch({
		BRIGADIR_FIXTURE_SCENARIO: 'steering',
		BRIGADIR_STEER_HOLD_MS: '600000',
		BRIGADIR_FIXTURE_TOOL_MS: '4000',
		BRIGADIR_FIXTURE_STEER_WAIT_MS: '8000',
	});
	try {
		await message.fill('tool-steer');
		await message.press('Enter');
		await expect(page.getByRole('log')).toContainText('Run tests');
		await message.fill('use the other file');
		await message.press('Enter');
		const row = page
			.getByRole('log')
			.locator('[data-held]')
			.filter({ hasText: 'use the other file' });
		await expect(row).toContainText('Waiting for the agent');
		await expect(page.getByRole('log')).toContainText('heard: use the other file');
		await expect(row).toHaveCount(0);
		await expect(
			page.getByRole('log').getByText('use the other file', { exact: true })
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Edit message', exact: true })).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('a held message behind a permission request arrives after the answer; Submit and Add to queue never share ⌘↩ @area:chat', async () => {
	test.setTimeout(120000);
	const { app, page, errors, message, close } = await launch({
		BRIGADIR_FIXTURE_SCENARIO: 'steering',
		BRIGADIR_STEER_HOLD_MS: '600000',
	});
	try {
		await message.fill('permission');
		await message.press('Enter');
		const card = page.locator('[data-permission-id]');
		await expect(card).toBeVisible();
		await message.fill('also this');
		await message.press('Enter');
		const held = heldRow(page, 'also this');
		await expect(held).toContainText('Sent after you answer the request');
		await expect(held.getByRole('button', { name: 'Remove message', exact: true })).toBeVisible();
		await message.fill('one more');
		await message.focus();
		await expect.poll(() => menuEnabled(app, 'composer-queue')).toBe(true);
		expect(await menuEnabled(app, 'review-send')).toBe(false);
		await card.getByRole('button', { name: 'Allow', exact: true }).focus();
		await expect.poll(() => menuEnabled(app, 'review-send')).toBe(true);
		expect(await menuEnabled(app, 'composer-queue')).toBe(false);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('without steering a message during a turn only queues: the hint and the button say so @area:chat', async () => {
	test.setTimeout(120000);
	const { app, page, errors, message, close } = await launch({});
	try {
		await message.fill('hold');
		await message.press('Enter');
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
		await expect(message).toHaveAttribute('aria-placeholder', '↩ to the queue');
		await message.fill('after');
		await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toHaveAttribute(
			'title',
			'Add to queue'
		);
		await page
			.getByRole('button', { name: 'Add to queue', exact: true })
			.click({ button: 'right' });
		await expect(page.getByRole('menu')).toHaveCount(0);
		await message.focus();
		await page.waitForTimeout(200);
		expect(await menuEnabled(app, 'composer-queue')).toBe(false);
		await message.press('Meta+Enter');
		await expect(page.getByRole('region', { name: 'Queued messages' })).toContainText('after');
		await expect(
			page
				.getByRole('region', { name: 'Queued messages' })
				.getByRole('button', { name: 'Send now', exact: true })
		).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});
