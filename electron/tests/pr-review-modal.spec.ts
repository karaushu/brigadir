import { expect, test, type Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectCode } from './select-code';
import { fixturePRs, launchPRFixture } from './pr-fixture';
import { repoPRs, repoRow } from './repos';

/** Captures of the modal in both themes, for visual comparison (not asserted). */
async function shots(
	app: Awaited<ReturnType<typeof launchPRFixture>>['app'],
	page: Page,
	path: (name: string) => string,
	name: string
) {
	for (const theme of ['light', 'dark'] as const) {
		await app.evaluate(({ nativeTheme }, theme) => {
			nativeTheme.themeSource = theme;
		}, theme);
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
		await page
			.locator('[data-pr-review-modal]')
			.screenshot({ animations: 'disabled', path: path(`${name}-${theme}.png`) });
	}
	await app.evaluate(({ nativeTheme }) => {
		nativeTheme.themeSource = 'light';
	});
}

test('the review opens as a large modal: the summary writes itself into the step column, steps lead from reading to sending, and the panel shows the result (spec/appearance#evolution-redesign) @area:pr', async ({}, info) => {
	test.setTimeout(240000);
	const { app, close, page, errors, gh, setGh, root } = await launchPRFixture();
	try {
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		const footer = page.locator('[data-pr-review-footer]');
		await expect(footer).toContainText('No drafts');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await footer.screenshot({ path: info.outputPath(`0-footer-${theme}.png`) });
		}
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		// The way in names the window it opens: the zoom glyph after the name, no ▾.
		await footer.getByRole('button', { name: 'Start review', exact: true }).click();
		const modal = page.locator('[data-pr-review-modal="421"]');
		await expect(modal).toBeVisible();
		await expect(modal.getByRole('heading', { level: 2 })).toHaveText(
			'Review · Loyalty 1+1 in admin'
		);
		// The first open writes the summary by itself; the cache by head SHA is what Overview shows too. Step 1 «Read» is the
		// summary: it heads the column, no band over the steps (spec/appearance#evolution-redesign).
		const column = modal.locator('[data-review-column="1"]');
		const summary = column.getByRole('region', { name: 'Summary', exact: true });
		await expect(summary).toHaveAttribute('data-summary', 'ready', { timeout: 60000 });
		await expect(modal.getByRole('region', { name: 'Summary', exact: true })).toHaveCount(1);
		await expect(summary).toContainText('Loyalty 1+1: every second item is free');
		await expect(summary).toContainText('Risky spots · 1');
		await expect(summary).toContainText('the free item is the second by order');
		await expect(summary).toContainText('What to check · 0 of 2');
		await expect(summary).toContainText('What changed · 2');
		await expect(summary.locator('[data-summary-changed]')).toHaveCount(0);
		await expect(summary.locator('[data-summary-size]')).toContainText('~6 min');
		// «What to check» ticks are the reviewer's own: nothing goes to GitHub.
		await summary.getByRole('checkbox', { name: 'A cart of one item stays paid.' }).check();
		await expect(summary).toContainText('What to check · 1 of 2');
		// Risk badges on the files: ⚠ on the risky file, ✓ where the agent placed a check; the tooltip is the item.
		const files = modal.getByRole('group', { name: 'Files', exact: true });
		const risk = files.locator(
			'[data-pr-file="src/loyalty/LoyaltyRule.tsx"] [data-spot-badge="risk"]'
		);
		await expect(risk).toHaveAttribute(
			'title',
			'LoyaltyRule.tsx:6 — the free item is the second by order, not the cheapest one.'
		);
		await expect(
			files.locator('[data-pr-file="src/loyalty/LoyaltyRule.tsx"] [data-spot-badge="check"]')
		).toHaveCount(0);
		await expect(
			files.locator('[data-pr-file="src/loyalty/rules.ts"] [data-spot-badge="check"]')
		).toHaveCount(1);
		await shots(app, page, (name) => info.outputPath(name), '1-read');
		// A badge lands the diff on its line; so does a risk link of the column.
		await files.locator('[data-pr-file="src/loyalty/rules.ts"] [data-spot-badge="check"]').click();
		await expect(modal.locator('[data-pr-file="src/loyalty/rules.ts"]')).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		// The diff's own file row carries the same badge.
		await expect(modal.locator('[data-spot-badge="check"][role="button"]')).toBeVisible();
		await summary
			.getByRole('button', { name: 'Go to the code · LoyaltyRule.tsx:6', exact: true })
			.click();
		await expect(modal.locator('[data-pr-file="src/loyalty/LoyaltyRule.tsx"]')).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(modal.getByRole('log', { name: 'Diff', exact: true })).toBeVisible();
		// The diff's own row has the same layout controls as a diff tab: side by side and wrap (spec/appearance#evolution-redesign).
		const diff = modal.locator('[data-mode]').first();
		await modal.getByRole('radio', { name: 'Side by side', exact: true }).click();
		await expect(diff).toHaveAttribute('data-mode', 'sbs');
		await expect(diff).toHaveAttribute('data-wrap', 'true');
		await modal.getByRole('button', { name: 'Wrap lines', exact: true }).click();
		await expect(diff).toHaveAttribute('data-wrap', 'false');
		await modal.getByRole('radio', { name: 'Unified', exact: true }).click();
		await modal.getByRole('button', { name: 'Wrap lines', exact: true }).click();
		await expect(diff).toHaveAttribute('data-mode', 'unified');
		// «Viewed» from the diff's own row; the column counts it.
		await expect(column).toContainText('1 of 2 viewed');
		await modal
			.getByRole('checkbox', { name: 'Viewed · src/loyalty/rules.ts', exact: true })
			.click();
		await expect(column).toContainText('All 2 files viewed.');
		// Step 2: a code selection becomes a comment with its quote (spec/appearance#evolution-redesign).
		await column.getByRole('button', { name: 'Next: Comments', exact: true }).click();
		const comments = modal.locator('[data-review-column="2"]');
		await expect(comments).toContainText('No comments yet');
		// Steps 2–5: the summary is the «✦ Summary» tab beside the step, «What changed» open by file; the ticks stay.
		await expect(modal.getByRole('region', { name: 'Summary', exact: true })).toHaveCount(0);
		await comments.getByRole('tab', { name: 'Summary', exact: true }).click();
		const tab = comments.getByRole('region', { name: 'Summary', exact: true });
		await expect(tab).toHaveAttribute('data-summary', 'ready');
		await expect(tab.locator('[data-summary-changed]')).toContainText('exports the rule flag.');
		await expect(tab).toContainText('What to check · 1 of 2');
		await expect(
			comments.getByRole('button', { name: 'Next: Verdict', exact: true })
		).toBeVisible();
		await shots(app, page, (name) => info.outputPath(name), '2-summary-tab');
		await comments.getByRole('tab', { name: 'Comments · 0', exact: true }).click();
		await expect(comments).toContainText('No comments yet');
		await selectCode(modal.getByRole('log', { name: 'Diff', exact: true }), 'new', 10);
		await modal.getByRole('button', { name: 'Comment', exact: true }).last().click();
		await expect(modal.locator('[data-pr-new-comment] [data-code-quote]')).toBeVisible();
		await page.keyboard.type('Show the badge only when free > 0.');
		await modal
			.locator('[data-pr-new-comment]')
			.getByRole('button', { name: /Add to review/ })
			.click();
		await expect(comments.locator('[data-review-draft]')).toHaveCount(1);
		await expect(modal.locator('[data-review-step="2"]')).toContainText('1');
		await shots(app, page, (name) => info.outputPath(name), '2-comments');
		// Step 3: three decisions in plain words, the agent's hint over them.
		await modal.locator('[data-review-step="3"]').click();
		const verdict = modal.locator('[data-review-column="3"]');
		await expect(verdict).toContainText('The agent suggests Request changes', { timeout: 30000 });
		await verdict.getByText('Request changes', { exact: true }).click();
		await expect(verdict.getByRole('radio', { name: 'Request changes' })).toBeChecked();
		await shots(app, page, (name) => info.outputPath(name), '3-verdict');
		// Step 4: the reviewer's word, written from the drafts.
		await verdict.getByRole('button', { name: 'Next: Summary', exact: true }).click();
		const word = modal.locator('[data-review-column="4"]');
		await word.getByRole('button', { name: 'Generate from the drafts', exact: true }).click();
		await expect(word.getByRole('textbox', { name: 'Review comment', exact: true })).toHaveValue(
			'Two things before merge: the free item and the badge.'
		);
		await shots(app, page, (name) => info.outputPath(name), '4-summary');
		// Step 5: what GitHub gets; a failure keeps the drafts and points at the comment.
		await word.getByRole('button', { name: 'Next: Check', exact: true }).click();
		const check = modal.locator('[data-review-column="5"]');
		await expect(check.locator('[data-review-preview]')).toContainText('requested changes');
		await expect(check.locator('[data-review-preview]')).toContainText(
			'Show the badge only when free > 0.'
		);
		await shots(app, page, (name) => info.outputPath(name), '5-check');
		await setGh({ writeError: 'Line 10 no longer exists in the branch.' });
		await check.getByRole('button', { name: /Send the review/ }).click();
		await expect(check.getByRole('alert')).toContainText('GitHub did not accept the review');
		await expect(check.locator('[data-review-preview] [data-bad]')).toHaveCount(1);
		await shots(app, page, (name) => info.outputPath(name), '5-error');
		const pulls = join(root, 'data/projects/project/pull-requests'),
			file = (await readdir(pulls)).find(
				(name) => name.startsWith('review-') && name.endsWith('-421.json')
			)!;
		expect(JSON.parse(await readFile(join(pulls, file), 'utf8')).review.drafts).toHaveLength(1);
		await setGh({ writeError: null });
		await check.getByRole('button', { name: /Send again/ }).click();
		await expect(modal).toHaveCount(0);
		await expect(
			page.getByRole('status').filter({ hasText: 'Review sent to PR #421' })
		).toBeVisible();
		await expect(footer).toContainText('You requested changes · just now');
		await expect(footer.getByRole('button', { name: 'New review', exact: true })).toBeVisible();
		const writes = (await gh()).writes as { path?: string; body?: any }[];
		expect(writes.find((write) => write.path?.endsWith('/pulls/421/reviews'))?.body).toMatchObject({
			event: 'REQUEST_CHANGES',
			body: 'Two things before merge: the free item and the badge.',
			comments: [{ path: 'src/loyalty/LoyaltyRule.tsx', line: 10 }],
		});
		// Reopening reads the summary from the cache: no new agent call, the same text at once.
		await footer.getByRole('button', { name: 'New review', exact: true }).click();
		await expect(summary).toHaveAttribute('data-summary', 'ready');
		await expect(summary).toContainText('Loyalty 1+1: every second item is free');
		await page.keyboard.press('Escape');
		await expect(modal).toHaveCount(0);
		await footer.screenshot({ path: info.outputPath('6-footer-sent.png') });
		// A narrow window: files in a dropdown before the steps, no branch and no agent in the header.
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 760));
		await footer.getByRole('button', { name: 'New review', exact: true }).click();
		await expect(modal.getByRole('button', { name: /LoyaltyRule\.tsx/ }).first()).toBeVisible();
		await expect(modal.locator('[data-agent-review]')).toHaveCount(0);
		await shots(app, page, (name) => info.outputPath(name), '7-narrow');
		await page.keyboard.press('Escape');
		// Overview: «Start review» with the window glyph and the summary as ✦.
		await page.getByRole('button', { name: 'Overview', exact: true }).click();
		const overview = page.locator('[data-pr-overview="421"]');
		await expect(overview.getByRole('button', { name: 'Start review', exact: true })).toBeVisible();
		await overview.locator('header').screenshot({ path: info.outputPath('8-overview.png') });
		await overview.getByRole('button', { name: 'Start review', exact: true }).click();
		await expect(modal).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('Hand to the agent to fix stays a second exit of step 5: the drafts go to a fix task and to the PR as one comment (spec/appearance#evolution-redesign, spec/pull-requests-and-ci#review-modal) @area:pr', async ({}, info) => {
	test.setTimeout(180000);
	const { app, close, page, errors, gh, root } = await launchPRFixture();
	try {
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		await page
			.locator('[data-pr-review-footer]')
			.getByRole('button', { name: 'Start review', exact: true })
			.click();
		const modal = page.locator('[data-pr-review-modal="421"]');
		await modal.locator('[data-review-step="5"]').click();
		const check = modal.locator('[data-review-column="5"]');
		// Nothing to hand over: the exit is off and says why.
		await expect(check.getByRole('button', { name: 'Hand to the agent to fix' })).toBeDisabled();
		await modal.locator('[data-review-step="2"]').click();
		await selectCode(modal.getByRole('log', { name: 'Diff', exact: true }), 'new', 10);
		await modal.getByRole('button', { name: 'Comment', exact: true }).last().click();
		await page.keyboard.type('Hide the badge when free is 0.');
		await modal
			.locator('[data-pr-new-comment]')
			.getByRole('button', { name: /Add to review/ })
			.click();
		await modal.locator('[data-review-step="5"]').click();
		await expect(check).toContainText('makes the fixes in a worktree on feat/loyalty-admin');
		await expect(
			check.getByRole('checkbox', { name: 'Also send the comments to the PR' })
		).toBeChecked();
		await shots(app, page, (name) => info.outputPath(name), '5-agent-fix');
		await check.getByRole('button', { name: 'Hand to the agent to fix' }).click();
		await expect(modal).toHaveCount(0);
		await expect(
			page.getByRole('status').filter({ hasText: '1 comment handed to the agent' })
		).toBeVisible();
		const tasks = join(root, 'data/projects/project/tasks');
		let fix: any = null;
		for (const id of await readdir(tasks)) {
			const task = JSON.parse(await readFile(join(tasks, id, 'task.json'), 'utf8')).task;
			if (task.prReview?.mode === 'fix') fix = task;
		}
		expect(fix).toMatchObject({
			prReview: { number: 421 },
			launch: { isolation: 'worktree', baseRef: 'refs/brigadir-v2/pr/421' },
		});
		expect(fix.prompt).toContain(
			'src/loyalty/LoyaltyRule.tsx:10 (new side): Hide the badge when free is 0.'
		);
		const writes = (await gh()).writes as { path?: string; body?: any }[];
		expect(writes.find((write) => write.path?.endsWith('/pulls/421/reviews'))?.body).toMatchObject({
			event: 'COMMENT',
			comments: [{ line: 10, body: 'Hide the badge when free is 0.' }],
		});
		await expect(page.locator('[data-pr-review-footer]')).toContainText('No drafts');
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

/** spec/pull-requests-and-ci#review-drafts: a review task opens its PR in its own repos, and the review drafts belong to the PR, not to a task. */
const reviewTasks = async (root: string) => {
	const dir = join(root, 'data/projects/project/tasks'),
		found: any[] = [];
	for (const id of await readdir(dir)) {
		try {
			const task = JSON.parse(await readFile(join(dir, id, 'task.json'), 'utf8')).task;
			if (task.prReview) found.push(task);
		} catch {
			/* not written yet */
		}
	}
	return found;
};
test('Review with an agent from a worktree task opens the PR in the new task, and Back shows the list (spec/pull-requests-and-ci#review-drafts) @area:pr', async () => {
	test.setTimeout(240000);
	// #419 gets a head branch the remote has: a review fetches it.
	const { close, page, errors, root } = await launchPRFixture({
		prs: fixturePRs().map((pr) =>
			pr.number === 419 ? { ...pr, head: 'feat/loyalty-admin', base: 'staging' } : pr
		),
	});
	try {
		// A worktree review task of #421: its apps/admin repo has another id than the main tree's.
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		await page.getByRole('button', { name: 'Where the agent reviews', exact: true }).click();
		await page
			.getByRole('menu', { name: 'Review with an agent', exact: true })
			.getByRole('menuitemradio', { name: /In a worktree/ })
			.click();
		await page
			.getByRole('status')
			.filter({ hasText: 'started' })
			.getByRole('button', { name: 'Open', exact: true })
			.click();
		await expect
			.poll(
				async () =>
					(await reviewTasks(root)).find((task) => task.prReview.number === 421)?.preparation
						?.state,
				{ timeout: 90000 }
			)
			.toBe('ready');
		// Its snapshot holds the worktree's repo ids; the PR panel reads them from there.
		const worktreeReview = (await reviewTasks(root)).find((task) => task.prReview.number === 421)!;
		await expect
			.poll(
				async () =>
					readFile(
						join(root, 'data/projects/project/tasks', worktreeReview.id, 'snapshots.json'),
						'utf8'
					).then(
						(text) =>
							JSON.parse(text).scopes.some(
								(scope: { name: string; id: string }) =>
									scope.name === 'apps/admin' && scope.id !== worktreeReview.launch.scopes[0].id
							),
						() => false
					),
				{ timeout: 90000 }
			)
			.toBe(true);
		await page
			.locator('aside')
			.getByRole('button', { name: /Review #421/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		// Window focus re-reads the PR list (spec/pull-requests-and-ci#reading-and-refresh): now with the worktree's repo ids.
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect((await repoRow(page, 'apps/admin')).locator('[data-repo-prs]')).toBeVisible();
		await page.keyboard.press('Escape');
		// From that task, a quick review of another PR (#419): the clicked ref carries the worktree's repo id.
		await page.locator('[data-pr-panel="detail"] button[aria-label="Back to the list"]').click();
		await page.locator('[data-pr-row="419"]').click();
		await page.getByRole('button', { name: 'Where the agent reviews', exact: true }).click();
		await page
			.getByRole('menu', { name: 'Review with an agent', exact: true })
			.getByRole('menuitemradio', { name: /Quickly/ })
			.click();
		await page
			.getByRole('status')
			.filter({ hasText: 'Review #419' })
			.getByRole('button', { name: 'Open', exact: true })
			.click();
		const detail = page.locator('[data-pr-panel="detail"][data-pr-number="419"]');
		await expect(detail).toBeVisible();
		await expect(detail.getByText('Loading the PR from GitHub…', { exact: true })).toHaveCount(0);
		await expect(detail.getByText('The PR could not be read.', { exact: true })).toHaveCount(0);
		await expect(detail.locator('[data-pr-review-footer]')).toBeVisible();
		await detail.getByRole('button', { name: 'Back to the list', exact: true }).click();
		await expect(page.locator('[data-pr-row="419"]')).toBeVisible();
		await expect(page.getByText('No open PRs', { exact: true })).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('a draft written in the main tree is in a task of the project; my own PR cannot request changes (spec/pull-requests-and-ci#review-drafts) @area:pr', async () => {
	test.setTimeout(180000);
	const { close, page, errors, root } = await launchPRFixture();
	try {
		// The main tree writes the draft; the task the fixture opened shows it.
		const tree = await page.evaluate(() => window.brigadir.openMainTree('project'));
		const scopes = await page.evaluate(
				(task) => window.brigadir.readScopePanel(task.projectId, task.id),
				tree
			),
			admin = scopes.scopes.find((scope) => scope.name === 'apps/admin')!;
		await page.evaluate(
			({ tree, scopeId }) =>
				window.brigadir.addPullRequestDraft(
					tree as never,
					{ scopeId, number: 419 },
					{
						path: 'src/orders/csv.ts',
						side: 'RIGHT',
						line: 12,
						startLine: null,
						body: 'Quote the names.',
						replyTo: null,
					}
				),
			{ tree, scopeId: admin.id }
		);
		await page.evaluate(
			({ tree, scopeId }) =>
				window.brigadir.setPullRequestReview(
					tree as never,
					{ scopeId, number: 419 },
					{ event: 'REQUEST_CHANGES' }
				),
			{ tree, scopeId: admin.id }
		);
		const file = join(root, 'data/projects/project/pull-requests', `review-${admin.id}-419.json`);
		expect(JSON.parse(await readFile(file, 'utf8')).review.drafts).toHaveLength(1);
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="419"]').click();
		await expect(page.locator('[data-pr-draft-row]')).toContainText('Quote the names.');
		// The decision saved before is not one GitHub takes on my own PR: the review shows it off and falls back to a comment.
		const footer = page.locator('[data-pr-review-footer]');
		await footer.getByRole('button', { name: 'Continue review', exact: true }).click();
		const modal = page.locator('[data-pr-review-modal="419"]');
		await modal.locator('[data-review-step="3"]').click();
		const verdict = modal.locator('[data-review-column="3"]');
		await expect(verdict.getByRole('radio', { name: 'Request changes' })).toBeDisabled();
		await expect(verdict.getByRole('radio', { name: 'Comment' })).toBeChecked();
		await expect
			.poll(async () => JSON.parse(await readFile(file, 'utf8')).review.event)
			.toBe('COMMENT');
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});
