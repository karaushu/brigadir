import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ago, fixturePRs, launchPRFixture } from './pr-fixture';
// @ts-expect-error — a plain .mjs fixture shared with the forge unit tests
import { stagingActions } from '../packages/forge/fixtures/actions.mjs';
import { repoPRs } from './repos';

const sha = 'b2d2ffe'.padEnd(40, '0');
const merged = () =>
	fixturePRs().map((pr) =>
		pr.number === 421
			? {
					...pr,
					state: 'MERGED',
					closedAt: ago(18),
					mergeSha: sha,
					checkRuns: [{ name: 'build' }, { name: 'e2e-admin' }],
				}
			: pr
	);

test('a merged PR shows the runs on its merge commit down to the steps and the deploy; the CI segment lists the repo runs (spec/pull-requests-and-ci#ci) @area:pr', async () => {
	test.setTimeout(150000);
	const { app, close, page, errors, setGh, state } = await launchPRFixture({ prs: merged() });
	try {
		await setGh({ actions: stagingActions(sha, { repo: 'admin' }) });
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		// The header says where the deploy is instead of the checks count.
		await expect(page.locator('[data-pr-panel="detail"] [data-ci-state="running"]')).toContainText(
			'deploy 5/8'
		);
		await page.getByRole('tab', { name: 'Checks', exact: true }).click();
		const panel = page.locator('[data-pr-panel="detail"] [role=tabpanel]');
		await expect(panel.getByText('After merge', { exact: true })).toBeVisible();
		await expect(panel.getByText('Updates while the run is going', { exact: true })).toBeVisible();
		const band = panel.locator('[data-ci-deploy]');
		await expect(band).toHaveAttribute('data-ci-deploy', 'running');
		await expect(band).toContainText('Deploying to staging');
		await expect(band).toContainText('deploy-staging · Push to ECR · step 5 of 8');
		const deploy = panel.locator('[data-ci-job="deploy-staging"]');
		await expect(deploy).toHaveAttribute('data-open', 'true');
		await expect(deploy.getByRole('listitem')).toHaveCount(8);
		await expect(deploy.locator('[role=listitem][data-state="running"]')).toContainText(
			'Push to ECR'
		);
		await expect(panel.locator('[data-ci-job="build"]')).not.toHaveAttribute('data-open', 'true');
		// The PR's own checks stay below, folded.
		await expect(panel.getByText('PR · before merge', { exact: true })).toBeVisible();
		await expect(panel.getByText('e2e-admin', { exact: true })).toHaveCount(0);
		await panel.getByRole('button', { name: /· 2$/ }).click();
		await expect(panel.getByText('e2e-admin', { exact: true })).toBeVisible();

		// spec/pull-requests-and-ci#ci-bell: the bell on a running run watches it; main keeps the watch, the bell turns on.
		const bell = panel.locator('[data-ci-bell]');
		await expect(bell).toHaveAttribute('data-ci-bell', 'off');
		await bell.click();
		await expect(bell).toHaveAttribute('data-ci-bell', 'on');
		await expect(bell).toHaveAccessibleName('Stop notifying');
		expect(await page.evaluate(() => window.brigadir.readCIWatches())).toMatchObject([
			{ runId: 1068, label: '#421' },
		]);
		// While the run goes, the tab reads it again every 10 s with no focus or click; the deploy that fails is a toast.
		const reads = async () =>
			(await readFile(`${state}.log`, 'utf8'))
				.split('\n')
				.filter((line) => line.includes('actions/runs/1068/jobs')).length;
		const before = await reads();
		await setGh({ actions: stagingActions(sha, { repo: 'admin', kind: 'fail' }) });
		await expect.poll(reads, { timeout: 15000 }).toBeGreaterThan(before);
		// The bell's watch in main reads every second here; the tab itself reads every 10 s.
		await expect(band).toHaveAttribute('data-ci-deploy', 'fail', { timeout: 15000 });
		await expect(band).toContainText('Deploy to staging failed');
		// spec/pull-requests-and-ci#ci-bell: the run has a bell — main tells about its end (toast + OS notice), the tab gives no toast of its own.
		const toast = page
			.getByRole('alert')
			.filter({ hasText: 'Staging Pipeline #1068 failed. Deploy to staging failed' });
		await expect(toast).toBeVisible();
		await expect(toast.getByRole('button', { name: 'Open the run', exact: true })).toBeVisible();
		await expect(
			page.getByRole('alert').filter({ hasText: 'Deploy to staging failed.' })
		).toHaveCount(0);
		await expect
			.poll(() =>
				app.evaluate(() =>
					(globalThis as any).brigadirNotifications.shown.map((item: any) => item.notice.title)
				)
			)
			.toEqual(['Staging Pipeline #1068 failed']);
		await expect(bell).toHaveCount(0);
		expect(await page.evaluate(() => window.brigadir.readCIWatches())).toEqual([]);
		// The failed step, the GitHub annotation and the two actions under it; the steps after it are skipped.
		await expect(deploy.locator('[role=listitem][data-state="fail"]')).toContainText(
			'Deploy to ECS'
		);
		await expect(deploy.locator('[role=listitem][data-state="skipped"]')).toContainText(
			'Wait for service stability'
		);
		await expect(
			deploy.getByText('ECS service choice-admin-staging did not stabilize: 0/2 tasks running')
		).toBeVisible();
		await expect(deploy.getByRole('button', { name: 'Log on GitHub', exact: true })).toBeVisible();
		await expect(deploy.getByRole('button', { name: 'Agent fixes it', exact: true })).toBeVisible();
		await expect(page.locator('[data-pr-panel="detail"] [data-ci-state="fail"]')).toContainText(
			'deploy failed'
		);

		// Overview of the merged PR — the deploy line in the Merging card and in the timeline.
		await page.getByRole('button', { name: 'Overview', exact: true }).click();
		await expect(page.locator('[data-ci-deploy-fact]')).toContainText('Deploy to staging failed');
		await expect(page.locator('[data-ci-event="fail"]')).toContainText(
			'Deploy to staging failed · Deploy to ECS'
		);

		// The CI segment — runs of the repo, mine and the others; a run opens its page and goes back.
		await page.getByRole('button', { name: 'Back to the list', exact: true }).click();
		// spec/pull-requests-and-ci#pr-panel: the segment lives in the header row, not in a row of its own.
		await expect(
			page
				.locator('[data-pr-panel="list"] > header')
				.getByRole('tablist', { name: 'Pull requests' })
		).toBeVisible();
		await page.getByRole('tab', { name: 'CI', exact: true }).click();
		const runs = page.getByRole('list', { name: 'Workflow runs', exact: true });
		await expect(
			runs.getByRole('group', { name: 'Yours', exact: true }).locator('[data-ci-run]')
		).toHaveCount(1);
		await expect(
			runs.getByRole('group', { name: 'Others', exact: true }).locator('[data-ci-run]')
		).toHaveCount(1);
		await expect(page.getByRole('button', { name: 'Find a PR', exact: true })).toHaveCount(0);
		// spec/pull-requests-and-ci#ci-segment: New PR stays in the CI header; the filters are as wide as their text, not fields of 170.
		await expect(page.locator('[data-pr-panel="list"] > header [data-new-pr]')).toBeVisible();
		expect(
			(await page.getByRole('button', { name: 'Branch', exact: true }).boundingBox())!.width
		).toBeLessThan(140);
		await runs.locator('[data-ci-run="1068"]').click();
		const run = page.locator('[data-ci-run-page="1068"]');
		await expect(run.locator('[data-ci-job="deploy-staging"]')).toHaveAttribute(
			'data-open',
			'true'
		);
		await page.getByRole('button', { name: 'Back to the runs', exact: true }).click();
		await expect(runs.locator('[data-ci-run]')).toHaveCount(2);
		await page.getByRole('tab', { name: 'Pull requests', exact: true }).click();
		await expect(page.locator('[data-pr-row="421"]')).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});

test('a repo with Actions off has no runs, not an error; an open PR keeps its checks tab as it was (spec/pull-requests-and-ci#ci) @area:pr', async () => {
	test.setTimeout(120000);
	const { close, page, errors, setGh } = await launchPRFixture();
	try {
		await setGh({ actions: { disabled: true } });
		await repoPRs(page, 'apps/admin');
		await page.getByRole('tab', { name: 'CI', exact: true }).click();
		await expect(page.getByText('No runs', { exact: true })).toBeVisible();
		await page.getByRole('tab', { name: 'Pull requests', exact: true }).click();
		await page.locator('[data-pr-row="421"]').click();
		await page.getByRole('tab', { name: 'Checks', exact: true }).click();
		await expect(page.getByText('After merge', { exact: true })).toHaveCount(0);
		await expect(
			page.locator('[data-pr-panel="detail"] [role=tabpanel] [data-check][data-state="fail"]')
		).toContainText('e2e-admin');
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});
