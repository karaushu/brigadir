import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { defaultAppSettings } from '../packages/core/src/settings';

const run = promisify(execFile);
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	fixtureAgent = resolve('packages/transport/fixtures/agent.mjs');
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
const send = async (page: Page, text: string) => {
	const message = page.getByRole('textbox', { name: 'Message', exact: true });
	await message.click();
	await page.keyboard.type(text);
	await page.keyboard.press('Enter');
};

// spec/reviews#loop: the agent proposes, the person starts the review from the card, the reviewer's finding goes to the agent, the closure
// check passes; the strip, the chat rows and the sidebar's reviewer row follow it. Reviewer hosts are real processes.
test('a task is reviewed inside it before the PR @area:review', async () => {
	test.setTimeout(240_000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-task-review-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = (...args: string[]) =>
		run('git', args, {
			cwd: repo,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'T',
				GIT_AUTHOR_EMAIL: 't@x',
				GIT_COMMITTER_NAME: 'T',
				GIT_COMMITTER_EMAIL: 't@x',
			},
		});
	await git('init', '-q', '-b', 'main');
	await writeFile(join(repo, 'README.md'), 'hello\n');
	await git('add', '-A');
	await git('commit', '-q', '-m', 'init');
	const dir = join(data, 'projects/project');
	await mkdir(join(dir, 'tasks/task'), { recursive: true });
	await writeFile(
		join(dir, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(dir, 'tasks/task/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Write the output',
				status: 'done',
				provider: 'claude',
				prompt: 'Write the output',
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		// spec/reviews#who: with another provider signed in on this computer it would review; Codex off makes the reviewer a fresh session
		// of the task's own provider, which the fixture agent plays.
		JSON.stringify({
			schemaVersion: 1,
			settings: {
				appearance: 'light',
				language: 'en',
				agents: { ...defaultAppSettings.agents, enabled: { claude: true, codex: false } },
			},
		})
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: fixtureAgent,
			BRIGADIR_FIXTURE_SCENARIO: 'crew',
		},
	});
	try {
		const page = await app.firstWindow();
		await page.getByText('Write the output', { exact: true }).first().click();
		await page.getByRole('main').getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByText('The host is disconnected.')).toBeHidden({ timeout: 30_000 });
		await send(page, '@write out/result.txt done');
		await expect(page.getByText('wrote out/result.txt')).toBeVisible({ timeout: 60_000 });
		await send(page, '@call propose_review {"summary":"The output file is written."}');
		const card = page.locator('[data-review-proposal]');
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card).toContainText('The output file is written.');
		await card.getByRole('button', { name: 'Start review', exact: true }).click();
		// The strip over the composer follows the review; the findings count opens the findings.
		const strip = page.locator('[data-review-strip]');
		await expect(strip).toBeVisible({ timeout: 30_000 });
		await expect(page.locator('[data-review-row="findings"]')).toBeVisible({ timeout: 90_000 });
		await page
			.locator('[data-review-row="findings"]')
			.getByRole('button', { name: '1 finding' })
			.click();
		const details = page.locator('[data-review-details]');
		await expect(details).toContainText('Round 1: say hello instead');
		await expect(page.locator('[data-review-strip="passed"]')).toBeVisible({ timeout: 120_000 });
		await expect(page.locator('[data-review-row="passed"]')).toBeVisible();
		// The sidebar lists the reviewer under the task with its verdict.
		await expect(page.locator('[data-crew-card="task"]')).toContainText('Claude · Approved');
	} finally {
		await app.close();
		await run('pkill', ['-f', root]).catch(() => {});
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

// spec/reviews#plan-review: a presented plan starts its review by itself; the reviewer — a real host process on the task's own provider, which
// the fixture plays — reads the plan and the sources through MCP, its finding answers the plan, the revision passes the closure check, and the
// strip, the plan card's line and the chat rows follow it. `Approve plan` stays available all along.
test('a plan is reviewed before the person approves it @area:review', async ({}, info) => {
	test.setTimeout(240_000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-plan-review-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		log = join(root, 'wire.jsonl');
	await mkdir(repo);
	const git = (...args: string[]) =>
		run('git', args, {
			cwd: repo,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'T',
				GIT_AUTHOR_EMAIL: 't@x',
				GIT_COMMITTER_NAME: 'T',
				GIT_COMMITTER_EMAIL: 't@x',
			},
		});
	await git('init', '-q', '-b', 'main');
	await writeFile(join(repo, 'README.md'), 'hello\n');
	await git('add', '-A');
	await git('commit', '-q', '-m', 'init');
	const dir = join(data, 'projects/project');
	await mkdir(join(dir, 'tasks/task'), { recursive: true });
	await writeFile(
		join(dir, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(dir, 'tasks/task/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Focus ring',
				status: 'done',
				provider: 'claude',
				prompt: 'plan',
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		// spec/reviews#who: Codex off pins the reviewer to a fresh session of the task's own provider, which the fixture agent plays.
		JSON.stringify({
			schemaVersion: 1,
			settings: {
				appearance: 'light',
				language: 'en',
				agents: { ...defaultAppSettings.agents, enabled: { claude: true, codex: false } },
			},
		})
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: fixtureAgent,
			BRIGADIR_FIXTURE_LOG: log,
		},
	});
	const wire = async () =>
		(await readFile(log, 'utf8').catch(() => ''))
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { event: string; params: any });
	try {
		const page = await app.firstWindow();
		await page.getByText('Focus ring', { exact: true }).first().click();
		await page.getByRole('main').getByRole('button', { name: 'Start', exact: true }).click();
		const card = page.getByRole('region', { name: 'Plan for approval' });
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(page.locator('[data-review-row="started"]')).toBeVisible({ timeout: 30_000 });
		// The reviewer read the plan and the sources through the host, then the closure check approved the revision.
		await expect(page.locator('[data-review-strip="passed"]')).toBeVisible({ timeout: 150_000 });
		const calls = (await wire())
			.filter((entry) => entry.event === 'plan-review-call')
			.map((entry) => entry.params.name);
		expect(calls).toEqual([
			'read_plan',
			'read_sources',
			'submit_plan_review',
			'read_plan',
			'read_sources',
			'approve',
		]);
		const results = (await wire()).filter((entry) => entry.event === 'plan-result');
		expect(results[0]?.params.outcome.optionId).toBe('reject');
		expect(
			(await wire()).some(
				(entry) =>
					entry.event === 'plan-prompt' &&
					String(entry.params).includes('Claude left 1 finding in the plan review.')
			)
		).toBe(true);
		// Every event the review wrote reads back: the journal stays readable.
		await expect(page.getByText('Some data could not be read.')).toHaveCount(0);
		const strip = page.locator('[data-review-strip]');
		await expect(strip).toContainText('Review passed');
		await expect(strip).toContainText('1 finding');
		await expect(strip).toContainText('1 gap');
		await expect(page.locator('[data-review-row="findings"]')).toContainText('1 gap');
		// The plan card's line says the review passed; a click expands the strip on the plan's lists.
		const line = card.locator('[data-plan-review="passed"]');
		await expect(line).toContainText('Review passed');
		await line.getByRole('button', { name: 'Review passed' }).click();
		const details = page.locator('[data-review-details="plan"]');
		await expect(details.locator('[data-plan-list="ticket"]')).toContainText(
			'Firefox is not covered'
		);
		await expect(details.locator('[data-plan-list="gap"]')).toContainText(
			'Which browsers must keep the ring?'
		);
		for (const theme of ['dark', 'light'] as const) {
			await page.evaluate(async (appearance) => {
				const { settings } = await window.brigadir.readSettings();
				await window.brigadir.saveSettings({ ...settings, appearance });
			}, theme);
			await page.waitForTimeout(300);
			await page.screenshot({ path: info.outputPath(`plan-review-${theme}.png`) });
		}
		// The person approves the revised plan.
		await card.getByRole('button', { name: 'Approve plan' }).click();
		await expect
			.poll(async () =>
				(await wire())
					.filter((entry) => entry.event === 'plan-result')
					.map((entry) => entry.params.outcome.optionId)
			)
			.toEqual(['reject', 'exit-plan-default']);
	} finally {
		await app.close();
		await run('pkill', ['-f', root]).catch(() => {});
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
