import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { defaultAppSettings as defaultSettings } from '../packages/core/src/settings';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	fixtureAgent = resolve('packages/transport/fixtures/agent.mjs');
const run = promisify(execFile);
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
// A git repo with one commit, a project on it, and the app with the fixture agent in its `crew` scenario.
const launchCrew = async (prefix: string) => {
	const root = await mkdtemp(join(tmpdir(), prefix)),
		repo = join(root, 'repo');
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
	const project = join(root, 'data/projects/project');
	await mkdir(project, { recursive: true });
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: join(root, 'data'),
			BRIGADIR_TEST_AGENT: fixtureAgent,
			BRIGADIR_FIXTURE_SCENARIO: 'crew',
		},
	});
	return { root, project, app };
};
const stopCrew = async (app: ElectronApplication, root: string) => {
	await app.close();
	await run('pkill', ['-f', root]).catch(() => {});
	await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};
const agent = (
	id: string,
	name: string,
	role: 'foreman' | 'developer' | 'reviewer',
	agents: unknown[] = [],
	checkedBy: string[] = []
) => ({
	id,
	name,
	role,
	provider: 'claude',
	requestedChoices: {},
	choiceNames: {},
	instructions: '',
	extraInstructions: '',
	zone: [],
	checkedBy,
	agents,
});
const crew = (name: string, children: unknown[]) => ({
	schemaVersion: 1,
	templateId: null,
	name,
	resolvedAt: '2026-10-01T10:00:00Z',
	root: agent('foreman', 'Foreman', 'foreman', children),
});
// The `admin` project with seeded tasks (no git), launched with the fixture agent.
const launchSeeded = async (
	prefix: string,
	seeds: ({ id: string } & Record<string, unknown>)[],
	settings: Record<string, unknown> = {}
) => {
	const root = await mkdtemp(join(tmpdir(), prefix)),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	const dir = join(data, 'projects', 'admin');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'admin', name: 'admin', path: repo } })
	);
	const write = async (task: { id: string } & Record<string, unknown>) => {
		const taskDir = join(dir, 'tasks', task.id);
		await mkdir(taskDir, { recursive: true });
		await writeFile(join(taskDir, 'task.json'), JSON.stringify({ schemaVersion: 1, task }));
	};
	for (const task of seeds) await write(task);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: { appearance: 'light', language: 'en', ...settings },
		})
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data, BRIGADIR_TEST_AGENT: fixtureAgent },
	});
	return { root, dir, app, write };
};
/** A Brigadir task from the launch sheet, the plan card, the worker inside the foreman card and the crew's service rows (spec/crew#task-type, spec/tasks#sheet-rail, spec/crew-templates-and-editor#after-launch, spec/crew#communication). */
test('launches a crew from the sheet, confirms the plan card and shows workers and reports @area:tasks', async ({}, info) => {
	test.setTimeout(240_000);
	const { root, project, app } = await launchCrew('brigadir-crew-ui-');
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.getByRole('button', { name: 'New task · repo' }).click();
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		await expect(sheet).toBeVisible();
		// Type segment in the header: Brigadir shows the crew row and the roster by name.
		await expect(sheet.locator('[data-crew-row]')).toHaveCount(0);
		await sheet.getByRole('radio', { name: 'Brigadir' }).click();
		await expect(sheet.locator('[data-crew-row]')).toBeVisible();
		// spec/crew#compose: the foreman composes by default; this test takes the built-in crew.
		await expect(sheet.getByRole('button', { name: 'Crew', exact: true })).toContainText(
			'Foreman composes'
		);
		await sheet.getByRole('button', { name: 'Crew', exact: true }).click();
		const list = sheet.getByRole('listbox', { name: 'Crew' }); // spec/crew#compose: «Foreman composes» first, then the templates.
		await expect(list.getByRole('option')).toHaveCount(3);
		await expect(list.getByRole('option').first()).toHaveText('Foreman composes');
		await expect(list.getByRole('option', { name: /^Crew/ })).toContainText('3');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`launch-crew-popup-${theme}.png`),
			});
		}
		await list.getByRole('option', { name: /^Crew/ }).click();
		await expect(sheet.getByRole('button', { name: 'Crew', exact: true })).toContainText('Crew');
		const roster = sheet.locator('[data-crew-roster]');
		await expect(roster).toContainText('Foreman');
		await expect(roster).toContainText('Developer 1');
		await expect(roster).toContainText('Reviewer');
		await expect(sheet.getByRole('button', { name: 'Set up…' })).toBeEnabled();
		// The fixture repo has no remote: base the foreman worktree on the local branch.
		await sheet.getByRole('button', { name: 'Base ref' }).click();
		await page.getByRole('option', { name: 'main', exact: true }).click();
		await sheet
			.getByRole('textbox', { name: 'Message' })
			.fill(
				'@call propose_plan {"summary":"One developer writes the output file, the other documents it. Two parts touch different folders, so the diffs can be reviewed one by one.","parts":[{"title":"Write output","agent":"Developer 1","prompt":"@write out/result.txt done","files":["out/**"]},{"title":"Document the output format","agent":"Developer 2","prompt":"Describe the format of out/result.txt in docs/output.md: one section per field, with an example line for each.\\nKeep the tone of the other files in docs/. Do not touch out/, the other worker owns it.\\nYour files: docs/**.","files":["docs/**"]}]}'
			);
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('launch-crew-dark.png'),
		});
		await sheet.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		// The foreman card carries the helmet and the worker count; the plan card waits for the human.
		const card = page.locator('[data-crew-card]');
		await expect(card).toHaveCount(1);
		await expect(card.getByTitle('Brigadir', { exact: true })).toBeVisible();
		const plan = page.locator('[data-plan-id]');
		await expect(plan).toBeVisible({ timeout: 60_000 });
		await expect(plan.getByRole('textbox', { name: 'Part 1' })).toHaveValue('Write output');
		await expect(
			plan.locator('[data-plan-part]').first().getByRole('button', { name: 'Agent' })
		).toContainText('Developer 1');
		await expect(plan).toContainText(
			'One developer writes the output file, the other documents it.'
		);
		// The plan waits for the person: the foreman's row in the sidebar says so, like a permission or a question does.
		const foremanRow = card.locator(':scope > div > [data-sidebar-task]').first();
		await expect(foremanRow).toHaveAttribute('data-status', 'needs-you');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await plan.screenshot({
				animations: 'disabled',
				path: info.outputPath(`plan-card-${theme}.png`),
			});
		}
		// spec/chat-turns-plans-and-questions#plan-row: the brief shows the worker prompt, idle agents in the footer (not blocking), edits in place with ⌘↩ and Esc.
		await page.mouse.move(0, 0);
		const part = plan.locator('[data-plan-part]').first();
		await expect(part).toContainText('@write out/result.txt done');
		await expect(part).toContainText('out/**');
		await expect(plan.locator('footer')).toContainText(
			'2 parts for 2 agents · Reviewer checks each'
		);
		await expect(plan.getByRole('button', { name: 'Start workers' })).toBeEnabled();
		await part.getByText('@write out/result.txt done').hover();
		await plan.getByRole('button', { name: 'Edit prompt · Prompt 1' }).click();
		const prompt = plan.getByRole('textbox', { name: 'Prompt 1' });
		await expect(prompt).toBeFocused();
		await prompt.press('End');
		await prompt.pressSequentially(' twice');
		await expect(prompt).toHaveValue('@write out/result.txt done twice');
		await prompt.press('Escape');
		await expect(prompt).toHaveCount(0);
		await expect(part).toContainText('@write out/result.txt done');
		await expect(part).not.toContainText('twice');
		await part.getByText('@write out/result.txt done').hover();
		await plan.getByRole('button', { name: 'Edit prompt · Prompt 1' }).click();
		await prompt.fill('@write out/result.txt done');
		await prompt.press('Meta+Enter');
		await expect(prompt).toHaveCount(0);
		await plan.getByRole('textbox', { name: 'Part 1' }).fill('');
		await expect(plan.getByRole('button', { name: 'Start workers' })).toBeDisabled();
		await expect(plan.locator('footer')).toContainText('Every part needs a title and a prompt.');
		await plan.getByRole('textbox', { name: 'Part 1' }).fill('Write output');
		// A part given to an agent that already has one: the difference stands under that part and blocks Start.
		const second = plan.locator('[data-plan-part]').nth(1);
		await expect(second.getByRole('button', { name: 'Whole prompt' })).toBeVisible();
		await second.getByRole('button', { name: 'Whole prompt' }).click();
		await expect(second.getByRole('button', { name: 'Collapse prompt' })).toBeVisible();
		await second.getByRole('button', { name: 'Agent' }).click();
		await page.getByRole('option', { name: 'Developer 1' }).click();
		await expect(
			second.locator('p', {
				hasText: 'Developer 1 already has part 1. One agent works on one part at a time.',
			})
		).toBeVisible();
		await expect(second).toHaveAttribute('data-warning', 'true');
		await expect(plan.locator('footer')).toContainText(
			'Part 2 does not match the crew. Fix before starting.'
		);
		await expect(plan.getByRole('button', { name: 'Start workers' })).toBeDisabled();
		await page.mouse.move(0, 0);
		await plan.screenshot({
			animations: 'disabled',
			path: info.outputPath('plan-card-blocked-dark.png'),
		});
		await second.getByRole('button', { name: 'Agent' }).click();
		await page.getByRole('option', { name: 'Developer 2' }).click();
		await expect(plan.getByRole('button', { name: 'Start workers' })).toBeEnabled();
		await plan.getByRole('textbox', { name: 'Part 1' }).fill('Write the output file');
		await plan.getByRole('button', { name: 'Start workers' }).click();
		await expect(page.locator('[data-plan-id]')).toHaveCount(0);
		await expect(page.getByText('Plan approved')).toHaveCount(1);
		await expect(foremanRow).not.toHaveAttribute('data-status', 'needs-you');
		// spec/chat-turns-plans-and-questions#plan-row: the decided plan folds into a summary on the card's place; the chevron lists the parts.
		const summary = page.locator('[data-plan-summary]');
		await expect(summary).toHaveAttribute('data-approved', 'true');
		await expect(summary.locator('summary')).toContainText('2 parts');
		await expect(summary.locator('summary')).toContainText('Developer 2');
		await summary.locator('summary').click();
		await expect(summary.locator('li').first()).toContainText('Write the output file');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await summary.screenshot({
				animations: 'disabled',
				path: info.outputPath(`plan-summary-${theme}.png`),
			});
		}
		const foremanId = (await readdir(join(project, 'tasks')))[0]!,
			journal = (await readFile(join(project, 'tasks', foremanId, 'events.jsonl'), 'utf8'))
				.trim()
				.split('\n')
				.map(
					(line) =>
						JSON.parse(line) as {
							event: { kind: string; approved?: boolean; parts?: { title: string }[] | null };
						}
				);
		expect(
			journal.find((record) => record.event.kind === 'crew.plan.resolved')?.event
		).toMatchObject({
			approved: true,
			parts: [{ title: 'Write the output file' }, { title: 'Document the output format' }],
		});
		// The foreman creates the worker; the sidebar shows it inside the card as `<agent> · <part>` with the provider glyph.
		const composer = page.getByRole('textbox', { name: 'Message' });
		await expect(composer).toBeEnabled({ timeout: 30_000 });
		await composer.fill(
			'@call create_worker_task {"agent":"Developer 1","title":"Write the output file","prompt":"@write out/result.txt done","files":["out/**"]}'
		); // The textarea stays enabled while the plan decision is in flight, and Enter is ignored until it lands; the submit button carries that guard.
		await expect(page.getByRole('button', { name: /^(Send|Add to queue)$/ })).toBeEnabled();
		await composer.press('Enter');
		// The reviewer starts with the developer: two rows inside the card.
		const workers = page.locator('[data-crew-workers] button'),
			worker = workers.first();
		await expect(workers).toHaveCount(2, { timeout: 60_000 });
		await expect(worker).toContainText('Developer 1 · Write the output file');
		await expect(workers.nth(1)).toContainText('Reviewer · checks Developer 1, Developer 2');
		await expect(page.locator('[data-crew-row="worker"]').first()).toBeVisible();
		const report = page.locator('[data-crew-row="report"]');
		await expect(report).toBeVisible({ timeout: 120_000 });
		await expect(report).toContainText('Developer 1 · Write the output file');
		await expect(report).toContainText('+1');
		await expect(report).toContainText('approved');
		await expect(card.locator('[title="Workers"]')).toHaveText('2');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`crew-running-${theme}.png`),
			});
		}
		// spec/crew#parts: the next part of Developer 1 goes into its one task — the same row with the new part's title, no new row.
		const developerId = await worker.getAttribute('data-sidebar-task');
		await composer.fill(`@call accept_task {"taskId":"${developerId}"}`);
		await composer.press('Enter');
		await expect(worker).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });
		await composer.fill(
			'@call create_worker_task {"agent":"Developer 1","title":"Write the second file","prompt":"@write out/second.txt done","files":["out/**"]}'
		);
		await composer.press('Enter');
		await expect(worker).toContainText('Developer 1 · Write the second file', { timeout: 60_000 });
		await expect(worker).toHaveAttribute('data-sidebar-task', developerId!);
		await expect(workers).toHaveCount(2);
		await expect(card.locator('[title="Workers"]')).toHaveText('2');
		// The activity gets the same service row as a new worker: Developer 1, its reviewer, then the next part.
		await expect(page.locator('[data-crew-row="worker"]')).toHaveCount(3);
		await expect(page.locator('[data-crew-row="worker"]').last()).toContainText(
			'Developer 1 · Write the second file'
		);
		await expect(worker).not.toHaveAttribute('data-status', 'completed', { timeout: 60_000 });
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await card.screenshot({
				animations: 'disabled',
				path: info.outputPath(`crew-next-part-${theme}.png`),
			});
		}
		// Collapsing the card shows the deck and hides the workers; the worker row opens the worker task.
		await card.getByRole('button', { name: 'Collapse crew' }).click();
		await expect(page.locator('[data-crew-workers]')).toHaveCount(0);
		await expect(card).toHaveAttribute('data-collapsed', 'true');
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('crew-collapsed-dark.png'),
		});
		// spec/sidebar#crew-collapse: the fold is the person's — opening the foreman, a reload of the renderer and sidebar.json keep it.
		await card.locator(`[data-sidebar-task="${foremanId}"]`).click();
		await expect(card).toHaveAttribute('data-collapsed', 'true');
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(root, 'data', 'sidebar.json'), 'utf8').catch(() => '{}'))
						.crewCollapsed
			)
			.toEqual([foremanId]);
		await page.reload();
		await expect(page.locator('[data-crew-card]')).toHaveAttribute('data-collapsed', 'true');
		await expect(page.locator('[data-crew-workers]')).toHaveCount(0);
		await card.getByRole('button', { name: 'Expand crew' }).click();
		await worker.click();
		await expect(page.locator('[data-crew-workers] button[aria-pressed="true"]')).toHaveCount(1);
		await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await stopCrew(app, root);
	}
});

test('shows the reviewer inside the foreman card and the check rows of both rounds @area:tasks', async ({}, info) => {
	test.setTimeout(240_000);
	const { root, app } = await launchCrew('brigadir-crew-ui-');
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: 'New task · repo' }).click();
		const sheet = page.getByRole('dialog');
		await sheet.getByRole('radio', { name: 'Brigadir' }).click();
		await sheet.getByRole('button', { name: 'Crew', exact: true }).click();
		await sheet
			.getByRole('listbox', { name: 'Crew' })
			.getByRole('option', { name: /^Crew/ })
			.click();
		await expect(sheet.locator('[data-crew-roster]')).toContainText('Reviewer');
		await sheet.getByRole('button', { name: 'Base ref' }).click();
		await page.getByRole('option', { name: 'main', exact: true }).click();
		await sheet
			.getByRole('textbox', { name: 'Message' })
			.fill(
				'@call propose_plan {"parts":[{"title":"Write output","agent":"Developer 1","prompt":"@write out/result.txt done","files":["out/**"]}]}'
			);
		await sheet.getByRole('button', { name: 'Start', exact: true }).click();
		const plan = page.locator('[data-plan-id]');
		await expect(plan).toBeVisible({ timeout: 60_000 });
		await plan.getByRole('button', { name: 'Start workers' }).click();
		const composer = page.getByRole('textbox', { name: 'Message' });
		await expect(composer).toBeEnabled({ timeout: 30_000 });
		await composer.fill(
			'@call create_worker_task {"agent":"Developer 1","title":"Write output","prompt":"@write out/result.txt done","files":["out/**"]}'
		);
		await expect(page.getByRole('button', { name: /^(Send|Add to queue)$/ })).toBeEnabled();
		await composer.press('Enter');
		const workers = page.locator('[data-crew-workers] button');
		await expect(workers).toHaveCount(2, { timeout: 60_000 });
		await expect(workers.nth(1)).toContainText('Reviewer · checks Developer 1, Developer 2');
		const checks = page.locator('[data-crew-row="review"]');
		await expect(checks.filter({ hasText: 'round 1 of 2' })).toBeVisible({ timeout: 90_000 });
		await expect(page.locator('[data-crew-row="review"][data-state="approved"]')).toBeVisible({
			timeout: 90_000,
		});
		await expect(checks).toHaveCount(2);
		const approvedReport = page.locator('[data-crew-row="report"]').filter({ hasText: 'approved' });
		await expect(approvedReport).toBeVisible({ timeout: 30_000 });
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`crew-review-${theme}.png`),
			});
		}
		expect(errors).toEqual([]);
	} finally {
		await stopCrew(app, root);
	}
});

/** spec/crew#compose: «Foreman composes» on the sheet, the crew in the plan card, its edit in the crew editor, and the approved crew in task.json. */
test('the foreman composes the crew in the plan card and the person edits it before approving @area:tasks', async ({}, info) => {
	test.setTimeout(240_000);
	const { root, project, app } = await launchCrew('brigadir-crew-compose-');
	const themes = async (name: string, shot: (path: string) => Promise<unknown>) => {
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await shot(info.outputPath(`${name}-${theme}.png`));
		}
	};
	const page = await app.firstWindow();
	try {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: 'New task · repo' }).click();
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		await sheet.getByRole('radio', { name: 'Brigadir' }).click();
		// The default, and the first entry of the Crew popup, above the templates.
		await expect(sheet.getByRole('button', { name: 'Crew', exact: true })).toContainText(
			'Foreman composes'
		);
		await sheet.getByRole('button', { name: 'Crew', exact: true }).click();
		const list = sheet.getByRole('listbox', { name: 'Crew' });
		await expect(list.getByRole('option')).toHaveCount(3);
		await expect(list.getByRole('option').first()).toHaveAccessibleName('Foreman composes');
		await themes('compose-popup', (path) => page.screenshot({ animations: 'disabled', path }));
		await list.getByRole('option', { name: 'Foreman composes' }).click();
		await expect(sheet.getByRole('button', { name: 'Crew', exact: true })).toContainText(
			'Foreman composes'
		);
		const roster = sheet.locator('[data-crew-roster] > *');
		await expect(roster).toHaveCount(1);
		await expect(roster.first()).toContainText('Foreman');
		await sheet.getByRole('button', { name: 'Base ref' }).click();
		await page.getByRole('option', { name: 'main', exact: true }).click();
		await sheet
			.getByRole('textbox', { name: 'Message' })
			.fill(
				'@call propose_plan {"summary":"One agent writes the file, a **reviewer** looks at it.\\n\\n- `out/**` belongs to API","crew":[{"name":"API","template":"Developer","summary":"Writes the output file","zone":["out/**"],"checkedBy":["Check"]},{"name":"Check","template":"Reviewer"}],"parts":[{"title":"Write output","agent":"API","prompt":"@write out/result.txt done","files":["out/**"]}]}'
			);
		await themes('compose-sheet', (path) => sheet.screenshot({ animations: 'disabled', path }));
		await sheet.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		// The crew above the parts and its checks.
		const plan = page.locator('[data-plan-id]');
		await expect(plan).toBeVisible({ timeout: 60_000 });
		// The foreman's reasoning is chat markdown, not raw `**`.
		const reasoning = plan.locator('[data-plan-summary-text]');
		await expect(reasoning.locator('strong')).toHaveText('reviewer');
		await expect(reasoning.locator('li code')).toHaveText('out/**');
		await expect(reasoning).not.toContainText('**reviewer**');
		const members = plan.locator('[data-crew-member]');
		await expect(members).toHaveCount(2);
		await expect(members.first()).toContainText('API');
		await expect(members.first()).toContainText('Developer');
		await expect(members.first()).toContainText('Writes the output file');
		await expect(members.first()).toContainText('out/**');
		await expect(members.nth(1)).toContainText('Reviewer');
		await expect(members.nth(1)).toContainText('checks API');
		await page.mouse.move(0, 0);
		await themes('compose-plan', (path) => plan.screenshot({ animations: 'disabled', path }));
		// The person renames the agent in the crew editor; the foreman's own settings stay.
		await plan.getByRole('button', { name: 'Edit crew…' }).click();
		const editor = page.getByRole('dialog', { name: 'Crew' });
		await expect(editor).toBeVisible();
		await expect(editor.locator('[data-crew-node]')).toHaveCount(3);
		await editor.locator('[data-crew-node]').first().click();
		await expect(editor.locator('[data-crew-root-locked]')).toBeVisible();
		await editor.locator('[data-crew-node]').filter({ hasText: 'API' }).click();
		await editor
			.locator('[data-crew-inspector]')
			.getByRole('textbox', { name: 'Name' })
			.fill('Backend');
		await editor.getByRole('button', { name: 'Done' }).click();
		await expect(editor).toHaveCount(0);
		await expect(members.first()).toContainText('Backend');
		await expect(plan.locator('[data-plan-crew]')).toHaveAttribute('data-edited', 'true');
		await expect(members.nth(1)).toContainText('checks Backend');
		// The part still names API: a difference until the part goes to Backend.
		await expect(plan.getByRole('button', { name: 'Start workers' })).toBeDisabled();
		await plan.locator('[data-plan-part]').first().getByRole('button', { name: 'Agent' }).click();
		await page.getByRole('option', { name: 'Backend' }).click();
		await expect(plan.getByRole('button', { name: 'Start workers' })).toBeEnabled();
		await plan.getByRole('button', { name: 'Start workers' }).click();
		await expect(page.locator('[data-plan-id]')).toHaveCount(0);
		// The approved crew is the task's crew; the palette is gone.
		const foremanId = (await readdir(join(project, 'tasks')))[0]!,
			taskFile = join(project, 'tasks', foremanId, 'task.json');
		await expect
			.poll(async () =>
				(
					JSON.parse(await readFile(taskFile, 'utf8')) as {
						task: { crew: { root: { agents: { name: string }[] } } };
					}
				).task.crew.root.agents.map((agent) => agent.name)
			)
			.toEqual(['Backend', 'Check']);
		expect(
			(JSON.parse(await readFile(taskFile, 'utf8')) as { task: { crew: { compose?: unknown } } })
				.task.crew.compose
		).toBeUndefined();
		const composer = page.getByRole('textbox', { name: 'Message' });
		await expect(composer).toBeEnabled({ timeout: 30_000 });
		await composer.fill(
			'@call create_worker_task {"agent":"Backend","title":"Write output","prompt":"@write out/result.txt done","files":["out/**"]}'
		);
		await expect(page.getByRole('button', { name: /^(Send|Add to queue)$/ })).toBeEnabled();
		await composer.press('Enter');
		const workers = page.locator('[data-crew-workers] button');
		await expect(workers.first()).toContainText('Backend · Write output', { timeout: 60_000 });
		expect(errors).toEqual([]);
	} finally {
		await stopCrew(app, root);
	}
});

/** spec/projects-and-board#person-tasks: the board and the list show the person's tasks; crew workers stay inside their foreman (spec/projects-and-board#project-screen, spec/projects-and-board#board). */
test('the project board and list hide crew workers, count live ones on the foreman card and clear only what they show @area:tasks', async ({}, info) => {
	test.setTimeout(120000);
	const at = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
	const worker = (id: string, title: string, node: string, status: string, minutes: number) => ({
		id,
		projectId: 'admin',
		title,
		prompt: title,
		status,
		crewTaskId: 'live',
		crewNodeId: node,
		parentTaskId: 'live',
		worktreeBranch: `brigadir/live-sse-updates-${id}`,
		updatedAt: at(minutes),
	});
	const seeds = [
		{
			id: 'live',
			projectId: 'admin',
			title: 'Live SSE updates',
			prompt: 'Live SSE updates for the admin',
			status: 'done',
			crew: crew('Live crew', [
				agent('d1', 'Developer 1', 'developer', [], ['rv']),
				agent('d2', 'Developer 2', 'developer', [], ['rv']),
				agent('rv', 'Reviewer', 'reviewer'),
			]),
			worktreeBranch: 'brigadir/live-sse-updates',
			updatedAt: at(1),
		},
		worker('wave0', 'Live updates wave 0: shared contract', 'd1', 'completed', 30),
		worker('wave1', 'Live updates wave 1: zustand handlers', 'd1', 'completed', 20),
		worker('logging', 'Live updates: debug logging', 'd2', 'working', 2),
		worker('asks', 'Live updates: reconnect policy', 'd2', 'needs-you', 3),
		worker('review', 'checks Developer 1, Developer 2', 'rv', 'working', 4),
		{
			id: 'shipped',
			projectId: 'admin',
			title: 'Shipped crew',
			prompt: 'Shipped crew',
			status: 'completed',
			crew: crew('Shipped', [agent('d1', 'Developer 1', 'developer')]),
			updatedAt: at(60),
		},
		{
			id: 'shipped-dev',
			projectId: 'admin',
			title: 'Shipped part',
			prompt: 'Shipped part',
			status: 'completed',
			crewTaskId: 'shipped',
			crewNodeId: 'd1',
			parentTaskId: 'shipped',
			updatedAt: at(61),
		},
		{
			id: 'mine',
			projectId: 'admin',
			title: 'Accepted by hand',
			prompt: 'Accepted by hand',
			status: 'completed',
			updatedAt: at(90),
		},
		{
			id: 'orphan',
			projectId: 'admin',
			title: 'Worker without a crew',
			prompt: 'Worker without a crew',
			status: 'completed',
			crewTaskId: 'gone',
			crewNodeId: 'd1',
			parentTaskId: 'gone',
			updatedAt: at(120),
		},
	];
	const { root, dir, app } = await launchSeeded('brigadir-board-crew-', seeds, {
		agents: { ...defaultSettings.agents, maxConcurrent: 4 },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.locator('aside').getByRole('button', { name: 'admin', exact: true }).click();
		const board = page.locator('[data-project-screen]'),
			column = (name: string) => board.locator(`[data-board-column=${name}]`),
			card = (id: string) => board.locator(`[data-board-task="${id}"]`);
		const cards = async (name: string) =>
			(
				await column(name)
					.locator('[data-board-task]')
					.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-board-task')))
			).sort();
		await expect(card('live')).toBeVisible();
		const shown = (id: string, title: string) => card(id).locator(`[title="${title}"]:visible`);
		for (const view of ['Board', 'List'] as const) {
			await board.getByRole('radio', { name: view, exact: true }).click();
			await expect(board.locator('[data-view]')).toHaveAttribute('data-view', view.toLowerCase());
			expect(await cards('progress')).toEqual(['live']);
			expect(await cards('completed')).toEqual(['mine', 'orphan', 'shipped']);
			expect(await cards('backlog')).toEqual([]);
			await expect(column('completed').locator('h2')).toContainText('3');
			await expect(column('progress').locator('h2')).toContainText('1');
			// The limit counts every agent, the workers included (spec/tasks#launch-sheet): three of them hold one now.
			await expect(column('progress').getByTitle('Concurrent agents', { exact: true })).toHaveText(
				'3 / 4'
			);
			// The helmet and the number of live workers replace the worker cards (spec/projects-and-board#board).
			await expect(shown('live', 'Brigadir').locator('[data-glyph=helmet]')).toBeVisible();
			await expect(shown('live', 'Active workers')).toHaveText('3');
			await expect(shown('shipped', 'Brigadir').locator('[data-glyph=helmet]')).toBeVisible();
			await expect(shown('shipped', 'Active workers')).toHaveCount(0);
			await expect(shown('mine', 'Agent').locator('[data-glyph=person]')).toBeVisible();
			await expect(shown('orphan', 'Agent').locator('[data-glyph=person]')).toBeVisible();
			await page.mouse.move(0, 0);
			await board.screenshot({ path: info.outputPath(`${view.toLowerCase()}-light.png`) });
		}
		// The sidebar keeps the crew tree: the workers stay inside the foreman card (spec/crew-templates-and-editor#crew-editor).
		const sidebarCard = page.locator('aside [data-crew-card=live]');
		for (const id of ['wave0', 'wave1', 'logging', 'asks', 'review'])
			await expect(sidebarCard.locator(`[data-sidebar-task=${id}]`)).toBeVisible();
		// A worker that needs the person brings its foreman under the Needs you filter, as in the sidebar.
		await page
			.locator('aside')
			.getByRole('button', { name: /^Filter by status/ })
			.click();
		await page.getByRole('menuitemradio', { name: /^Needs you/ }).click();
		expect(await cards('progress')).toEqual(['live']);
		expect(await cards('completed')).toEqual([]);
		await page
			.locator('aside')
			.getByRole('button', { name: /^Filter by status/ })
			.click();
		await page.getByRole('menuitemradio', { name: /^Needs you/ }).click();
		await expect(card('mine')).toBeVisible();
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({ ...settings, appearance: 'dark' });
		});
		await board.getByRole('radio', { name: 'Board', exact: true }).click();
		await page.waitForTimeout(270);
		await page.mouse.move(0, 0);
		await board.screenshot({ path: info.outputPath('board-dark.png') });
		await board.getByRole('radio', { name: 'List', exact: true }).click();
		await page.waitForTimeout(270);
		await board.screenshot({ path: info.outputPath('list-dark.png') });
		// The bridge call behind the removed «Clear the list» button still removes the three visible tasks; the shipped foreman takes its worker, the live foreman keeps its accepted ones.
		await app.evaluate(({ dialog }) => {
			(globalThis as any).clearPrompts = [];
			dialog.showMessageBox = async (...args: any[]) => {
				(globalThis as any).clearPrompts.push(args[1]);
				return { response: 1, checkboxChecked: false };
			};
		});
		await page.evaluate(() => window.brigadir.clearCompletedTasks(null));
		await page.reload();
		await expect(column('completed').locator('[data-board-task]')).toHaveCount(0);
		const prompt = await app.evaluate(
			() => (globalThis as any).clearPrompts[0] as { message: string; detail: string }
		);
		expect(prompt.message).toContain('3 tasks');
		const tasks = await page.evaluate(async () =>
			(await window.brigadir.readWorkspace()).tasks.map((task) => task.id).sort()
		);
		expect(tasks).toEqual(['asks', 'live', 'logging', 'review', 'wave0', 'wave1']);
		await expect(stat(join(dir, 'tasks', 'wave0', 'task.json'))).resolves.toBeTruthy();
		for (const id of ['wave0', 'wave1'])
			await expect(sidebarCard.locator(`[data-sidebar-task=${id}]`)).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await stopCrew(app, root);
	}
});

/** spec/crew#attention: a worker waiting for the person lifts needs-you onto its foreman on the board, in the list and in the sidebar. */
test('a waiting worker marks its foreman needs-you on the board, the list and the sidebar @area:tasks', async ({}, info) => {
	test.setTimeout(120000);
	const at = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
	const worker = (id: string, foreman: string, node: string, status: string, minutes: number) => ({
		id,
		projectId: 'admin',
		title: `${foreman} ${id}`,
		prompt: id,
		status,
		crewTaskId: foreman,
		crewNodeId: node,
		parentTaskId: foreman,
		updatedAt: at(minutes),
	});
	const crewOf = () =>
		crew('Crew', [
			agent('d1', 'Developer 1', 'developer'),
			agent('d2', 'Developer 2', 'developer'),
		]);
	const seeds = [
		{
			id: 'live',
			projectId: 'admin',
			title: 'Live SSE updates',
			prompt: 'Live SSE updates',
			status: 'done',
			crew: crewOf(),
			updatedAt: at(1),
		},
		worker('asks', 'live', 'd1', 'needs-you', 3),
		worker('logging', 'live', 'd2', 'working', 2),
		{
			id: 'calm',
			projectId: 'admin',
			title: 'Calm crew',
			prompt: 'Calm crew',
			status: 'done',
			crew: crewOf(),
			updatedAt: at(2),
		},
		worker('busy', 'calm', 'd1', 'working', 4),
		{
			id: 'blocked',
			projectId: 'admin',
			title: 'Waiting for my answer',
			prompt: 'Waiting for my answer',
			status: 'needs-you',
			updatedAt: at(10),
		},
		{
			id: 'quiet',
			projectId: 'admin',
			title: 'Turn finished',
			prompt: 'Turn finished',
			status: 'done',
			updatedAt: at(20),
		},
	];
	const { root, app, write } = await launchSeeded('brigadir-crew-attention-', seeds);
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const board = page.locator('[data-project-screen]'),
			card = (id: string) => board.locator(`[data-board-task="${id}"]`),
			aside = page.locator('aside');
		const header = (id: string) =>
				aside.locator(`[data-crew-card=${id}] [data-sidebar-task=${id}]`),
			row = (id: string) => aside.locator(`[data-sidebar-task=${id}]`);
		const open = async () => {
			await aside.getByRole('button', { name: 'admin', exact: true }).click();
			await expect(card('live')).toBeVisible();
		};
		await open();
		for (const view of ['Board', 'List']) {
			await board.getByRole('radio', { name: view, exact: true }).click();
			await expect(board.locator('[data-view]')).toHaveAttribute('data-view', view.toLowerCase());
			// The foreman keeps its own state line and carries the needs-you mark of a task that waits itself.
			await expect(card('live')).toHaveAttribute('data-crew-attention', 'needs-you');
			await expect(card('live')).toHaveAttribute('data-status', 'done');
			await expect(card('calm')).not.toHaveAttribute('data-crew-attention');
			// In progress puts it among needs-you: the two waiting cards first, then the quiet ones (activity orders inside).
			const order = await board
				.locator('[data-board-column=progress] [data-board-task]')
				.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-board-task')));
			expect(order.slice(0, 2).sort()).toEqual(['blocked', 'live']);
			expect(order.slice(2).sort()).toEqual(['calm', 'quiet']);
			await page.mouse.move(0, 0);
			await board.screenshot({ path: info.outputPath(`${view.toLowerCase()}-attention.png`) });
		}
		// Sidebar (spec/sidebar#project-groups): a waiting worker marks its foreman; folding the card hides its workers.
		await expect(aside.locator('[data-crew-card=live]')).toHaveAttribute(
			'data-crew-attention',
			'needs-you'
		);
		await expect(aside.locator('[data-crew-card=calm]')).not.toHaveAttribute('data-crew-attention');
		await aside
			.locator('[data-crew-card=live]')
			.getByRole('button', { name: 'Collapse crew', exact: true })
			.click();
		await expect(aside.locator('[data-crew-card=live]')).toHaveAttribute('data-collapsed', 'true');
		await expect(row('asks')).toHaveCount(0);
		await aside
			.locator('[data-crew-card=live]')
			.getByRole('button', { name: 'Expand crew', exact: true })
			.click();
		await expect(row('asks')).toBeVisible();
		// spec/sidebar#crew-collapse: opening a folded foreman keeps its card folded.
		const calm = aside.locator('[data-crew-card=calm]');
		await header('calm').click();
		await expect(header('calm')).toHaveAttribute('aria-pressed', 'true');
		await calm.getByRole('button', { name: 'Collapse crew', exact: true }).click();
		await header('live').click();
		await header('calm').click();
		await expect(header('calm')).toHaveAttribute('aria-pressed', 'true');
		await expect(calm).toHaveAttribute('data-collapsed', 'true');
		await row('blocked').click();
		await expect(row('blocked')).toHaveAttribute('aria-pressed', 'true');
		// The worker got its answer: the attention goes by itself.
		await write({ ...seeds[1]!, status: 'working' });
		await page.reload();
		await open();
		await expect(card('live')).not.toHaveAttribute('data-crew-attention');
		await expect(aside.locator('[data-crew-card=live]')).not.toHaveAttribute('data-crew-attention');
		expect(errors).toEqual([]);
	} finally {
		await stopCrew(app, root);
	}
});

/** spec/agents-and-providers#tools-awareness: a crew worker has the browser and the project commands of its own task, in its own worktree. */
test('a crew worker opens a page in its browser and runs a project command in its worktree @area:tasks', async ({}, info) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-worker-tools-'))),
		data = join(root, 'data'),
		repo = join(root, 'repo'),
		project = join(data, 'projects/project'),
		tree = join(data, 'worktrees/project/worker');
	await mkdir(repo, { recursive: true });
	await mkdir(tree, { recursive: true });
	await mkdir(project, { recursive: true });
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: {
				id: 'project',
				name: 'repo',
				path: repo,
				commands: [
					{ id: 'where', name: 'Where', command: 'pwd', repo: '', directory: '', agentRuns: true },
				],
			},
		})
	);
	const tasks = [
		{
			id: 'crew',
			title: 'Checkout page',
			crew: {
				schemaVersion: 1,
				templateId: null,
				name: 'Crew',
				resolvedAt: '2026-10-14T10:00:00Z',
				root: agent('root', 'Foreman', 'foreman', [agent('dev', 'UI', 'developer')]),
			},
		},
		{
			id: 'worker',
			title: 'Checkout form',
			crewTaskId: 'crew',
			crewNodeId: 'dev',
			parentTaskId: 'crew',
			launch: {
				isolation: 'worktree',
				branch: 'brigadir/checkout-form',
				baseRef: 'HEAD',
				setupCommand: '',
				scopes: [],
			},
		},
	];
	for (const task of tasks) {
		const dir = join(project, 'tasks', task.id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					projectId: 'project',
					status: 'done',
					provider: 'claude',
					transport: 'gui',
					...task,
				},
			})
		);
	}
	await writeFile(
		join(project, 'tasks/worker/worktree.json'),
		JSON.stringify({
			schemaVersion: 1,
			root: tree,
			state: 'ready',
			branch: 'brigadir/checkout-form',
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const server = createServer((_req, res) => {
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.end('<title>Checkout</title><h1>Checkout</h1><button>Pay</button>');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`, '--no-proxy-server'],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	let mcp: any;
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 950));
		// The worker's own task is on screen, as the browser of master needs it (spec/browser-and-simulator#opening-tabs).
		await page.locator('[data-sidebar-task="worker"]').click();
		const worker = { projectId: 'project', id: 'worker' };
		await page.evaluate((key) => window.brigadir.terminalCommand(key, { kind: 'list' }), worker);
		const hostFile = join(project, 'tasks/worker/host.json');
		await expect
			.poll(async () => {
				try {
					await readFile(hostFile);
					return true;
				} catch {
					return false;
				}
			})
			.toBe(true);
		const host = JSON.parse(await readFile(hostFile, 'utf8')),
			requireMcp = createRequire(resolve('packages/transport/package.json'));
		const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
		const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
		mcp = new Client({ name: 'worker-tools-fixture', version: '1.0.0' });
		await mcp.connect(
			new StdioClientTransport({
				command: resolve('apps/desktop/out/services/mcp-relay'),
				args: [],
				env: {
					...env,
					BRIGADIR_HOST_SOCKET: host.socket,
					BRIGADIR_HOST_INSTANCE: host.instance,
					BRIGADIR_PROJECT_ID: 'project',
					BRIGADIR_TASK_ID: 'worker',
					BRIGADIR_MCP_TOKEN: host.mcpToken,
				},
			})
		);
		// spec/agents-and-providers#tools-awareness: the worker learns its tools at initialize, the shared simulator among them only when that module is on.
		const instructions = mcp.getInstructions() as string;
		expect(instructions).toContain('browser_open');
		expect(instructions).toContain('commands_run');
		expect(instructions).not.toContain('simulator_');
		const names = ((await mcp.listTools()).tools as { name: string }[]).map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining(['browser_open', 'commands_run', 'ask_foreman']));
		expect(names).not.toContain('ask_user');
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const result = await mcp.callTool({ name, arguments: args });
			return { error: result.isError === true, text: String(result.content[0]?.text ?? '') };
		};
		const opened = await call('browser_open', { url });
		expect(opened.error, opened.text).toBe(false);
		await expect.poll(async () => (await call('browser_read')).text).toContain('Checkout');
		// The command runs in the worker's tree, not the project root.
		const listed = JSON.parse((await call('commands_list')).text) as {
			commands: { id: string; cwd: string }[];
		};
		expect(listed.commands[0]!.cwd).toBe(tree);
		const ran = await call('commands_run', { id: 'where' });
		expect(ran.error, ran.text).toBe(false);
		const result = JSON.parse(ran.text) as { state: string; cwd: string; output: string };
		expect(result.state).toBe('done');
		expect(result.output).toContain(tree);
		expect(result.output).not.toMatch(new RegExp(`${repo}\\s*$`, 'm'));
		await page.screenshot({ path: info.outputPath('worker-tools.png') });
	} finally {
		await mcp?.close().catch(() => {});
		await app.close();
		server.close();
		await rm(root, { recursive: true, force: true });
	}
});
