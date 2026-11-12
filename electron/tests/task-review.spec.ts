import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

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

// spec/diff-and-review#agent-review: the agent proposes, the person starts the review from the card, the reviewer's comment goes to the agent, round 2
// passes; the strip, the chat rows, the Changes button and the sidebar's reviewer row follow it. Reviewer hosts are real processes.
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
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
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
		// The strip over the composer follows the review; its count opens the comments.
		const strip = page.locator('[data-review-strip]');
		await expect(strip).toBeVisible({ timeout: 30_000 });
		await expect(page.locator('[data-review-row="comments"]')).toBeVisible({ timeout: 90_000 });
		await page
			.locator('[data-review-row="comments"]')
			.getByRole('button', { name: '1 comment' })
			.click();
		const details = page.locator('[data-review-details]');
		await expect(details).toContainText('Round 1: say hello instead');
		await expect(page.locator('[data-review-strip="passed"]')).toBeVisible({ timeout: 120_000 });
		await expect(page.locator('[data-review-row="approved"]')).toBeVisible();
		// The Changes button says the changes are reviewed; the sidebar lists the reviewer under the task.
		await expect(page.locator('[data-crew-card="task"]')).toContainText('Reviewer');
	} finally {
		await app.close();
		await run('pkill', ['-f', root]).catch(() => {});
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
