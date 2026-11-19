import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { defaultAppSettings } from '../packages/core/src/settings';
import { builtinAgentTemplates, templateLookup } from '../packages/core/src/crew';
import { crewPalette } from '../packages/core/src/crew-compose';

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
	await page.keyboard.insertText(text);
	await page.keyboard.press('Enter');
};

// spec/crew#auto-move: an Auto task in the project's checkout hires; the host moves it into a worktree, restarts there (a real host
// process), and the window follows the new host: the move's row, the workers and the composer's worktree line.
test('an Auto task without isolation moves into a worktree when it hires @area:crew', async () => {
	test.setTimeout(240_000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-auto-move-')),
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
	// The person's dirty file before the task.
	await writeFile(join(repo, 'notes.txt'), 'mine\n');
	const roles = crewPalette(
		builtinAgentTemplates,
		{ lookup: templateLookup([...builtinAgentTemplates]), defaultProvider: 'claude' },
		[]
	).templates;
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
				title: 'Client details',
				status: 'done',
				provider: 'claude',
				prompt: 'Client details',
				auto: { roles, budget: { minutes: 40, tokens: 400000 } },
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
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
		await page.getByText('Client details', { exact: true }).first().click();
		await page.getByRole('main').getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByText('The host is disconnected.')).toBeHidden({ timeout: 30_000 });
		const parts = [
			{
				title: 'API',
				role: 'Developer',
				zone: ['apps/api/**'],
				lines: 300,
				prompt: 'Build the API.',
			},
			{
				title: 'Web',
				role: 'Developer',
				zone: ['apps/web/**'],
				lines: 300,
				prompt: 'Build the web.',
			},
		];
		await send(
			page,
			[
				'@write apps/api/lead.ts export const lead = 1;',
				`@call hire_workers ${JSON.stringify({ summary: 'API and web are apart.', parts })}`,
			].join('\n')
		);
		const card = page.locator('[data-hire-id]');
		await expect(card).toBeVisible({ timeout: 60_000 });
		await card.getByRole('button', { name: 'Hire', exact: true }).click();
		// The host in the worktree finishes the hire; the window follows it without a reload.
		const row = page.locator('[data-crew-row="workspace-move"]');
		await expect(row).toHaveAttribute('data-state', 'moved', { timeout: 120_000 });
		await expect(row).toContainText('brigadir/client-details');
		await expect(page.locator('[data-hire-summary]')).toHaveAttribute('data-approved', 'true', {
			timeout: 60_000,
		});
		await expect(page.locator('[data-composer-environment]')).toHaveAttribute(
			'data-isolation',
			'worktree',
			{ timeout: 30_000 }
		);
		expect((await git('status', '--porcelain', '--untracked-files=all')).stdout.trim()).toBe(
			'?? notes.txt'
		);
	} finally {
		await app.close();
		await run('pkill', ['-f', root]).catch(() => {});
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
