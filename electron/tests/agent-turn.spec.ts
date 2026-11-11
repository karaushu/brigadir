import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;

// One fixture task «Background task» driven by the fixture agent's `scenario`.
async function launch(scenario: string, extra: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-agent-turn-ui-')),
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
				title: 'Background task',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
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
			BRIGADIR_FIXTURE_SCENARIO: scenario,
			...extra,
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.getByRole('button', { name: /Background task/ }).click();
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	const message = page.getByRole('textbox', { name: 'Message', exact: true });
	await expect(message).toHaveAttribute('aria-busy', 'false');
	return {
		app,
		page,
		errors,
		root,
		message,
		close: async () => {
			await app.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}
const deck = (page: Page) => page.getByRole('region', { name: 'Background work' });

// spec/chat-turns-plans-and-questions#agent-started-turns: Claude Code begins a turn on its own after a background task. The fixture replays a live run's wire; the gate file
// lets the test look at the finished turn first. The log, the status row, Stop, the person's message and the footer behave
// as in any turn, and no person's row appears for it.
test("a turn the agent began on its own runs, takes the person's message and ends like any turn @area:chat", async ({}, info) => {
	test.setTimeout(120000);
	const gate = join(await mkdtemp(join(tmpdir(), 'brigadir-agent-turn-gate-')), 'gate');
	const { page, errors, message, close } = await launch('agent-turn', {
		BRIGADIR_FIXTURE_AGENT_TURN_HOLD: '1',
		BRIGADIR_FIXTURE_AGENT_TURN_GATE: gate,
		BRIGADIR_STEER_HOLD_MS: '300',
	});
	try {
		const log = page.getByRole('log'),
			stop = page.getByRole('button', { name: 'Stop', exact: true }),
			status = log.locator('[data-turn-status]');
		await message.fill('background');
		await message.press('Enter');
		await expect(log.locator('footer[aria-label="Turn 1"]')).toContainText('Done');
		await expect(stop).toHaveCount(0);
		await expect(status).toHaveCount(0);
		// The background command finishes: the agent works again, and the window says so.
		await writeFile(gate, '');
		await expect(stop).toBeVisible();
		await expect(status).toBeVisible();
		await expect(log).toContainText('both printe');
		await expect(log.locator('footer[aria-label="Turn 2"]')).toHaveCount(0);
		await page
			.locator('main')
			.screenshot({ animations: 'disabled', path: info.outputPath('agent-turn.png') });
		// Enter goes into that turn, which answers it and ends.
		await message.fill('also this');
		await message.press('Enter');
		await expect(log).toContainText('heard: also this');
		await expect(log.locator('footer[aria-label="Turn 2"]')).toContainText('Done');
		await expect(stop).toHaveCount(0);
		await expect(status).toHaveCount(0);
		await page
			.locator('main')
			.screenshot({ animations: 'disabled', path: info.outputPath('agent-turn-done.png') });
		expect(errors).toEqual([]);
	} finally {
		await close();
		await rm(join(gate, '..'), { recursive: true, force: true });
	}
});

// spec/chat-turns-plans-and-questions#background-commands, the Background strip: a command the agent left running after its turn. `background-live` runs a real command in its
// own process group that writes its output file, as Claude Code does; `background-done` replays a live run's wire, where the
// command ends and Claude goes on by itself (spec/chat-turns-plans-and-questions#agent-started-turns).
test('a background command: the deck over the island, its output, Stop; the footer chip and the sidebar line @area:chat', async () => {
	test.setTimeout(120000);
	const { page, errors, message, close } = await launch('background-live');
	try {
		await message.fill('run it');
		await message.press('Enter');
		const log = page.getByRole('log'),
			row = deck(page).locator('li');
		await expect(log.locator('footer[aria-label="Turn 1"]')).toContainText('Done');
		await expect(row).toHaveCount(1);
		await expect(row).toContainText('Wait five minutes');
		// The turn is over, the work is not: the footer chip and the sidebar card say so; the composer has no Stop.
		await expect(
			log.locator('footer[aria-label="Turn 1"] [data-background-chip="working"]')
		).toBeVisible();
		const card = page.locator('aside [data-task-background]');
		await expect(card).toContainText('Wait five minutes');
		await expect(
			page.locator('form').getByRole('button', { name: 'Stop', exact: true })
		).toHaveCount(0);
		// Output: the tail of the output file, read by the host; Esc closes it (rule 14).
		await deck(page).getByRole('button', { name: 'Output' }).click();
		const output = page.locator('[data-background-output]');
		await expect(output).toContainText('begin');
		await page.keyboard.press('Escape');
		await expect(output).toHaveCount(0);
		// Stop: the row leaves at once, the chip becomes the summary, the sidebar line goes.
		await deck(page).getByRole('button', { name: 'Stop' }).click();
		await expect(deck(page)).toHaveCount(0);
		await expect(
			log.locator('footer[aria-label="Turn 1"] [data-background-chip="interrupted"]')
		).toBeVisible();
		await expect(card).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});
test('the background command finishes and Claude goes on by itself: the row says it finished, then leaves @area:chat', async () => {
	test.setTimeout(120000);
	const { page, errors, message, close } = await launch('background-done');
	try {
		await message.fill('run it');
		await message.press('Enter');
		const log = page.getByRole('log');
		await expect(deck(page).locator('li')).toContainText('Print six ticks');
		await expect(log).toContainText('exit code 0');
		await expect(
			log.locator('footer[aria-label="Turn 1"] [data-background-chip="done"]')
		).toBeVisible();
		await expect(deck(page)).toHaveCount(0, { timeout: 8000 });
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

// spec/chat-turns-plans-and-questions#background-subagents: a subagent still running when its turn ends — the RFD form of claude-agent-acp. Its deck row
// opens its block in the log; Stop goes main → host → adapter as `session/cancel` on the child, and the row leaves when the adapter says it stopped.
test('a background subagent: the deck row, Open, the sidebar line, Stop @area:chat', async () => {
	const { page, errors, message, close } = await launch('subagents');
	try {
		await message.fill('subagent-rfd');
		await message.press('Enter');
		const row = deck(page).locator('[data-background-kind="subagent"]');
		await expect(row).toContainText('List files');
		await expect(page.locator('aside [data-task-background]')).toHaveText(
			'In the background · Subagent List files'
		);
		await row.getByRole('button', { name: 'Open' }).click();
		const log = page.getByRole('log', { name: 'Conversation' });
		await expect(log.getByText('Run ls.', { exact: true })).toBeVisible();
		await row.getByRole('button', { name: 'Stop' }).click();
		await expect(row).toHaveCount(0);
		await expect(page.locator('aside [data-task-background]')).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});
