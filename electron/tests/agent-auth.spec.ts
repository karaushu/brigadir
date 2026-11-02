import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const shots = process.env.BRIGADIR_SHOTS;
// spec/agents-and-providers#sign-in-recovery: a turn that failed on the agent's sign-in is a card in the log; the sign-in runs in the app and the turn starts again.
test('an expired sign-in is a card with an in-app sign-in, code, failure and a retry that sends the message again @area:chat', async () => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-agent-auth-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task'),
		signed = join(root, 'signed-in'),
		login = join(root, 'login.mjs');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await writeFile(join(repo, 'file.txt'), 'one\n');
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Auth fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	// The sign-in command: prints the page, takes a code; `bad` ends without a sign-in.
	await writeFile(
		login,
		`import {writeFileSync} from 'node:fs';console.log('Opening browser to sign in…');console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=e2e");process.stdin.on('data',chunk=>{if(String(chunk).trim()==='bad')process.exit(1);writeFileSync(${JSON.stringify(signed)},'');process.exit(0);});`
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_TEST_AUTH_FILE: signed,
			BRIGADIR_TEST_LOGIN: login,
		},
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Auth fixture/ }).click();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true }),
			log = page.getByRole('log', { name: 'Conversation' }),
			card = log.locator('[data-auth-card]');
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await message.fill('auth please add a test');
		await message.press('Enter');
		// The card says which sign-in; the CLI's own text is its detail, not a message; no amber «Authentication required» strip.
		await expect(card).toBeVisible();
		await expect(card).toHaveAttribute('data-state', 'failed');
		await expect(card).toContainText('Claude asks you to sign in again');
		await expect(card).toContainText('Claude Code · subscription');
		await expect(card).toContainText('Sign in again to resend automatically.');
		await expect(
			log.getByText('Failed to authenticate: OAuth session expired and could not be refreshed')
		).toHaveCount(0);
		await expect(page.getByText('Authentication required', { exact: true })).toHaveCount(0);
		const details = card.getByRole('button', { name: 'Details' });
		await expect(details).toHaveAttribute('aria-expanded', 'false');
		await details.click();
		await expect(card.locator('pre')).toHaveText(
			'Failed to authenticate: OAuth session expired and could not be refreshed'
		);
		// Rule 15: the link's hover covers the link.
		const linkBox = await details.boundingBox();
		await details.hover();
		// The hover tint fades in (--motion-fast): poll instead of reading the first frame.
		await expect
			.poll(() => details.evaluate((element) => getComputedStyle(element).backgroundColor))
			.not.toBe('rgba(0, 0, 0, 0)');
		expect(linkBox!.height).toBe(28);
		await details.click();
		await expect(card.locator('pre')).toHaveCount(0);
		// The sidebar names the sign-in.
		const row = page.locator('[data-sidebar-task="task"]');
		await expect(row).toHaveAttribute('data-status', 'failed');
		await expect(row.locator('[data-sign-in]').first()).toBeVisible();
		await expect(row).toContainText('Claude sign-in needed');
		// spec/notifications-slack-notes-and-schedules#notice-chips: while the sign-in waits, the composer keeps a chip; it does not open by itself (the card is the first showing).
		const chip = page.locator('[data-auth-chip]'),
			popover = page.getByRole('dialog', { name: 'Claude asks you to sign in again', exact: true });
		await expect(chip).toHaveText('Claude · sign-in needed');
		await expect(popover).toHaveCount(0);
		await chip.click();
		await expect(popover).toHaveAttribute('data-notice-popover', 'click');
		await expect(popover.locator('[data-auth-card="popover"]')).toHaveAttribute(
			'data-state',
			'failed'
		);
		await expect(popover.getByRole('button', { name: 'Sign in to Claude…' })).toBeVisible();
		await expect(popover.getByRole('button', { name: 'Try again' })).toBeVisible();
		if (shots)
			for (const theme of ['dark', 'light'] as const) {
				await app.evaluate(({ nativeTheme }, theme) => {
					nativeTheme.themeSource = theme;
				}, theme);
				await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
				await page.screenshot({ path: join(shots, `auth-chip-${theme}.png`) });
			}
		await page.keyboard.press('Escape');
		await expect(popover).toHaveCount(0);
		await expect(chip).toBeFocused();
		if (shots)
			for (const theme of ['dark', 'light'] as const) {
				await app.evaluate(({ nativeTheme }, theme) => {
					nativeTheme.themeSource = theme;
				}, theme);
				await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
				await page.mouse.move(5, 700);
				await page.screenshot({ path: join(shots, `auth-window-${theme}.png`) });
				await card.screenshot({ path: join(shots, `auth-card-${theme}.png`) });
			}
		// Sign in: waiting, the page again, a code; a code that does not sign in is «not finished».
		await card.getByRole('button', { name: 'Sign in to Claude…' }).click();
		await expect(card).toHaveAttribute('data-state', 'waiting');
		await expect(card).toContainText('Waiting for browser sign-in…');
		await expect(card.getByRole('button', { name: 'Open the page again' })).toBeVisible();
		if (shots)
			await card.screenshot({ path: join(shots, 'auth-waiting-dark.png') }).catch(() => {});
		await card.getByRole('button', { name: 'Enter the code' }).click();
		const code = card.getByLabel('Code from the page');
		await expect(code).toBeFocused();
		if (shots) await card.screenshot({ path: join(shots, 'auth-code.png') });
		await code.fill('bad');
		await card.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(card).toHaveAttribute('data-state', 'relogin');
		await expect(page.locator('[data-toast-region]').getByRole('alert')).toContainText(
			'Sign-in incomplete'
		);
		if (shots) await card.screenshot({ path: join(shots, 'auth-relogin.png') });
		// Retry without a sign-in fails the same way and keeps one card.
		await card.getByRole('button', { name: 'Try again' }).click();
		await expect(log.locator('[data-auth-row="past"]')).toHaveCount(1);
		await expect(card).toHaveCount(1);
		// A sign-in that works: the host retries by itself, the card becomes a row, the turn ends with the agent's answer.
		await card.getByRole('button', { name: 'Sign in to Claude…' }).click();
		await card.getByRole('button', { name: 'Enter the code' }).click();
		await card.getByLabel('Code from the page').fill('abc-123');
		await card.getByLabel('Code from the page').press('Enter');
		await expect(log.locator('[data-auth-row="retried"]')).toContainText(
			'Signed in to Claude. Message resent.'
		);
		await expect(log.getByText('Signed in: auth please add a test')).toBeVisible();
		await expect(card).toHaveCount(0);
		await expect(row.locator('[data-sign-in]')).toHaveCount(0);
		await expect(page.locator('[data-auth-chip]')).toHaveCount(0);
		if (shots)
			await log
				.locator('[data-auth-row="retried"]')
				.screenshot({ path: join(shots, 'auth-done.png') });
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
