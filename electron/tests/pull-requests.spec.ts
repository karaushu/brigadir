import { expect, test, type Page } from '@playwright/test';
import { selectCode } from './select-code';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchPRFixture, fixturePRs } from './pr-fixture';
import { openPanelTab } from './layout';
import { openMainTree, openRepos, repoPRs, repoRow, reposPopover } from './repos';

test('repo rows count PRs without words, the PR panel groups them and a PR opens with its tabs (spec/pull-requests-and-ci#repo-counter, spec/projects-and-board#projects) @area:pr', async () => {
	test.setTimeout(120000);
	const { app, close, page, errors, gh } = await launchPRFixture();
	try {
		// spec/appearance#evolution-redesign: the repo rows with their PR counters are the header's «Repos k/n» popover.
		const popover = await openRepos(page);
		const admin = popover.locator('[data-scope="apps/admin"]'),
			counter = admin.locator('[data-repo-prs]');
		await expect(counter).toHaveAccessibleName(
			'3 open PRs · 1 closed in 7 days · some wait for you'
		);
		await expect(counter).toHaveText('31');
		await expect(popover.locator('[data-scope="kit"] [data-repo-prs]')).toHaveAccessibleName(
			'1 open PR · 0 closed in 7 days'
		);
		await expect(popover.locator('[data-scope="."] [data-repo-prs]')).toHaveCount(0);
		await counter.click();
		await expect(reposPopover(page)).toHaveCount(0);
		await expect((await repoRow(page, 'apps/admin')).locator('[data-repo-prs]')).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-panel-tab=prs]')).toHaveAttribute('aria-selected', 'true');
		const list = page.getByRole('list', { name: 'Pull requests', exact: true });
		await expect(page.locator('[data-repo-picker]')).toHaveAccessibleName('Repo · apps/admin');
		// spec/pull-requests-and-ci#repo-picker: one repo in the list — no repo name on the rows.
		await expect(list.locator('[data-pr-repo]')).toHaveCount(0);
		for (const [group, numbers] of [
			['Waiting for you', [421]],
			['Yours', [419]],
			['Others', [416]],
			['Recently closed', [414]],
		] as const)
			await expect(
				list.getByRole('group', { name: group, exact: true }).locator('[data-pr-row]')
			).toHaveCount(numbers.length);
		await expect(list.locator('[data-pr-row="400"]')).toHaveCount(0);
		await expect(list.locator('[data-pr-row="421"] [data-mark="waiting"]')).toBeVisible();
		await expect(list.locator('[data-pr-row="419"] [data-mark="changes"]')).toBeVisible();
		await expect(list.locator('[data-pr-row="414"]')).toHaveAttribute('data-closed', 'true');
		await page.getByRole('button', { name: 'Find a PR', exact: true }).click();
		await page.keyboard.type('Orders');
		await expect(list.locator('[data-pr-row]')).toHaveCount(1);
		await page.keyboard.press('Escape');
		await expect(list.locator('[data-pr-row]')).toHaveCount(4);
		await list.locator('[data-pr-row="421"]').click();
		const tabs = page.getByRole('tablist', { name: 'Pull request', exact: true });
		await expect(tabs.getByRole('tab', { name: 'Comments', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(page.getByRole('tabpanel').locator('[data-resolved]')).toHaveCount(1);
		await page.getByText('Unresolved only', { exact: true }).click();
		await expect(page.getByRole('tabpanel').locator('[data-resolved]')).toHaveCount(2);
		await tabs.getByRole('tab', { name: 'Files', exact: true }).click();
		await expect(page.getByText('1 of 2 viewed', { exact: true })).toBeVisible();
		await page
			.getByRole('checkbox', { name: 'Viewed · src/loyalty/rules.ts', exact: true })
			.click();
		await expect
			.poll(async () =>
				(await gh()).writes?.some((write: { mutation?: string }) =>
					write.mutation?.includes('markFileAsViewed')
				)
			)
			.toBe(true);
		await tabs.getByRole('tab', { name: 'Checks', exact: true }).click();
		await expect(page.locator('[data-check][data-state="fail"]')).toContainText('e2e-admin');
		await expect(page.getByRole('button', { name: 'Log on GitHub', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Back to the list', exact: true }).click();
		await expect(list.locator('[data-pr-row="421"]')).toHaveAttribute('aria-pressed', 'true');
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('the PR list names the repo on each row while it holds several, and the header picker narrows it to one (spec/pull-requests-and-ci#repo-picker) @area:pr', async () => {
	test.setTimeout(120000);
	const { close, page, errors } = await launchPRFixture();
	try {
		await openPanelTab(page, 'prs');
		const list = page.getByRole('list', { name: 'Pull requests', exact: true }),
			picker = page.locator('[data-repo-picker]');
		// kit and apps/admin in one list — the name leads the second line.
		await expect(list.locator('[data-pr-row="88"] [data-pr-repo]')).toHaveText('kit');
		await expect(list.locator('[data-pr-row="421"] [data-pr-repo]')).toHaveText('apps/admin');
		await page.getByRole('button', { name: 'Find a PR', exact: true }).click();
		await page.keyboard.type('apps/');
		await expect(list.locator('[data-pr-row]')).toHaveCount(4);
		await page.keyboard.press('Escape');
		// «All repos», then the repos in the Repo section's order; the root has no PR and is off.
		await expect(picker).toHaveAccessibleName('Repo · All repos');
		await expect(picker).toHaveAttribute('data-appearance', 'neutral');
		await picker.click();
		const menu = page.getByRole('menu', { name: 'Repo', exact: true });
		await expect(menu.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
		await expect(menu.getByRole('menuitemradio')).toHaveText([
			/^All repos\s*4$/,
			/^choice\s*No PRs$/,
			/^apps\/admin\s*3$/,
			/^kit\s*1$/,
		]);
		await expect(menu.getByRole('menuitemradio', { name: /^All repos/ })).toBeFocused();
		await expect(menu.locator('[data-repo="."]')).toBeDisabled();
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveAccessibleName('Repo · apps/admin');
		await expect(picker).toHaveAttribute('data-appearance', 'primary');
		await expect(list.locator('[data-pr-row="88"]')).toHaveCount(0);
		await expect(list.locator('[data-pr-repo]')).toHaveCount(0);
		// The Repo row's counter sets the same filter.
		await repoPRs(page, 'kit');
		await expect(picker).toHaveAccessibleName('Repo · kit');
		await picker.click();
		await menu.getByRole('menuitemradio', { name: /^All repos/ }).click();
		await expect(picker).toHaveAccessibleName('Repo · All repos');
		await expect(list.locator('[data-pr-row="88"] [data-pr-repo]')).toHaveText('kit');
		// CI runs are one repo's — the picker names it and has no «All repos»; Esc gives the focus back.
		await page.getByRole('tab', { name: 'CI', exact: true }).click();
		await expect(picker).toHaveAccessibleName('Repo · choice');
		await picker.click();
		await expect(menu.getByRole('menuitemradio')).toHaveText(['choice', 'apps/admin', 'kit']);
		await expect(menu.locator('[data-repo="."]')).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape');
		await expect(picker).toBeFocused();
		await page.getByRole('tab', { name: 'Pull requests', exact: true }).click();
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('a PR file opens as a diff tab with GitHub threads; drafts survive a failed review and go out as one review (spec/pull-requests-and-ci#pr-threads, spec/diff-and-review#review-comments) @area:pr', async () => {
	test.setTimeout(120000);
	const { app, close, page, errors, gh, setGh, root, repo } = await launchPRFixture();
	try {
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		// The Files tab fetches the PR head before the first click; two quick clicks read the file once and open one tab.
		await page.locator('[data-pr-panel]').getByRole('tab', { name: 'Files', exact: true }).click();
		await expect
			.poll(() =>
				promisify(execFile)('git', ['rev-parse', '--verify', 'refs/brigadir-v2/pr/421'], {
					cwd: join(repo, 'apps/admin'),
				}).then(
					() => true,
					() => false
				)
			)
			.toBe(true);
		const fileRow = page.locator('[data-pr-file="src/loyalty/LoyaltyRule.tsx"]');
		await fileRow.click();
		await fileRow.click();
		await expect(
			page.getByRole('tab', { name: 'Diff · src/loyalty/LoyaltyRule.tsx', exact: true })
		).toHaveAttribute('aria-selected', 'true');
		await expect(
			page.getByRole('tab', { name: 'Diff · src/loyalty/LoyaltyRule.tsx', exact: true })
		).toHaveCount(1);
		await expect(fileRow).not.toHaveAttribute('aria-busy', 'true');
		const thread = page.locator('[data-pr-thread]').first();
		await expect(thread).toContainText('olena-p');
		await expect(thread).toContainText('Brief says every second item.');
		await thread.getByRole('button', { name: 'Reply', exact: true }).click();
		await page.keyboard.type('Then the cheapest one should be free.');
		await thread.getByRole('button', { name: 'Add to review', exact: true }).click();
		const footer = page.locator('[data-pr-review-footer]');
		await expect(footer).toContainText('1 draft');
		await selectCode(page.getByRole('log', { name: 'Diff', exact: true }), 'new', 10);
		await page.getByRole('button', { name: 'Comment', exact: true }).last().click();
		// spec/diff-and-review#diff-selection: the new comment quotes the selected code, as a task comment does.
		await expect(page.locator('[data-pr-new-comment] [data-code-quote]')).toBeVisible();
		await page.keyboard.type('Show the badge only when free > 0.');
		await page
			.locator('[data-pr-new-comment]')
			.getByRole('button', { name: /Add to review/ })
			.click();
		await expect(footer).toContainText('2 drafts');
		// spec/appearance#evolution-redesign: the review goes out from the modal; Esc closes it at once and the drafts stay.
		await footer.getByRole('button', { name: 'Continue review', exact: true }).click();
		const modal = page.locator('[data-pr-review-modal="421"]');
		await expect(modal).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(modal).toHaveCount(0);
		await expect(footer).toContainText('2 drafts');
		await footer.getByRole('button', { name: 'Continue review', exact: true }).click();
		await modal.locator('[data-review-step="3"]').click();
		const verdict = modal.locator('[data-review-column="3"]');
		// The agent's hint lands over the decisions; pick after it, so the click does not move.
		await expect(verdict).toContainText('The agent suggests', { timeout: 30000 });
		await verdict.getByRole('radio', { name: 'Request changes' }).check();
		await expect(verdict.getByRole('radio', { name: 'Request changes' })).toBeChecked();
		await modal.locator('[data-review-step="4"]').click();
		await modal
			.getByRole('textbox', { name: 'Review comment', exact: true })
			.fill('Rule works. Two things before merge.');
		await modal.locator('[data-review-step="5"]').click();
		await setGh({ writeError: 'Line 27 no longer exists in the branch.' });
		await modal.getByRole('button', { name: /Send the review/ }).click();
		await expect(modal.locator('[data-review-column="5"]').getByRole('alert')).toContainText(
			'The drafts are saved.'
		);
		await expect(modal.locator('[data-review-preview] [data-review-comment]')).toHaveCount(2);
		// spec/pull-requests-and-ci#review-drafts: the drafts belong to the PR — one file in the project, not in the task.
		const pulls = join(root, 'data/projects/project/pull-requests'),
			file = (await readdir(pulls)).find(
				(name) => name.startsWith('review-') && name.endsWith('-421.json')
			)!;
		expect(JSON.parse(await readFile(join(pulls, file), 'utf8')).review.drafts).toHaveLength(2);
		await setGh({ writeError: null });
		await modal.getByRole('button', { name: /Send again/ }).click();
		await expect(
			page.getByRole('status').filter({ hasText: 'Review sent to PR #421' })
		).toBeVisible();
		await expect(footer).toContainText('You requested changes · just now');
		const writes = (await gh()).writes as { method?: string; path?: string; body?: any }[],
			review = writes.find((write) => write.path?.endsWith('/pulls/421/reviews'))!;
		expect(review.body).toMatchObject({
			event: 'REQUEST_CHANGES',
			body: 'Rule works. Two things before merge.',
			comments: [
				{
					path: 'src/loyalty/LoyaltyRule.tsx',
					line: 10,
					side: 'RIGHT',
					body: 'Show the badge only when free > 0.',
				},
			],
		});
		expect(
			writes.some(
				(write) =>
					/\/pulls\/421\/comments\/\d+\/replies$/.test(write.path ?? '') &&
					write.body?.body === 'Then the cheapest one should be free.'
			)
		).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('a repo row opens its main tree: no chat, changes from the last commit, a quick task without isolation (spec/tasks#quick-tasks) @area:pr', async () => {
	test.setTimeout(120000);
	const { app, close, page, errors } = await launchPRFixture({ task: false });
	try {
		// spec/task-window#repo-line: the project's menu opens the main tree; a root of its panel makes that repo current.
		await openMainTree(app, page, 'choice');
		await openPanelTab(page, 'files');
		await page.getByRole('button', { name: 'Expand folder · kit', exact: true }).click();
		await expect(page.locator('[data-repo-root="kit"]')).toHaveAttribute('data-current', 'true');
		const toolbar = page.locator('header[aria-label="View"]');
		await expect(toolbar.getByRole('heading', { name: 'choice', exact: true })).toBeVisible();
		await expect(toolbar).toContainText('main tree · kit');
		await expect(toolbar.getByRole('radio', { name: 'Chat', exact: true })).toHaveCount(0);
		await openPanelTab(page, 'changes');
		await expect(page.locator('[data-diff-base-chip]')).toContainText('Last commit');
		await page.locator('[data-quick-task-bar]').click();
		const sheet = page.getByRole('dialog', { name: 'New quick task', exact: true });
		await expect(sheet).toBeVisible();
		await expect(sheet).toContainText('main · No isolation');
		await page.keyboard.press('Escape');
		await expect(sheet).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('Overview is the PR page: summary links open the file, the agent answers under a comment, merge only when GitHub says CLEAN (spec/pull-requests-and-ci#pr-overview, spec/editor#editor-principles, spec/pull-requests-and-ci#merge) @area:pr', async ({}, info) => {
	test.setTimeout(120000);
	const { app, close, page, errors, gh, setGh } = await launchPRFixture();
	try {
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		await page.getByRole('button', { name: 'Overview', exact: true }).click();
		await expect(page.getByRole('tab', { name: 'Overview · #421', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		const overview = page.locator('[data-pr-overview="421"]');
		await expect(overview).toContainText('wants to merge 1 commit from');
		await expect(overview.locator('[data-pr-markdown] h2').first()).toHaveText('What');
		await expect(overview.locator('[data-pr-markdown] li code').first()).toHaveText(
			'LoyaltyRule.tsx'
		);
		await expect(overview.locator('[data-pr-markdown] strong').first()).toHaveText('paid');
		const merge = overview.locator('[data-merge]');
		await expect(merge).toBeDisabled();
		await expect(merge).toHaveAttribute('title', 'Checks did not pass');
		// A narrow tab (≈ 400 px): the title keeps ≥ 120 px and ends in «…» (the full title in its tooltip),
		// «Start review» and «Merge PR…» are glyphs with their names, the header row does not push the title out.
		await overview.evaluate((node) => {
			(node as HTMLElement).style.maxWidth = '400px';
		});
		await expect(overview).toHaveAttribute('data-narrow', 'true');
		const title = overview.locator('header h1');
		await expect(title).toBeVisible();
		await expect(title).toHaveAttribute('title', 'Loyalty 1+1 in admin');
		expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(
			Math.min(120, await title.evaluate((node) => node.scrollWidth))
		);
		const opener = overview.locator('header [data-review-open]');
		await expect(opener).toHaveAccessibleName('Start review');
		await expect(opener).toHaveAttribute('title', 'Start review');
		await expect(opener).not.toContainText('Start review');
		await expect(merge).toHaveAccessibleName('Merge PR…');
		await expect(merge).toHaveAttribute('title', 'Checks did not pass');
		await overview.evaluate((node) => {
			(node as HTMLElement).style.maxWidth = '';
		});
		await overview.getByRole('button', { name: 'Generate a summary', exact: true }).click();
		const summary = overview.getByRole('region', { name: 'Summary from the agent', exact: true });
		await expect(summary).toContainText('What was done');
		await expect(summary).toContainText('What to review');
		await summary.getByRole('button', { name: 'LoyaltyRule.tsx', exact: true }).first().click();
		await expect(
			page.getByRole('tab', { name: 'Diff · src/loyalty/LoyaltyRule.tsx', exact: true })
		).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByRole('status').filter({ hasText: 'From the summary' })).toContainText(
			'lines 4–6'
		);
		await page.getByRole('button', { name: 'Back to Overview', exact: true }).click();
		await expect(page.getByRole('tab', { name: 'Overview · #421', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await overview.locator('[data-commits]').click();
		await expect(overview.getByRole('radio', { name: 'Commits', exact: true })).toBeChecked();
		await overview.getByRole('button', { name: /loyalty: every second item free/ }).click();
		// The commit's file row (its title is the path): the summary card above keeps its own «LoyaltyRule.tsx» links once
		// the saved summary is read back, so a name match alone finds three buttons.
		await overview.locator('button[title="src/loyalty/LoyaltyRule.tsx"]').click();
		await expect(
			page.getByRole('tab', { name: /LoyaltyRule\.tsx/ }).filter({ hasText: '@' })
		).toHaveAttribute('aria-selected', 'true');
		await page.getByRole('tab', { name: 'Overview · #421', exact: true }).click();
		await overview.getByRole('radio', { name: 'All', exact: true }).click();
		await overview.getByRole('button', { name: 'Ask the agent', exact: true }).first().click();
		await expect(overview).toContainText('Agent · an explanation for you');
		await expect(overview).toContainText('The real gap is price.');
		await overview.getByRole('radio', { name: 'To the PR', exact: true }).click();
		await overview
			.getByRole('textbox', { name: 'Comment on this PR…', exact: true })
			.fill('Thanks, looks good.');
		await page.keyboard.press('Enter');
		await expect
			.poll(async () =>
				((await gh()).writes ?? []).some(
					(write: { path?: string; body?: { body?: string } }) =>
						write.path?.endsWith('/issues/421/comments') &&
						write.body?.body === 'Thanks, looks good.'
				)
			)
			.toBe(true);
		await setGh({
			pullRequests: (await gh()).pullRequests.map((pr: { number: number }) =>
				pr.number === 421 ? { ...pr, mergeState: 'CLEAN', reviewDecision: 'APPROVED' } : pr
			),
		});
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(merge).toBeEnabled();
		await merge.click();
		const dialog = page.getByRole('dialog', { name: 'Merge PR #421 into staging?', exact: true });
		await expect(dialog.getByRole('radio', { name: /Squash/ })).toBeChecked();
		await expect(dialog).toContainText('To merge: 1 commit');
		await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
		await expect(page.getByRole('status').filter({ hasText: 'PR #421 merged' })).toBeVisible();
		// spec/pull-requests-and-ci#merge: a merged PR shows its state where «Merge PR…» stood, the height of the row.
		const merged = overview.locator('[class*=stateChip]');
		await expect(merged).toHaveText('Merged');
		await expect(merged).toHaveAttribute('data-state', 'MERGED');
		await expect(overview.locator('[data-merge]')).toHaveCount(0);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await overview.locator('header').screenshot({
				animations: 'disabled',
				path: info.outputPath(`overview-merged-${theme}.png`),
			});
		}
		expect((await merged.boundingBox())!.height).toBe(
			(await overview
				.locator('[class*=titleRow]')
				.getByRole('button', { name: 'Open on GitHub', exact: true })
				.boundingBox())!.height
		);
		const writes = (await gh()).writes as { method?: string; path?: string; body?: any }[];
		expect(writes.find((write) => write.path?.endsWith('/pulls/421/merge'))?.body).toMatchObject({
			merge_method: 'squash',
		});
		expect(
			writes.some(
				(write) =>
					write.method === 'DELETE' && write.path?.endsWith('/git/refs/heads/feat/loyalty-admin')
			)
		).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('the Merge card says why a PR cannot be merged, and Ready for review takes a draft out of draft (spec/pull-requests-and-ci#merge-card) @area:pr', async () => {
	test.setTimeout(120000);
	const prs = fixturePRs().map((pr) =>
		pr.number === 419
			? {
					...pr,
					isDraft: true,
					mergeState: 'CLEAN',
					reviewDecision: null,
					head: 'feat/orders-csv',
					base: 'staging',
				}
			: pr
	);
	const { close, page, errors, gh, setGh } = await launchPRFixture({ prs });
	try {
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="419"]').click();
		await page.getByRole('button', { name: 'Overview', exact: true }).click();
		const overview = page.locator('[data-pr-overview="419"]'),
			card = overview.getByRole('region', { name: 'Merging', exact: true }),
			merge = overview.locator('[data-merge]');
		// GitHub says CLEAN, but a draft is not merged: the card says so in words, not only the tooltip.
		await expect(card).toHaveAttribute('data-merge-card', 'draft');
		await expect(card).toContainText('Without conflicts');
		await expect(card).toContainText('The PR is a draft');
		await expect(card).not.toContainText('approval');
		await expect(merge).toBeDisabled();
		await expect(merge).toHaveAttribute('title', 'The PR is a draft');
		const ready = card.getByRole('button', { name: 'Ready for review', exact: true });
		// A failed mutation keeps the button; a toast names the action, GitHub's raw answer stays out (spec/notifications-slack-notes-and-schedules#message-classes).
		await setGh({ writeError: 'Pull request is locked' });
		await ready.click();
		await expect(page.locator('[data-toast-region]').getByRole('alert')).toContainText(
			'Could not mark the PR ready for review.'
		);
		await expect(card.getByRole('alert')).toHaveCount(0);
		await expect(ready).toBeEnabled();
		await setGh({ writeError: null });
		await ready.click();
		await expect(card).toHaveAttribute('data-merge-card', 'clean');
		await expect(card).toContainText('Can be merged');
		await expect(card.getByRole('alert')).toHaveCount(0);
		await expect(merge).toBeEnabled();
		await expect(card.getByRole('button', { name: 'Ready for review', exact: true })).toHaveCount(
			0
		);
		const writes = (await gh()).writes as { mutation?: string; args?: string[] }[];
		expect(
			writes
				.filter((write) => write.mutation?.includes('markPullRequestReadyForReview'))
				.map((write) => write.args?.find((arg) => arg.startsWith('pr=')))
		).toEqual(['pr=PR_419']);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('Review with an agent runs quickly in the main tree by default; the agent answers a reply under its draft and rewrites it (spec/pull-requests-and-ci#review-with-agent, spec/pull-requests-and-ci#review-with-agent) @area:pr', async () => {
	test.setTimeout(180000);
	const { app, close, page, errors, root, repo } = await launchPRFixture();
	try {
		const branch = () =>
			promisify(execFile)('git', ['branch', '--show-current'], {
				cwd: join(repo, 'apps/admin'),
			}).then((result) => result.stdout.trim());
		const before = await branch();
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		// spec/pull-requests-and-ci#review-launch: the button opens the launch dialog; quick is the default, ⌘↩ starts with the instructions.
		await page.getByRole('button', { name: 'Review with an agent…', exact: true }).click();
		const launch = page.locator('[data-review-launch]');
		await expect(launch.getByRole('radio', { name: 'Quickly', exact: true })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await expect(launch.getByRole('textbox', { name: 'Notes for the reviewer' })).toBeFocused();
		await page.keyboard.type('Check the free count against prices.');
		await page.keyboard.press('Meta+Enter');
		await expect(launch).toHaveCount(0);
		const card = page
			.locator('aside')
			.getByRole('button', { name: /Review #421 · Loyalty 1\+1 in admin/ })
			.filter({ has: page.locator('[class*=taskCopy]') });
		await expect(card).toBeVisible();
		await page
			.getByRole('status')
			.filter({ hasText: 'started' })
			.getByRole('button', { name: 'Open', exact: true })
			.click();
		const tasks = join(root, 'data/projects/project/tasks'),
			reviews = async () => {
				const found: any[] = [];
				for (const id of await readdir(tasks)) {
					const task = JSON.parse(await readFile(join(tasks, id, 'task.json'), 'utf8')).task;
					if (task.prReview) found.push(task);
				}
				return found;
			};
		const [review] = await reviews();
		expect(review).toMatchObject({
			prReview: { number: 421, mode: 'review', base: 'staging', repo: 'apps/admin' },
			readOnlyAgent: true,
			launch: { isolation: 'in-place' },
		});
		expect(review.prompt).toContain(
			'Instructions from the person for this review:\nCheck the free count against prices.'
		);
		await expect(page.locator('[data-pr-draft-row]')).toHaveCount(1, { timeout: 60000 });
		await expect(page.locator('[data-pr-draft-row]')).toContainText(
			'The free count ignores prices.'
		);
		expect(await branch()).toBe(before);
		await expect(page.locator('[data-pr-review-footer]')).toContainText('1 draft');
		await expect(page.locator('[data-agent-review], [data-open-review]')).toHaveCount(0);
		// spec/pull-requests-and-ci#review-with-agent: a reply under the agent's draft goes into its thread and to the review task; the agent answers and rewrites it.
		await page.locator('[data-pr-draft-row]').click();
		const draft = page.locator('[data-pr-draft]').first();
		await expect(draft).toContainText('The free count ignores prices.');
		await draft.getByRole('button', { name: 'Reply to the agent', exact: true }).click();
		await page.keyboard.type('Not a bug: the brief says every second item by order.');
		await page.keyboard.press('Meta+Enter');
		await expect(draft.locator('[data-pr-draft-reply="person"]')).toContainText('Not a bug');
		await expect(draft.locator('[data-pr-draft-reply="agent"]')).toContainText(
			'Agreed, the order is intended.',
			{ timeout: 60000 }
		);
		await expect(draft.locator('[data-updated-by-agent]')).toBeVisible();
		await expect(draft).toContainText('Please add a test with 3 items');
		await expect(page.locator('[data-pr-draft-row]')).toContainText(
			'Please add a test with 3 items'
		);
		// Another PR opened from the review task offers its own review task.
		await page.getByRole('button', { name: 'Back to the list', exact: true }).click();
		await page.locator('[data-pr-row="416"]').click();
		await expect(
			page.getByRole('button', { name: 'Review with an agent…', exact: true })
		).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('the launch dialog runs the review in a worktree, remembers the place, keeps the draft, then leads into the live review (spec/pull-requests-and-ci#review-launch) @area:pr', async () => {
	test.setTimeout(180000);
	const { app, close, page, errors, root } = await launchPRFixture();
	try {
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		const button = page.getByRole('button', { name: 'Review with an agent…', exact: true });
		await button.click();
		const launch = page.locator('[data-review-launch]');
		await page.keyboard.type('Draft that waits');
		await page.keyboard.press('Escape');
		await expect(launch).toHaveCount(0);
		await expect(button).toBeFocused();
		await button.click();
		await expect(launch.getByRole('textbox', { name: 'Notes for the reviewer' })).toContainText(
			'Draft that waits'
		);
		await launch.getByRole('radio', { name: 'In a worktree', exact: true }).click();
		await launch.getByRole('button', { name: 'Start review', exact: true }).click();
		await expect(launch).toHaveCount(0);
		await expect(page.getByRole('status').filter({ hasText: 'started' })).toBeVisible();
		const tasks = join(root, 'data/projects/project/tasks');
		let review: any = null;
		await expect
			.poll(async () => {
				for (const id of await readdir(tasks)) {
					const task = JSON.parse(await readFile(join(tasks, id, 'task.json'), 'utf8')).task;
					if (task.prReview) review = task;
				}
				return review?.launch?.isolation;
			})
			.toBe('worktree');
		expect(review).toMatchObject({
			launch: {
				isolation: 'worktree',
				baseRef: 'refs/brigadir-v2/pr/421',
				branch: 'pr-421-review',
			},
		});
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(root, 'data/settings.json'), 'utf8')).settings.agents
						.reviewWhere
			)
			.toBe('worktree');
		// spec/pull-requests-and-ci#review-with-agent: while the review task is live, the PR leads into it instead of starting another.
		const open = page.locator('[data-open-review]');
		await expect(open).toContainText('Open the review');
		await open.click();
		await expect(page.locator('[data-pr-review-footer]')).toBeVisible();
		await expect(page.locator('[data-agent-review], [data-open-review]')).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('on my own PR the reviewer threads go to the PR task as one message with an attachment (spec/pull-requests-and-ci#hand-to-agent) @area:pr', async () => {
	test.setTimeout(120000);
	const prs = [
		{
			repo: 'admin',
			number: 419,
			title: 'Orders: export to CSV',
			author: 'me',
			head: 'fix/ai-chat-flag-gating',
			base: 'staging',
			reviewDecision: 'CHANGES_REQUESTED',
			updatedAt: new Date().toISOString(),
			threads: [
				{
					path: 'src/orders/OrdersExport.tsx',
					line: 31,
					comments: [
						{ author: 'olena-p', body: 'Stream the rows, 10k orders will not fit in memory.' },
					],
				},
				{
					path: 'src/orders/csv.ts',
					line: 12,
					comments: [{ author: 'olena-p', body: 'Escape quotes in customer names.' }],
				},
			],
		},
	];
	const { app, close, page, errors, task, root } = await launchPRFixture({ prs });
	try {
		const scopes = await page.evaluate(
				(task) => window.brigadir.readScopePanel(task.projectId, task.id),
				task
			),
			admin = scopes.scopes.find((scope) => scope.name === 'apps/admin')!;
		await page.evaluate(
			({ task, scopeId }) =>
				window.brigadir.sendCommand(task as never, {
					kind: 'recordPullRequest',
					scopeId,
					pr: {
						number: 419,
						url: 'https://github.com/fixture/admin/pull/419',
						title: 'Orders: export to CSV',
						state: 'OPEN',
						head: 'fix/ai-chat-flag-gating',
						base: 'staging',
					},
				}),
			{ task, scopeId: admin.id }
		);
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="419"]').click();
		await expect(
			page.getByRole('button', { name: 'Review with an agent…', exact: true })
		).toBeVisible();
		const footer = page.locator('[data-pr-own-footer]');
		await expect(footer).toContainText('2 of 2 chosen');
		await page
			.getByRole('checkbox', { name: 'Hand to the agent · csv.ts:12', exact: true })
			.click();
		await expect(footer).toContainText('1 of 2 chosen');
		await footer.getByRole('button', { name: 'Hand to the agent', exact: true }).click();
		await expect(
			page.getByRole('status').filter({ hasText: '1 comment handed to the agent' })
		).toBeVisible();
		await expect(page.locator('[data-resolved] [aria-label="Handed to the agent"]')).toHaveCount(1);
		const events = (
			await readFile(join(root, 'data/projects/project/tasks', task.id, 'events.jsonl'), 'utf8')
		)
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line).event);
		expect(
			events.some(
				(event) =>
					event.kind === 'turn.started' &&
					event.text.startsWith('Address the review from olena-p on PR #419')
			)
		).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('the header search opens over the row without changing its height (spec/pull-requests-and-ci#pr-panel) @area:pr', async () => {
	test.setTimeout(90000);
	const { app, close, page } = await launchPRFixture({ language: 'uk', theme: 'dark' });
	try {
		await openPanelTab(page, 'changes');
		const header = page.locator('aside[aria-label="Зміни"] > header').first();
		await page.waitForTimeout(500);
		const before = await header.evaluate((n) => n.getBoundingClientRect().height);
		await page.getByRole('button', { name: 'Знайти файл', exact: true }).click();
		await page.waitForTimeout(300);
		const after = await header.evaluate((n) => n.getBoundingClientRect().height);
		await page.keyboard.press('Escape');
		await repoPRs(page, 'apps/admin');
		const prHeader = page.locator('[data-pr-panel] header').first();
		const prBefore = await prHeader.evaluate((n) => n.getBoundingClientRect().height);
		await page.getByRole('button', { name: 'Знайти PR', exact: true }).click();
		await page.waitForTimeout(300);
		const prAfter = await prHeader.evaluate((n) => n.getBoundingClientRect().height);
		expect(after).toBe(before);
		expect(prAfter).toBe(prBefore);
	} finally {
		await close();
	}
});
test('Refresh reads the PR list and the PR past the cache, turns while it reads and blocks nothing; ⌘R from the panel (spec/pull-requests-and-ci#reading-and-refresh) @area:pr', async () => {
	test.setTimeout(120000);
	const { app, close, page, errors, gh, setGh } = await launchPRFixture();
	const rename = async (number: number, title: string, extra: object = {}) => {
		const state = await gh();
		state.pullRequests.find((pr: { number: number }) => pr.number === number).title = title;
		await setGh({ pullRequests: state.pullRequests, ...extra });
	};
	try {
		await repoPRs(page, 'apps/admin');
		const list = page.getByRole('list', { name: 'Pull requests', exact: true }),
			refresh = page.locator('[data-pr-panel=list] [data-pr-refresh]');
		await expect(list.locator('[data-pr-row="416"]')).toContainText(
			'Bump @tanstack/react-query to 6'
		);
		await expect(refresh).toHaveAccessibleName('Refresh');
		await expect(refresh).toHaveAttribute('title', 'Refresh · ⌘R');
		await expect(refresh).toHaveAttribute('aria-busy', 'false');
		// The header order: segment (spec/pull-requests-and-ci#pr-panel), filter, New PR (spec/pull-requests-and-ci#ready-card), search, Refresh, GitHub.
		expect(
			await page
				.locator('[data-pr-panel=list] header button')
				.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))
		).toEqual([
			'Pull requests',
			'CI',
			'Repo · apps/admin',
			'New PR',
			'Find a PR',
			'Refresh',
			'Open on GitHub',
		]);
		await rename(416, 'Bump @tanstack/react-query to 7', { graphqlDelay: 1500 });
		await refresh.click();
		await expect(refresh).toHaveAttribute('aria-busy', 'true');
		expect(
			await refresh.locator('svg').evaluate((node) => getComputedStyle(node).animationName)
		).toMatch(/pr-refresh-turn/);
		// Nothing waits for the read: the repo filter comes off at once and the read keeps going.
		await page.locator('[data-repo-picker]').click();
		await page
			.getByRole('menu', { name: 'Repo', exact: true })
			.getByRole('menuitemradio', { name: /^All repos/ })
			.click();
		await expect(list.locator('[data-pr-row="88"]')).toBeVisible();
		await expect(refresh).toHaveAttribute('aria-busy', 'true');
		await expect(list.locator('[data-pr-row="416"]')).toContainText(
			'Bump @tanstack/react-query to 7',
			{ timeout: 15000 }
		);
		await expect(refresh).toHaveAttribute('aria-busy', 'false');
		await expect(refresh).not.toHaveAttribute('data-spinning', /.*/, { timeout: 3000 });
		// In the PR, Refresh reads the PR again.
		await list.locator('[data-pr-row="421"]').click();
		const detail = page.locator('[data-pr-panel=detail]');
		await expect(detail.locator('h2')).toHaveText('Loyalty 1+1 in admin');
		const detailRefresh = detail.locator('[data-pr-refresh]');
		expect(
			await detail
				.locator('[class*=titleRow] button')
				.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))
		).toEqual(['Back to the list', 'Refresh', 'Open on GitHub']);
		await rename(421, 'Loyalty 1+1 in admin (v2)', { graphqlDelay: 0 });
		await detailRefresh.click();
		await expect(detail.locator('h2')).toHaveText('Loyalty 1+1 in admin (v2)', { timeout: 15000 });
		// ⌘R is View → Refresh pull requests, enabled while the focus is in the PR panel.
		const item = () =>
			app.evaluate(({ Menu }) => {
				const item = Menu.getApplicationMenu()!.getMenuItemById('pull-requests-refresh')!;
				return { enabled: item.enabled, accelerator: item.accelerator ?? null };
			});
		await detail.getByRole('button', { name: 'Back to the list', exact: true }).focus();
		await expect.poll(item).toEqual({ enabled: true, accelerator: 'CmdOrCtrl+R' });
		await rename(421, 'Loyalty 1+1 in admin (v3)');
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('pull-requests-refresh')!.click()
		);
		await expect(detail.locator('h2')).toHaveText('Loyalty 1+1 in admin (v3)', { timeout: 15000 });
		// Reduced motion: no turn, the glyph only dims while it reads.
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await setGh({ graphqlDelay: 1500 });
		await detailRefresh.click();
		await expect(detailRefresh).toHaveAttribute('aria-busy', 'true');
		expect(
			await detailRefresh.locator('svg').evaluate((node) => ({
				animation: getComputedStyle(node).animationName,
				opacity: getComputedStyle(node).opacity,
			}))
		).toEqual({ animation: 'none', opacity: '0.55' });
		await expect(detailRefresh).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
		await expect(detailRefresh).not.toHaveAttribute('data-spinning', /.*/);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

/** ⌘+click in the middle of `word` in the new-side line that has `line`, wherever the syntax tokens split it. */
async function metaClickWord(page: import('@playwright/test').Page, line: string, word: string) {
	const point = await page.evaluate(
		([line, word]) => {
			const node = [...document.querySelectorAll('[data-side=new]')].find((item) =>
				item.textContent?.includes(line)
			);
			if (!node) return null;
			const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
			let at = node.textContent!.indexOf(line) + line.indexOf(word),
				text: Node | null;
			while ((text = walker.nextNode())) {
				const length = text.textContent!.length;
				if (at < length) {
					const range = document.createRange();
					range.setStart(text, at);
					range.setEnd(text, Math.min(length, at + word.length));
					const rect = range.getBoundingClientRect();
					return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
				}
				at -= length;
			}
			return null;
		},
		[line, word] as const
	);
	expect(point).not.toBeNull();
	await page.keyboard.down('Meta');
	await page.mouse.click(point!.x, point!.y);
	await page.keyboard.up('Meta');
}
test('⌘+click in a PR file goes to the definition in the PR branch; a file the PR did not change opens read only; the crumb comes back (spec/pull-requests-and-ci#pr-definition) @area:pr', async () => {
	test.setTimeout(120000);
	const { close, page, errors, root, repo } = await launchPRFixture({
		prs: fixturePRs().map((pr) =>
			pr.number === 421
				? { ...pr, files: [...pr.files!, { path: 'src/loyalty/apply.ts', additions: 6 }] }
				: pr
		),
	});
	try {
		// One more PR file that calls a function of the PR (rules.ts) and a constant the PR did not change (flags.ts).
		const remote = join(root, 'remotes', join(repo, 'apps/admin').replace(/\W/g, '_') + '.git'),
			clone = join(root, 'clone'),
			git = (...args: string[]) => promisify(execFile)('git', args, { cwd: clone });
		await promisify(execFile)('git', ['clone', '-q', '-b', 'feat/loyalty-admin', remote, clone]);
		await git('config', 'user.name', 'Fixture');
		await git('config', 'user.email', 'fixture@example.com');
		await writeFile(
			join(clone, 'src/loyalty/rules.ts'),
			'export const everySecond = true;\nexport function freeCount(items: number) {\n  return Math.floor(items / 2);\n}\n'
		);
		await writeFile(
			join(clone, 'src/loyalty/apply.ts'),
			"import { freeCount } from './rules';\nimport { flags } from '../features/ai/flags';\n\nexport function applyRule(items: number) {\n  return flags ? freeCount(items) : 0;\n}\n"
		);
		await git('add', '.');
		await git('commit', '-qm', 'loyalty: apply the rule');
		await git('push', '-q', 'origin', 'HEAD:refs/pull/421/head');
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		await page.locator('[data-pr-panel]').getByRole('tab', { name: 'Files', exact: true }).click();
		await page.locator('[data-pr-file="src/loyalty/apply.ts"]').click();
		const applyTab = page.getByRole('tab', { name: 'Diff · src/loyalty/apply.ts', exact: true });
		await expect(applyTab).toHaveAttribute('aria-selected', 'true');
		// A changed file of the PR: its diff tab, the line lit, the crumb names the name and the file to go back to.
		await expect(
			page.locator('[data-side=new]', { hasText: 'return flags ? freeCount(items)' })
		).toBeVisible();
		await metaClickWord(page, 'return flags ? freeCount(items)', 'freeCount');
		await expect(
			page.getByRole('tab', { name: 'Diff · src/loyalty/rules.ts', exact: true })
		).toHaveAttribute('aria-selected', 'true', { timeout: 20000 });
		const crumb = page.getByRole('status').filter({ hasText: 'Definition of freeCount' });
		await expect(crumb).toContainText('line 2');
		await expect(page.locator('[data-selected=true] [data-side=new]').first()).toContainText(
			'export function freeCount'
		);
		await crumb.getByRole('button', { name: 'Back to apply.ts', exact: true }).click();
		await expect(applyTab).toHaveAttribute('aria-selected', 'true');
		// A file the PR did not change: the same tab, read only, every line, one column, no counts and no comments.
		await expect(
			page.locator('[data-side=new]', { hasText: 'return flags ? freeCount(items)' })
		).toBeVisible();
		await metaClickWord(page, 'return flags ? freeCount(items)', 'flags');
		const flagsTab = page.getByRole('tab', {
			name: 'Diff · src/features/ai/flags.ts',
			exact: true,
		});
		await expect(flagsTab).toHaveAttribute('aria-selected', 'true', { timeout: 20000 });
		const header = page.locator('section[data-font-surface=diff] header').first();
		await expect(header).toContainText('Unchanged in the PR');
		await expect(header).not.toContainText('+0');
		await expect(header.getByRole('radio', { name: 'Side by side' })).toBeDisabled();
		await expect(page.locator('[data-selected=true] [data-side=new]').first()).toContainText(
			'export const flags'
		);
		await expect(
			page.getByRole('button', { name: 'Open in editor · new:1', exact: true })
		).toHaveCount(1);
		await page.getByRole('button', { name: 'Open in editor · new:1', exact: true }).click();
		await expect(page.locator('[data-pr-new-comment]')).toHaveCount(0);
		// Nothing by that name in the PR head: a toast, no jump.
		await metaClickWord(page, 'export const flags', 'export');
		await expect(page.getByText('No definition found.')).toBeVisible();
		// Information, not success: no check glyph, role status.
		await expect(
			page.locator('[data-kind]').filter({ hasText: 'No definition found.' })
		).toHaveAttribute('data-kind', 'info');
		await expect(flagsTab).toHaveAttribute('aria-selected', 'true');
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('Resolve conflicts merges the base into the PR branch in a new worktree task and opens the Conflicts dialog; the agent gets the conflict in that task (spec/pull-requests-and-ci#resolve-conflicts, spec/appearance#evolution-redesign) @area:pr', async () => {
	test.setTimeout(150000);
	const { close, page, errors, root, repo } = await launchPRFixture({
		prs: fixturePRs().map((pr) =>
			pr.number === 421 ? { ...pr, mergeState: 'DIRTY', mergeable: 'CONFLICTING' } : pr
		),
	});
	try {
		// staging changes the same file the PR adds: an add/add conflict on src/loyalty/rules.ts.
		const remote = join(root, 'remotes', join(repo, 'apps/admin').replace(/\W/g, '_') + '.git'),
			clone = join(root, 'clone'),
			git = (...args: string[]) => promisify(execFile)('git', args, { cwd: clone });
		await promisify(execFile)('git', ['clone', '-q', '-b', 'staging', remote, clone]);
		await git('config', 'user.name', 'Fixture');
		await git('config', 'user.email', 'fixture@example.com');
		await mkdir(join(clone, 'src/loyalty'), { recursive: true });
		await writeFile(join(clone, 'src/loyalty/rules.ts'), 'export const everySecond = false;\n');
		await git('add', '.');
		await git('commit', '-qm', 'loyalty: off on staging');
		await git('push', '-q', 'origin', 'staging');
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		await page.getByRole('button', { name: 'Overview', exact: true }).click();
		const card = page
			.locator('[data-pr-overview="421"]')
			.getByRole('region', { name: 'Merging', exact: true });
		await expect(card).toContainText('Conflicts with staging');
		const main = card.locator('[data-resolve-conflicts]');
		// spec/appearance#evolution-redesign: the dialog is the main way; the agent stays in the menu.
		await expect(main).toHaveAttribute('data-resolve-conflicts', 'manual');
		await expect(main).toContainText('Resolve conflicts…');
		await card.getByRole('button', { name: 'How to resolve', exact: true }).click();
		await page.getByRole('menuitemradio', { name: /Resolve in the dialog/ }).click();
		// A new task on the PR branch under its own name, the base merged in, the Conflicts dialog open in it.
		const dialog = page.locator('[data-conflicts-dialog]');
		await expect(dialog).toBeVisible({ timeout: 60000 });
		await expect(dialog.getByRole('heading')).toContainText(
			'Merging origin/staging into feat/loyalty-admin'
		);
		await expect(dialog.locator('[data-conflict-row="src/loyalty/rules.ts"]')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		const tasks = join(root, 'data/projects/project/tasks');
		let conflict: any = null;
		for (const id of await readdir(tasks)) {
			const task = JSON.parse(await readFile(join(tasks, id, 'task.json'), 'utf8')).task;
			if (task.prReview?.mode === 'conflicts') conflict = task;
		}
		expect(conflict).toMatchObject({
			title: 'Conflict #421 · Loyalty 1+1 in admin',
			prReview: { number: 421, base: 'staging' },
			launch: {
				isolation: 'worktree',
				baseRef: 'refs/brigadir-v2/pr/421',
				branch: 'feat/loyalty-admin',
			},
		});
		expect(conflict.prompt ?? '').toBe('');
		// The same PR again: the task of that branch takes it, no second task.
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		await page.getByRole('button', { name: 'Overview', exact: true }).click();
		await expect(card.locator('[data-resolve-conflicts]')).toHaveAttribute(
			'data-resolve-conflicts',
			'manual'
		);
		await card.locator('[data-resolve-conflicts]').click();
		await expect(dialog).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		expect((await readdir(tasks)).length).toBe(2);
		// «Доручити агенту» on the same PR: the files go to the agent of that task, marked so in the strip.
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		await page.getByRole('button', { name: 'Overview', exact: true }).click();
		await card.getByRole('button', { name: 'How to resolve', exact: true }).click();
		await page.getByRole('menuitemradio', { name: /Ask the agent to resolve/ }).click();
		await expect(page.locator('[data-toast-region]')).toContainText(
			'The agent is resolving the conflict.'
		);
		await expect
			.poll(async () =>
				JSON.stringify(
					(
						await page.evaluate((task) => window.brigadir.readSession(task as never), {
							projectId: 'project',
							id: conflict.id,
						})
					).records
				)
			)
			.toContain('Resolve the merge conflicts');
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

/** Runs git in a repo of the fixture. */
const gitIn = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });
/** Commits a file in a repo of the fixture and pushes the branch to origin, as a person does by hand. */
async function commitAndPush(repo: string, file: string, subject: string, branch?: string) {
	if (branch) await gitIn(repo, 'switch', '-c', branch);
	await writeFile(join(repo, file), `${subject}\n`);
	await gitIn(repo, 'add', '.');
	await gitIn(repo, 'commit', '-m', subject);
	await gitIn(repo, 'push', '-u', 'origin', 'HEAD');
}
/** The forge reads again on window focus (spec/pull-requests-and-ci#reading-and-refresh): the same signal a person gives coming back from the terminal. */
async function refocus(page: Page) {
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
/** How many times the PR was read from GitHub (one GraphQL query of the PR detail each). */
const detailReads = async (state: string) =>
	(await readFile(`${state}.log`, 'utf8'))
		.split('\n')
		.filter((line) => line.includes('$number:Int!')).length;

test('the PR tab has «+ PR» and a card of a pushed branch; the main tree makes a PR of its current branch; × hides the card until the next push (spec/pull-requests-and-ci#ready-card) @area:pr', async () => {
	test.setTimeout(120000);
	const fixture = await launchPRFixture({ task: false });
	const { app, page, repo, errors } = fixture;
	try {
		const admin = join(repo, 'apps/admin'),
			kit = join(repo, 'kit');
		// A commit on the current branch, pushed from the terminal; no task.
		await commitAndPush(admin, 'src/features/ai/gate.ts', 'Gate the AI chat behind its flag');
		await openMainTree(app, page, 'choice');
		await openPanelTab(page, 'prs');
		const panel = page.locator('[data-pr-panel="list"]'),
			button = panel.locator('[data-new-pr]'),
			card = panel.locator('[data-new-pr-card]');
		await refocus(page);
		await expect(card).toHaveCount(1);
		await expect(card).toHaveAttribute('data-new-pr-card', 'apps/admin');
		await expect(card).toContainText('fix/ai-chat-flag-gating');
		await expect(button).toBeEnabled();

		// × hides it, a re-read keeps it hidden, the next push brings it back.
		await card.getByRole('button', { name: 'Hide until the next push', exact: true }).click();
		await expect(card).toHaveCount(0);
		await expect(button).toBeEnabled();
		await refocus(page);
		await page.waitForTimeout(500); // nothing must come back on a re-read of the same push
		await expect(card).toHaveCount(0);
		await commitAndPush(admin, 'src/features/ai/gate2.ts', 'Cover the flag with a test');
		await refocus(page);
		await expect(card).toHaveCount(1);

		// Two ready repos: the button is a menu. A repo with nothing ahead stays enabled and names its reason: the dialog
		// picks another pair From → Into (spec/pull-requests-and-ci#from-into).
		await commitAndPush(kit, 'src/Button/ring.css', 'Focus ring token', 'feat/focus-ring');
		await refocus(page);
		await expect(panel.locator('[data-new-pr-card]')).toHaveCount(2);
		await expect(panel.locator('[data-new-pr-card="kit"]')).toHaveCount(1);
		await button.click();
		const menu = page.getByRole('menu', { name: 'New PR', exact: true });
		await expect(menu).toBeVisible();
		await expect(menu.getByRole('menuitem', { name: /^apps\/admin/ })).toBeEnabled();
		await expect(menu.getByRole('menuitem', { name: /^kit/ })).toBeEnabled();
		await expect(menu.getByRole('menuitem', { name: /^choice/ })).toBeEnabled();
		await expect(menu.getByRole('menuitem', { name: /^choice/ })).toContainText(
			'No commits ahead of base'
		);
		await menu.getByRole('menuitem', { name: /^apps\/admin/ }).click();

		// The main tree's PR: head is the current branch; title and description come from the commits.
		const dialog = page.getByRole('dialog', { name: 'New pull request', exact: true });
		await expect(dialog).toContainText('fix/ai-chat-flag-gating');
		await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
			'Ai chat flag gating'
		);
		await expect(dialog.locator('#pr-description')).toHaveValue(
			'- Gate the AI chat behind its flag\n- Cover the flag with a test'
		);
		await dialog.getByRole('button', { name: 'Create PR', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect
			.poll(async () =>
				(await fixture.gh()).prs?.map((pr: { headRefName: string }) => pr.headRefName)
			)
			.toEqual(['fix/ai-chat-flag-gating']);
		// The admin card is gone with its open PR; the kit card stays, now alone.
		await expect(card).toHaveCount(1);
		await expect(card).toHaveAttribute('data-new-pr-card', 'kit');
		expect(errors).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test('a PR file opens its tab at the click, waits visibly, and shows a failure with Retry in the diff area (spec/pull-requests-and-ci#pr-files) @area:pr', async () => {
	test.setTimeout(120000);
	const { close, page, errors, repo } = await launchPRFixture();
	const admin = join(repo, 'apps/admin');
	try {
		// The remote does not answer: the prefetch and the first file fail.
		await gitIn(admin, 'config', 'remote.origin.uploadpack', 'false');
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		await page.locator('[data-pr-panel]').getByRole('tab', { name: 'Files', exact: true }).click();
		const loyalty = page.locator('[data-pr-file="src/loyalty/LoyaltyRule.tsx"]'),
			rules = page.locator('[data-pr-file="src/loyalty/rules.ts"]');
		const loyaltyTab = page.getByRole('tab', {
				name: 'Diff · src/loyalty/LoyaltyRule.tsx',
				exact: true,
			}),
			rulesTab = page.getByRole('tab', { name: 'Diff · src/loyalty/rules.ts', exact: true });
		await loyalty.click();
		await expect(loyaltyTab).toHaveAttribute('aria-selected', 'true');
		const failure = page.locator('[data-pr-opening="failed"]');
		await expect(failure.getByRole('alert')).toBeVisible();
		await expect(loyalty).not.toHaveAttribute('aria-busy', 'true');

		// A slow remote: the tab, the row and the diff area show the opening at once.
		await gitIn(admin, 'config', 'remote.origin.uploadpack', 'sleep 3; git-upload-pack');
		const started = Date.now();
		await failure.getByRole('button', { name: 'Retry', exact: true }).click();
		const opening = page.locator('[data-pr-opening="branch"]');
		await expect(opening).toBeVisible({ timeout: 1000 });
		expect(Date.now() - started).toBeLessThan(1500);
		await expect(opening.getByRole('status')).toBeVisible();
		await expect(loyalty).toHaveAttribute('aria-busy', 'true');
		await expect(loyalty).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('[role="tab"] [data-opening]')).toHaveCount(1);
		// A click on another file replaces the tab that never got its diff: one placeholder, and only the last file opens.
		await rules.click();
		await expect(rulesTab).toHaveAttribute('aria-selected', 'true');
		await expect(rules).toHaveAttribute('aria-busy', 'true');
		await expect(page.locator('[role="tab"] [data-opening]')).toHaveCount(1);
		await expect(page.locator('[data-pr-opening]')).toHaveCount(0, { timeout: 15000 });
		await expect(page.locator('section[data-font-surface="diff"]')).toContainText('everySecond');
		await expect(rules).not.toHaveAttribute('aria-busy', 'true');
		await expect(rules).toHaveAttribute('aria-pressed', 'true');
		await expect(rulesTab).toHaveCount(1);
		// The failed tab of the first file stays the person's tab; its next click reads the diff from the fetched trees.
		await loyalty.click();
		await expect(page.locator('[data-pr-thread]').first()).toContainText('olena-p', {
			timeout: 5000,
		});
		await expect(page.locator('[data-pr-opening]')).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('«Viewed» flips at the click, shows a slow save, keeps the PR without a new read and rolls back a failure (spec/pull-requests-and-ci#pr-files) @area:pr', async () => {
	test.setTimeout(120000);
	const { close, page, errors, state, gh, setGh } = await launchPRFixture();
	try {
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		await page.locator('[data-pr-panel]').getByRole('tab', { name: 'Files', exact: true }).click();
		const caption = page.locator('[data-pr-viewed-caption]');
		await expect(caption).toContainText('1 of 2');
		const rules = page.getByRole('checkbox', {
				name: 'Viewed · src/loyalty/rules.ts',
				exact: true,
			}),
			loyalty = page.getByRole('checkbox', {
				name: 'Viewed · src/loyalty/LoyaltyRule.tsx',
				exact: true,
			});
		await setGh({ viewedDelay: 1500 });
		const reads = await detailReads(state);
		await rules.click();
		// At once: the mark and the count; while GitHub is slow the box says it saves.
		await expect(rules).toBeChecked({ timeout: 200 });
		await expect(caption).toContainText('2 of 2', { timeout: 200 });
		await expect(rules).toHaveAttribute('data-saving', 'true', { timeout: 1000 });
		await expect(rules).not.toHaveAttribute('data-saving', 'true', { timeout: 5000 });
		await expect(rules).toBeChecked();
		expect(
			(await gh()).writes.some(
				(write: { mutation?: string; args?: string[] }) =>
					write.mutation?.includes('markFileAsViewed') &&
					write.args?.includes('path=src/loyalty/rules.ts')
			)
		).toBe(true);
		// One mutation, no read of the whole PR after it.
		expect(await detailReads(state)).toBe(reads);

		// GitHub does not save: the mark returns, the box is marked failed, a toast names the file (spec/notifications-slack-notes-and-schedules#message-classes); its Retry saves it.
		await setGh({ viewedDelay: 600, viewedError: 'Fixture GitHub network error' });
		await loyalty.click();
		await expect(loyalty).not.toBeChecked({ timeout: 200 });
		await expect(caption).toContainText('1 of 2', { timeout: 200 });
		const alert = page
			.locator('[data-toast-region]')
			.getByRole('alert')
			.filter({ hasText: 'LoyaltyRule.tsx' });
		await expect(alert).toBeVisible();
		await expect(loyalty).toBeChecked();
		await expect(loyalty).toHaveAttribute('data-failed', 'true');
		await expect(caption).toContainText('2 of 2');
		await setGh({ viewedDelay: 0, viewedError: null });
		await alert.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(alert).toHaveCount(0);
		await expect(loyalty).not.toBeChecked();
		await expect(loyalty).not.toHaveAttribute('data-failed', 'true');
		await expect
			.poll(
				async () =>
					(await gh()).pullRequests
						.find((pr: { number: number }) => pr.number === 421)
						.files.find((file: { path: string }) => file.path === 'src/loyalty/LoyaltyRule.tsx')
						.viewed
			)
			.toBe(false);
		await expect(caption).toContainText('1 of 2');
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});
