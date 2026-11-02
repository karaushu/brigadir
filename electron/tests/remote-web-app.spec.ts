import { expect, test, type Page } from '@playwright/test';
import { join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	freePorts,
	launch,
	machine,
	menuAction,
	openRemoteSettings,
	pairPhone,
	phoneAt,
	type PhoneLook,
} from './remote-fixture';

/**
 * spec/remote-access-and-mobile#phone-app: the phone after it signs in — home as the sidebar, the task's chat on the fixture agent (a message, a message
 * into the running turn, a question and a permission answered on the phone), the task's menu sheet closed by × and by the
 * system «back», a new task. One run as an iPhone (390 × 844, dark, the Home Screen step) and one as an Android phone
 * (360 × 800, light). Screenshots of each frame land in the test's output for visual comparison.
 */
const phones: { name: string; look: PhoneLook; ios: boolean }[] = [
	{
		name: 'iPhone 390 dark',
		ios: true,
		look: {
			size: '390x844',
			dark: true,
			agent:
				'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
		},
	},
	{
		name: 'Android 360 light',
		ios: false,
		look: {
			size: '360x800',
			dark: false,
			agent:
				'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
		},
	},
];
const state = (page: Page) => page.locator('#root');

/**
 * spec/remote-access-and-mobile#phone-network: a phone pairs with the working machine in the browser — the code through CPace, then a passkey — and
 * signs in with that passkey on each visit; its calls meet the web class; revoking it on the machine shuts it out.
 * The phone is a hidden Electron window with a virtual authenticator over CDP (WebAuthn.addVirtualAuthenticator).
 */
test('a phone pairs with the code and a passkey, signs in with it, calls web rows only and is shut out once revoked @area:settings', async ({}, info) => {
	test.setTimeout(120_000);
	const port = await freePorts();
	const webPort = port + 2;
	const studio = await machine('studio', true, 'Remote fixture task');
	const work = await launch(studio, port, {
		BRIGADIR_REMOTE_WEB_HOST: 'localhost',
		BRIGADIR_REMOTE_WEB_PORT: String(webPort),
	});
	let phone: Awaited<ReturnType<typeof phoneAt>> | null = null;
	try {
		const machineWindow = await work.firstWindow();
		const status = await machineWindow.evaluate(async () => {
			await window.brigadir.setRemoteAccess(true, 'correct horse battery');
			return window.brigadir.setRemotePhone(true);
		});
		expect(status.phone).toMatchObject({
			enabled: true,
			listening: true,
			host: 'localhost',
			error: null,
		});
		// spec/remote-access-and-mobile#phone-app: Settings ▸ Remote shows the phone's switch and its address in the tailnet.
		await menuAction(work, 'settings');
		const settings = machineWindow.getByRole('dialog', { name: 'Settings', exact: true });
		// spec/settings-modules-and-onboarding#module-settings-popup: remote access settings are the popup of Settings ▸ Modules ▸ Remote access ⚙.
		let remoteSettings = await openRemoteSettings(machineWindow);
		await expect(remoteSettings.locator('[data-remote-phone-status]')).toContainText(
			'https://localhost'
		);
		// spec/remote-access-and-mobile#tailscale-guidance: the steps tick what the machine sees — HTTPS and serve (the test host), not yet a phone.
		const step = (n: number) => remoteSettings.locator(`[data-remote-phone-step="${n}"]`);
		await expect(step(2)).toHaveAttribute('data-done', 'true');
		await expect(step(3)).toHaveAttribute('data-done', 'true');
		for (const n of [1, 4, 5]) await expect(step(n)).not.toHaveAttribute('data-done');
		await expect(step(5)).toContainText('https://localhost');
		await expect(step(3).locator('[data-remote-phone-command]')).toContainText('tailscale serve');
		await machineWindow.keyboard.press('Escape');
		await expect(remoteSettings).toBeHidden();
		await machineWindow.keyboard.press('Escape');
		await expect(settings).toBeHidden();
		phone = await phoneAt(`http://localhost:${webPort}/`, info.outputPath('phone-profile'));
		const { page } = phone;
		await expect(state(page)).toHaveAttribute('data-state', 'signin');

		// Pairing: the machine's code, then a passkey, then the person at the machine confirms.
		const pairing = await machineWindow.evaluate(() => window.brigadir.startRemotePairing());
		const code = (pairing as { code: string }).code;
		await page.locator('[data-pair-open]').click();
		// Typed key by key, as on a phone: the field stays the same focused node (no keyboard drop) and the order holds.
		const field = page.locator('[data-pair-code]');
		await field.click();
		const node = await field.elementHandle();
		await field.pressSequentially(code.toLowerCase(), { delay: 20 });
		expect(
			await node!.evaluate((input) => input.isConnected && document.activeElement === input)
		).toBe(true);
		await expect(field).toHaveValue(code);
		await expect(page.locator('[data-code-cells] > span')).toHaveText(code.split(''));
		await page.locator('[data-pair-submit]').click();
		await page.locator('[data-pair-create]').click();
		await expect(state(page)).toHaveAttribute('data-state', 'pair-wait');
		await expect
			.poll(() =>
				machineWindow.evaluate(async () => (await window.brigadir.readRemoteAccess()).pairing.state)
			)
			.toBe('confirm');
		await machineWindow.evaluate(() => window.brigadir.confirmRemotePairing(true, 'Test phone'));
		await expect(state(page)).toHaveAttribute('data-state', 'signin');
		const device = (await machineWindow.evaluate(() => window.brigadir.readRemoteAccess()))
			.devices[0]!;
		expect(device).toMatchObject({ kind: 'phone', name: 'Test phone' });
		// Paired: every step of the phone is ticked.
		await menuAction(work, 'settings');
		remoteSettings = await openRemoteSettings(machineWindow);
		await expect(remoteSettings.locator('[data-remote-phone-steps] li[data-done]')).toHaveCount(5);
		await machineWindow.keyboard.press('Escape');
		await machineWindow.keyboard.press('Escape');

		// A later visit: the passkey alone.
		await page.reload();
		await expect(page.locator('[data-signin]')).toBeEnabled();
		await page.locator('[data-signin]').click();
		await expect(state(page)).toHaveAttribute('data-state', 'app');
		await expect(page.locator('[data-project-frame]')).toHaveText([/repo/]);
		// A web row is answered; a row the phone may not call is refused on the machine.
		expect(
			await page.evaluate(async () => (await window.brigadir.readWorkspace()).projects.length)
		).toBe(1);
		expect(
			await page.evaluate(() =>
				window.brigadir.readKeepAwake().then(
					() => 'answered',
					(error: Error) => error.message
				)
			)
		).toContain('Not available from a phone.');
		expect(
			(await machineWindow.evaluate(() => window.brigadir.readRemoteAudit(50))).map(
				(entry) => entry.kind
			)
		).toEqual(expect.arrayContaining(['paired', 'login', 'call-refused']));

		// Revoked on the machine: the phone says so and offers pairing again; its passkey no longer opens anything.
		await machineWindow.evaluate((id) => window.brigadir.revokeRemoteDevice(id), device.id);
		await expect(state(page)).toHaveAttribute('data-state', 'revoked');
		await expect(page.locator('[data-pair-open]')).toBeVisible();
		await page.reload();
		await expect(page.locator('[data-signin]')).toBeEnabled();
		await page.locator('[data-signin]').click();
		await expect(page.locator('[data-note="error"]')).toBeVisible();
	} finally {
		await phone?.app.close();
		await work.close();
	}
});

/**
 * The phone's fixes (spec/remote-access-and-mobile#phone-app): the project screen from the home's
 * frame and the back label of each step, a crew's workers under the foreman and their attention in «Чекають тебе», a worker's
 * question and a proposed task answerable on the phone, the agent's plan readable before approval, «Повторити» after a
 * failed turn, links in the agent's answer that never take the app away, and the screen above the iOS keyboard (a simulated
 * `visualViewport` shrink). One run as an iPhone (390 × 844, touch) and one as an Android phone (360 × 800, touch).
 */
const crewAgent = (
	id: string,
	name: string,
	role: 'foreman' | 'developer',
	agents: unknown[] = []
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
	checkedBy: [],
	agents,
});
const journal = (events: unknown[]) =>
	events
		.map((event, index) =>
			JSON.stringify({
				schemaVersion: 1,
				seq: index + 1,
				at: new Date(Date.UTC(2026, 9, 16, 9, 0, index)).toISOString(),
				event,
			})
		)
		.join('\n') + '\n';
/** The fixture machine: the chat task, a crew (its foreman waits on a worker's escalated question) and a task with links. */
async function phoneMachine(scenarioTask: string) {
	const at = await machine('studio', true, scenarioTask);
	const repo = join(at.root, 'repo'),
		git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await mkdir(join(repo, 'src'), { recursive: true });
	await writeFile(join(repo, 'src/app.ts'), 'export const answer = 42;\n');
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await git('add', '.');
	await git('commit', '-m', 'Baseline');
	const tasks = join(at.data, 'projects/project/tasks');
	const at_ = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
	// No provider on the seeded tasks: main keeps their status instead of finding no host (`interrupted`).
	const seeds: Record<string, unknown>[] = [
		{
			id: 'crew',
			projectId: 'project',
			title: 'Split kit exports',
			prompt: 'Split kit exports',
			status: 'done',
			crew: {
				schemaVersion: 1,
				templateId: null,
				name: 'Kit crew',
				resolvedAt: '2026-10-16T09:00:00Z',
				root: crewAgent('foreman', 'Foreman', 'foreman', [
					crewAgent('d1', 'Developer 1', 'developer'),
					crewAgent('d2', 'Developer 2', 'developer'),
				]),
			},
			updatedAt: at_(1),
		},
		{
			id: 'w-ask',
			projectId: 'project',
			title: 'Export buttons',
			prompt: 'Export buttons',
			status: 'needs-you',
			crewTaskId: 'crew',
			crewNodeId: 'd1',
			parentTaskId: 'crew',
			updatedAt: at_(2),
		},
		{
			id: 'w-done',
			projectId: 'project',
			title: 'Export inputs',
			prompt: 'Export inputs',
			status: 'done',
			crewTaskId: 'crew',
			crewNodeId: 'd2',
			parentTaskId: 'crew',
			updatedAt: at_(3),
		},
		{
			id: 'links',
			projectId: 'project',
			title: 'Links task',
			prompt: 'Where is it?',
			status: 'done',
			updatedAt: at_(4),
		},
	];
	for (const task of seeds) {
		await mkdir(join(tasks, String(task.id)), { recursive: true });
		await writeFile(
			join(tasks, String(task.id), 'task.json'),
			JSON.stringify({ schemaVersion: 1, task })
		);
	}
	await writeFile(
		join(tasks, 'crew/events.jsonl'),
		journal([
			{ kind: 'turn.started', text: 'Split kit exports' },
			{
				kind: 'crew.question.requested',
				question: {
					id: 'q1',
					workerTaskId: 'w-ask',
					parentTaskId: 'crew',
					callId: 'call-1',
					agent: 'Developer 1',
					question: 'Which endpoint do the buttons call?',
					options: ['/v1', '/v2'],
					createdAt: '2026-10-16T09:00:01.000Z',
					escalateAt: '2026-10-16T09:05:01.000Z',
					state: 'pending',
				},
			},
			{ kind: 'turn.completed', reason: 'end_turn' },
			{ kind: 'crew.question.escalated', id: 'q1' },
		])
	);
	await writeFile(
		join(tasks, 'links/events.jsonl'),
		journal([
			{ kind: 'turn.started', text: 'Where is it?' },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'answer',
				content: {
					kind: 'text',
					text: 'It is in [the app file](src/app.ts:1). The [docs page](https://example.com/docs) has more; [the top](#top) is here.',
				},
			},
			{ kind: 'turn.completed', reason: 'end_turn' },
			{ kind: 'host.stopped', reason: 'Fixture offline' },
		])
	);
	return at;
}
async function signedIn(page: Page, machineWindow: Page) {
	await expect(page.locator('#root')).toHaveAttribute('data-state', 'signin');
	await pairPhone(machineWindow, page, 'Phone Dev');
	await page.locator('[data-signin]').click();
	await expect(page.locator('#root')).toHaveAttribute('data-state', 'app');
}
const backLabel = (page: Page) =>
	page.locator('[data-screen]:not([data-screen="home"]) [data-back]').first();

for (const phone of phones)
	test(`the phone (${phone.name}) reaches the project, shows the crew's workers, answers every «needs you», retries a failed turn and keeps the app on links and above the keyboard @area:chat`, async ({}, info) => {
		test.setTimeout(300_000);
		const shot = (page: Page, name: string) =>
			page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
		const port = await freePorts();
		const webPort = port + 2;
		const studio = await phoneMachine('Steering task');
		const work = await launch(studio, port, {
			BRIGADIR_REMOTE_WEB_HOST: 'localhost',
			BRIGADIR_REMOTE_WEB_PORT: String(webPort),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		});
		let device: Awaited<ReturnType<typeof phoneAt>> | null = null;
		try {
			const machineWindow = await work.firstWindow();
			await machineWindow.evaluate(async () => {
				await window.brigadir.setRemoteAccess(true, 'correct horse battery');
				return window.brigadir.setRemotePhone(true);
			});
			device = await phoneAt(
				`http://localhost:${webPort}/`,
				info.outputPath('profile'),
				phone.look
			);
			const { page } = device;
			const errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			await signedIn(page, machineWindow);
			expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);

			// The crew on the home: the workers under the foreman, the foreman amber for its waiting worker, and the worker
			// counted in «Чекають тебе» — one, so the row opens that worker.
			const crew = page.locator('[data-crew-workers="crew"]');
			await expect(crew.locator('[data-worker-row]')).toHaveCount(2);
			await expect(crew.locator('[data-worker-row="w-ask"]')).toContainText('Export buttons');
			await expect(page.locator('[data-task-card="crew"]')).toHaveAttribute(
				'data-crew-attention',
				'true'
			);
			await expect(page.locator('[data-attention]')).toContainText('1');
			await shot(page, 'home-crew');
			await page.locator('[data-attention]').click();
			await expect(page.locator('[data-screen="task"]')).toHaveAttribute('data-task', 'w-ask');
			await expect(backLabel(page)).toHaveAttribute('aria-label', /Projects$/);
			await page.goBack();
			await expect(page.locator('[data-screen="home"]')).toBeVisible();

			// The project's frame: the chevron folds it, the name opens the project screen and back names each step.
			await page.locator('[data-project-fold]').click();
			await expect(page.locator('[data-task-card]')).toHaveCount(0);
			await page.locator('[data-project-fold]').click();
			await expect(page.locator('[data-task-card="task"]')).toBeVisible();
			await page.locator('[data-project-open]').click();
			const project = page.locator('[data-screen="project"]');
			await expect(project).toBeVisible();
			await expect(project.locator('[data-crew-workers="crew"] [data-worker-row]')).toHaveCount(2);
			await expect(project.getByRole('group', { name: 'Needs you' })).toContainText(
				'Split kit exports'
			);
			await shot(page, 'project');
			await project.locator('[data-task-card="task"]').click();
			await expect(page.locator('[data-screen="task"]')).toHaveAttribute('data-task', 'task');
			await expect(backLabel(page)).toHaveAttribute('aria-label', /: repo$/);

			// A failed turn has «Повторити»: the same prompt goes again (and fails again in the fixture).
			const field = page.locator('[data-composer] textarea');
			await field.fill('fail');
			await page.locator('[data-send]').click();
			const failed = page.locator('[data-turn-failed]');
			await expect(failed).toHaveCount(1, { timeout: 30_000 });
			await expect(failed.locator('[data-retry-turn]')).toBeVisible();
			await shot(page, 'failed-turn');
			await failed.locator('[data-retry-turn]').click();
			await expect(failed).toHaveCount(2, { timeout: 30_000 });
			await expect(page.locator('[data-retry-turn]')).toHaveCount(1);

			// The agent's plan is read before «Погодити».
			await field.fill('plan');
			await page.locator('[data-send]').click();
			const plan = page.locator('[data-permission-id] [data-plan-text]');
			await expect(plan).toContainText('Keep the focus ring in Safari', { timeout: 30_000 });
			await expect(plan.locator('h2').first()).toBeVisible();
			await shot(page, 'plan');
			await page
				.locator('[data-permission-id]')
				.getByRole('button', { name: 'Yes, manually approve edits' })
				.click();
			await expect(page.locator('[data-permission-id]')).toHaveCount(0, { timeout: 30_000 });

			// The iOS keyboard as Safari reports it: the visible viewport shrinks, the app follows it — the header stays at the
			// top, the composer right above the keyboard, without the home indicator's inset.
			const shrink = (height: number | null) =>
				page.evaluate((height) => {
					const viewport = window.visualViewport!;
					if (height === null) delete (viewport as unknown as Record<string, unknown>).height;
					else Object.defineProperty(viewport, 'height', { configurable: true, get: () => height });
					viewport.dispatchEvent(new Event('resize'));
				}, height);
			const keyboardTop = phone.ios ? 844 - 336 : 800 - 300;
			await shrink(keyboardTop);
			await expect(page.locator('html')).toHaveAttribute('data-keyboard', '');
			// One invariant: the composer is not under the keyboard.
			await expect
				.poll(async () => {
					const composer = await page.locator('[data-composer]').boundingBox();
					return composer ? composer.y + composer.height <= keyboardTop : false;
				})
				.toBe(true);
			await shot(page, 'keyboard-chat');
			await shrink(null);
			await expect(page.locator('html')).not.toHaveAttribute('data-keyboard', '');

			// Back to the project, then the links task: no link takes the app away.
			await page.locator('[data-back]').click();
			await expect(project).toBeVisible();
			await project.locator('[data-task-card="links"], [data-quiet-row="links"]').first().click();
			await expect(page.locator('[data-screen="task"]')).toHaveAttribute('data-task', 'links');
			await page.evaluate(() => {
				const opened: string[] = [];
				(window as unknown as { opened: string[] }).opened = opened;
				window.open = (url?: string | URL) => {
					opened.push(String(url));
					return null;
				};
			});
			const chat = page.locator('[data-chat]');
			const address = page.url();
			await chat.getByRole('link', { name: 'docs page' }).click();
			await expect
				.poll(() => page.evaluate(() => (window as unknown as { opened: string[] }).opened))
				.toEqual(['https://example.com/docs']);
			await chat.getByRole('link', { name: 'the top' }).click();
			expect(page.url()).toBe(address);
			await expect(page.locator('#root')).toHaveAttribute('data-state', 'app');
			await chat.getByRole('link', { name: 'the app file' }).click();
			const code = page.locator('[data-tool="file"]');
			await expect(code.locator('[data-code]')).toContainText('export const answer = 42;', {
				timeout: 30_000,
			});
			await shot(page, 'link-file');
			await page.goBack();
			await expect(page.locator('[data-screen="task"]')).toHaveAttribute('data-task', 'links');

			// The foreman's chat: the worker's escalated question, answered here for the foreman.
			await page.locator('[data-back]').click();
			await project.locator('[data-task-card="crew"]').click();
			const question = page.locator('[data-crew-question="q1"]');
			await expect(question).toHaveAttribute('data-escalated', 'true');
			await expect(question).toContainText('Which endpoint do the buttons call?');
			await expect(question).toContainText('Developer 1');
			await question.locator('label', { hasText: '/v2' }).click();
			await expect(question.getByRole('button', { name: 'Submit answer' })).toBeEnabled();
			await expect(question.getByRole('button', { name: 'Skip' })).toHaveCount(0);
			await shot(page, 'crew-question');

			// «Нова задача»: «Запустити» stays above the keyboard.
			await page.locator('[data-back]').click();
			await page.locator('[data-back]').click();
			await expect(page.locator('[data-screen="home"]')).toBeVisible();
			await page.locator('[data-screen="home"] header button[aria-label="New task"]').click();
			await expect(page.locator('[data-new-task]')).toBeVisible();
			await shrink(keyboardTop);
			await expect
				.poll(async () => {
					const start = await page.locator('[data-new-task-start]').boundingBox();
					return start ? start.y + start.height <= keyboardTop : false;
				})
				.toBe(true);
			await shot(page, 'keyboard-new-task');
			await shrink(null);
			expect(errors).toEqual([]);
		} finally {
			await device?.app.close();
			await work.close();
		}
	});

/** spec/tasks#agent-created-tasks on the phone: the agent's proposed task waits as a card, and the phone declines one and creates another. */
test('the phone answers a task the agent proposes: decline and create @area:chat', async ({}, info) => {
	test.setTimeout(240_000);
	const port = await freePorts();
	const webPort = port + 2;
	const studio = await machine('studio', true, 'Proposing task');
	const work = await launch(studio, port, {
		BRIGADIR_REMOTE_WEB_HOST: 'localhost',
		BRIGADIR_REMOTE_WEB_PORT: String(webPort),
		BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		BRIGADIR_FIXTURE_SCENARIO: 'crew',
	});
	let device: Awaited<ReturnType<typeof phoneAt>> | null = null;
	try {
		const machineWindow = await work.firstWindow();
		await machineWindow.evaluate(async () => {
			await window.brigadir.setRemoteAccess(true, 'correct horse battery');
			return window.brigadir.setRemotePhone(true);
		});
		device = await phoneAt(
			`http://localhost:${webPort}/`,
			info.outputPath('profile'),
			phones[0]!.look
		);
		const { page } = device;
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await signedIn(page, machineWindow);
		await page.locator('[data-task-card="task"]').click();
		const field = page.locator('[data-composer] textarea');
		const propose = async (title: string) => {
			await field.fill(
				`@call create_task ${JSON.stringify({ title, prompt: `${title}: add the endpoint.`, start: 'backlog' })}`
			);
			await page.locator('[data-send]').click();
			const card = page.locator('[data-task-proposal]');
			await expect(card).toContainText(title, { timeout: 30_000 });
			return card;
		};
		const first = await propose('Backend API');
		await first.locator('[data-proposal-decline]').click();
		await expect(page.locator('[data-task-proposal]')).toHaveCount(0, { timeout: 30_000 });
		const second = await propose('Loyalty screen');
		await second.locator('[data-proposal-create]').click();
		await expect(page.locator('[data-task-proposal]')).toHaveCount(0, { timeout: 30_000 });
		await expect
			.poll(async () =>
				(await machineWindow.evaluate(() => window.brigadir.readWorkspace())).tasks.map(
					(task) => task.title
				)
			)
			.toContain('Loyalty screen');
		expect(errors).toEqual([]);
	} finally {
		await device?.app.close();
		await work.close();
	}
});

/**
 * spec/remote-access-and-mobile#phone-pr-list: the project's PR list and board on the phone. A monorepo of two repos on the fixture GitHub: the project →
 * the PR segment (the default chip «Чекають тебе», «Усі», the search, the repo sheet) → a PR without a task → «Ревʼю з
 * агентом» creates the review task and opens its chat; the tasks' list ↔ board, remembered across a reload; a long press
 * moves a backlog card to «У роботі», and a refused move says why. iPhone 390 with touch (dark) and Android 360 (light);
 * every screen lands in the test's output for visual comparison.
 */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
async function boardMachine() {
	const at = await machine('studio', true, 'Phone board task');
	const repo = join(at.root, 'repo');
	async function init(path: string, files: Record<string, string>) {
		const git = (...args: string[]) =>
				promisify(execFile)('git', args, { cwd: path }).then((result) => result.stdout.trim()),
			remote = join(at.root, 'remotes', `${path.split('/').at(-1)}.git`);
		await mkdir(remote, { recursive: true });
		await promisify(execFile)('git', ['init', '--bare', '-b', 'main'], { cwd: remote });
		await mkdir(path, { recursive: true });
		await git('init', '-b', 'main');
		await git('config', 'user.name', 'Fixture');
		await git('config', 'user.email', 'fixture@example.invalid');
		for (const [file, text] of Object.entries(files)) {
			await mkdir(join(path, file, '..'), { recursive: true });
			await writeFile(join(path, file), text);
		}
		await git('add', '.');
		await git('commit', '-m', 'Baseline');
		await git('remote', 'add', 'origin', remote);
		await git('push', '-u', 'origin', 'main');
		await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
		return git;
	}
	const root = await init(repo, { '.gitignore': 'kit/\n', 'src/app.ts': 'export const a = 1;\n' });
	await init(join(repo, 'kit'), { 'src/button.css': '.button { outline: none; }\n' });
	// The PR head on the fixture origin, as GitHub keeps it: the quick review reads it from git (spec/pull-requests-and-ci#review-with-agent).
	await root('switch', '-c', 'feat/new-template');
	await writeFile(join(repo, 'src/template.ts'), 'export const template = true;\n');
	await root('add', '.');
	await root('commit', '-m', 'template');
	const headSha = await root('rev-parse', 'HEAD');
	await root('push', 'origin', 'HEAD:refs/pull/31/head');
	await root('push', 'origin', 'HEAD:refs/heads/feat/new-template');
	await root('switch', 'main');
	// A backlog task for the board's long press, a completed one for its third column.
	for (const [id, task] of Object.entries({
		later: {
			title: 'Dark mode toggle',
			status: 'backlog',
			prompt: 'Add a dark mode toggle',
			modelName: 'opus-5',
			effortName: 'high',
		},
		old: { title: 'Kit tokens audit', status: 'completed', completedAt: ago(120) },
	})) {
		const dir = join(at.data, 'projects/project/tasks', id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: { id, projectId: 'project', provider: 'claude', transport: 'gui', ...task },
			})
		);
	}
	const gh = join(at.root, 'gh.json');
	await writeFile(
		gh,
		JSON.stringify({
			repoNames: true,
			viewer: 'me',
			pullRequests: [
				{
					repo: 'repo',
					number: 31,
					title: 'New template',
					author: 'olena-p',
					requested: ['me'],
					comments: 2,
					checks: 'SUCCESS',
					head: 'feat/new-template',
					base: 'main',
					headSha,
					additions: 412,
					deletions: 38,
					updatedAt: ago(9),
					mergeState: 'BLOCKED',
					reviewDecision: 'REVIEW_REQUIRED',
					approvals: 1,
					checkRuns: [{ name: 'build' }],
				},
				{
					repo: 'repo',
					number: 29,
					title: 'Loyalty in admin',
					author: 'me',
					checks: 'FAILURE',
					reviewDecision: 'CHANGES_REQUESTED',
					head: 'feat/loyalty',
					additions: 120,
					deletions: 44,
					updatedAt: ago(120),
				},
				{
					repo: 'kit',
					number: 8,
					title: 'Kit focus ring',
					author: 'maks-d',
					checks: 'PENDING',
					head: 'feat/focus-ring',
					additions: 38,
					deletions: 12,
					updatedAt: ago(30),
				},
				{
					repo: 'repo',
					number: 22,
					title: 'Admin login redirect',
					author: 'me',
					state: 'MERGED',
					closedAt: ago(60 * 24),
					updatedAt: ago(60 * 24),
				},
			],
		})
	);
	return { at, gh };
}
const taskJson = async (data: string, id: string) =>
	JSON.parse(await readFile(join(data, 'projects/project/tasks', id, 'task.json'), 'utf8')).task;
/** A long press with a finger (CDP touch): hold still past 500 ms, travel to the target, release. */
async function longPress(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	const cdp = await page.context().newCDPSession(page);
	const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', point?: { x: number; y: number }) =>
		cdp.send('Input.dispatchTouchEvent', {
			type,
			touchPoints: point ? [{ x: point.x, y: point.y }] : [],
		});
	await touch('touchStart', from);
	await page.waitForTimeout(700);
	for (let step = 1; step <= 8; step++)
		await touch('touchMove', {
			x: from.x + ((to.x - from.x) * step) / 8,
			y: from.y + ((to.y - from.y) * step) / 8,
		});
	return { release: () => touch('touchEnd'), cdp };
}
const centre = async (page: Page, selector: string) => {
	const box = (await page.locator(selector).first().boundingBox())!;
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
for (const phone of phones)
	test(`the phone (${phone.name}) lists the project's PRs, reviews one with an agent and moves cards on the board @area:pr`, async ({}, info) => {
		test.setTimeout(300_000);
		const shot = (page: Page, name: string) =>
			page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
		const port = await freePorts();
		const webPort = port + 2;
		const { at, gh } = await boardMachine();
		const work = await launch(at, port, {
			BRIGADIR_REMOTE_WEB_HOST: 'localhost',
			BRIGADIR_REMOTE_WEB_PORT: String(webPort),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_TEST_GH: resolve('packages/forge/fixtures/gh.mjs'),
			BRIGADIR_TEST_GH_STATE: gh,
		});
		let device: Awaited<ReturnType<typeof phoneAt>> | null = null;
		try {
			const machineWindow = await work.firstWindow();
			await machineWindow.evaluate(async () => {
				await window.brigadir.setRemoteAccess(true, 'correct horse battery');
				return window.brigadir.setRemotePhone(true);
			});
			device = await phoneAt(
				`http://localhost:${webPort}/`,
				info.outputPath('profile'),
				phone.look
			);
			const { page } = device;
			const errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			await pairPhone(machineWindow, page, 'Phone Dev');
			const signIn = async (hash: string) => {
				await page.goto('about:blank');
				await page.goto(`http://localhost:${webPort}/${hash}`);
				await page.locator('[data-signin]').click();
				await expect(page.locator('#root')).toHaveAttribute('data-state', 'app');
			};
			await signIn('#/p/project');

			// The project: «Задачі N | PR N ●»; the PR segment's count and amber dot come from the list.
			const segments = page.locator('[data-screen="project"] [role="radiogroup"]').first();
			await expect(segments.getByRole('radio', { name: 'PR' })).toContainText('3');
			await expect(segments.locator('[role="img"]')).toHaveCount(1);
			await shot(page, 'PR1Tasks');
			await segments.getByRole('radio', { name: 'PR' }).click();
			await expect(page).toHaveURL(/#\/p\/project\/pr$/);
			const list = page.locator('[data-pr-list="list"]');
			// The default chip: «Чекають тебе», since a PR waits for my review.
			await expect(list.locator('[data-pr-chip="waiting"]')).toHaveAttribute(
				'aria-checked',
				'true'
			);
			await expect(list.locator('[data-pr-row]')).toHaveCount(1);
			await shot(page, 'PR1Filter');
			await list.locator('[data-pr-chip="all"]').click();
			await expect(list.locator('[data-pr-row]')).toHaveCount(4);
			const row = list.locator('[data-pr-row="31"]');
			await expect(row).toContainText('New template');
			await expect(row).toContainText('+412');
			await expect(row).toContainText('−38');
			await expect(row).toContainText('olena-p');
			await shot(page, 'PR1List');
			// The search, then the repo sheet: kit alone, its name gone from the rows.
			await list.locator('[data-pr-search]').fill('templ');
			await expect(list.locator('[data-pr-row]')).toHaveCount(1);
			await shot(page, 'PR1Search');
			await list.locator('[data-pr-search]').fill('');
			await list.locator('[data-pr-repo-picker]').click();
			const sheet = page.locator('[data-sheet]');
			await expect(sheet.locator('[data-repo-choice]')).toHaveCount(3);
			await shot(page, 'PR1Repo');
			await sheet.locator('[data-repo-choice="kit"]').click();
			await expect(sheet).toHaveCount(0);
			await expect(list.locator('[data-pr-row]')).toHaveCount(1);
			await expect(list.locator('[data-pr-repo-picker]')).toHaveAttribute('data-selected', 'true');
			await shot(page, 'PR1RepoPicked');
			await list.locator('[data-pr-repo-picker]').click();
			await sheet.locator('[data-repo-choice="all"]').click();
			await expect(list.locator('[data-pr-row]')).toHaveCount(4);

			// A PR without a task: «Ревʼю з агентом» → the sheet, «Швидко» by default → the review task's chat.
			await list.locator('[data-pr-row="31"]').click();
			const pr = page.locator('[data-screen="tool"][data-tool="pr"]');
			await expect(pr.locator('[data-pr="31"]')).toBeVisible();
			await expect(pr.locator('[data-agent-review]')).toBeVisible();
			await expect(pr.locator('[data-back]')).toHaveAttribute('aria-label', /: repo$/);
			await shot(page, 'PR1Open');
			await pr.locator('[data-agent-review]').click();
			const agent = page.locator('[data-pr-agent-sheet="review"]');
			await expect(agent.locator('[data-where="quick"]')).toHaveAttribute('aria-checked', 'true');
			await shot(page, 'PRXAgent');
			await agent.locator('[data-pr-agent-start]').click();
			await expect(page.locator('[data-screen="task"]')).toBeVisible({ timeout: 60_000 });
			await expect(page.locator('[data-screen="task"] [data-back]')).toHaveAttribute(
				'aria-label',
				/: PR #31$/
			);
			const created = await machineWindow.evaluate(async () =>
				(await window.brigadir.readWorkspace()).tasks.filter((task) => task.prReview)
			);
			expect(created).toHaveLength(1);
			expect(created[0]).toMatchObject({
				prReview: { number: 31, mode: 'review' },
				readOnlyAgent: true,
				launch: { isolation: 'in-place' },
			});
			// The phone's choice is not the machine's setting (spec/remote-access-and-mobile#phone-pr-list).
			const settings = await machineWindow.evaluate(() => window.brigadir.readSettings());
			expect(settings.settings.agents.reviewWhere ?? 'quick').toBe('quick');
			await shot(page, 'PRXAgentTask');
			// Back: the PR, now with its task's row? The review task records no PR of its own — the button stays.
			await page.locator('[data-screen="task"] [data-back]').click();
			await expect(pr.locator('[data-pr="31"]')).toBeVisible();

			// The tasks segment: list ↔ board by the header's icon, remembered across a reload.
			await signIn('#/p/project');
			await expect(page.locator('[data-screen="project"]')).toHaveAttribute('data-view', 'list');
			await page.getByRole('button', { name: /Project view: board|Вигляд проєкту: дошка/ }).click();
			await expect(page.locator('[data-board]')).toBeVisible();
			await expect(page.locator('[data-board-tab="progress"]')).toHaveAttribute(
				'aria-selected',
				'true'
			);
			await shot(page, 'KBProgress');
			await signIn('#/p/project');
			await expect(page.locator('[data-screen="project"]')).toHaveAttribute('data-view', 'board');
			await page.locator('[data-board-tab="completed"]').click();
			await expect(page.locator('[data-board-tab="completed"]')).toHaveAttribute(
				'aria-selected',
				'true'
			);
			await expect(
				page.locator('[data-board-column="completed"] [data-quiet-row="old"]')
			).toBeInViewport();
			await shot(page, 'KBDone');
			await page.locator('[data-board-tab="backlog"]').click();
			const backlogCard = '[data-board-column="backlog"] [data-board-card="later"]';
			await expect(page.locator(backlogCard)).toBeInViewport();
			await expect(page.locator(backlogCard)).toContainText('opus-5');
			await shot(page, 'KBBacklog');

			// A refused move: backlog → completed explains itself and changes nothing.
			const refused = await longPress(
				page,
				await centre(page, backlogCard),
				await centre(page, '[data-board-tab="completed"]')
			);
			await expect(page.locator('[data-board-toast]')).toHaveAttribute('data-refused', 'true');
			await expect(page.locator('[data-board-tab="completed"]')).toHaveAttribute(
				'data-refused',
				'true'
			);
			await shot(page, 'KBRefused');
			await refused.release();
			expect((await taskJson(at.data, 'later')).status).toBe('backlog');

			// An allowed one: backlog → in progress starts the task.
			const start = await longPress(
				page,
				await centre(page, backlogCard),
				await centre(page, '[data-board-tab="progress"]')
			);
			await expect(page.locator('[data-board-tab="progress"]')).toHaveAttribute(
				'data-drop',
				'true'
			);
			await expect(page.locator('[data-board-toast]')).not.toHaveAttribute('data-refused');
			await expect(page.locator('[data-board-column="progress"]')).toBeInViewport();
			await shot(page, 'KBDrag');
			await start.release();
			await expect
				.poll(async () => (await taskJson(at.data, 'later')).status, { timeout: 30_000 })
				.not.toBe('backlog');
			await expect(
				page.locator('[data-board-column="progress"] [data-board-card="later"]')
			).toHaveCount(1);
			expect(errors).toEqual([]);
		} finally {
			await device?.app.close();
			await work.close();
		}
	});

for (const phone of phones)
	test(`the phone (${phone.name}) shows the home, answers in the chat, closes sheets with back and starts a task @area:chat`, async ({}, info) => {
		test.setTimeout(240_000);
		const shot = (page: Page, name: string) =>
			page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
		const port = await freePorts();
		const webPort = port + 2;
		const studio = await machine('studio', true, 'Steering task');
		const work = await launch(studio, port, {
			BRIGADIR_REMOTE_WEB_HOST: 'localhost',
			BRIGADIR_REMOTE_WEB_PORT: String(webPort),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_FIXTURE_SCENARIO: 'steering',
			BRIGADIR_STEER_HOLD_MS: '300',
		});
		let device: Awaited<ReturnType<typeof phoneAt>> | null = null;
		try {
			const machineWindow = await work.firstWindow();
			await machineWindow.evaluate(async () => {
				await window.brigadir.setRemoteAccess(true, 'correct horse battery');
				return window.brigadir.setRemotePhone(true);
			});
			device = await phoneAt(
				`http://localhost:${webPort}/`,
				info.outputPath('profile'),
				phone.look
			);
			const { page } = device;
			const errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			await expect(state(page)).toHaveAttribute('data-state', 'signin');
			await shot(page, 'signin-first');
			await page.locator('[data-pair-open]').click();
			await expect(state(page)).toHaveAttribute('data-state', 'pair');
			await expect(page.locator('[data-pair-submit]')).toBeDisabled();
			await shot(page, 'pair-code');
			// The way in: code, name, passkey, confirmation; an iPhone in Safari then asks for the Home Screen.
			await page.goBack();
			await expect(state(page)).toHaveAttribute('data-state', 'signin');
			await pairPhone(machineWindow, page, 'Phone Dev', (name) => shot(page, name)).catch(
				async (error) => {
					await shot(page, 'pair-failed');
					throw error;
				}
			);
			expect(
				(await machineWindow.evaluate(() => window.brigadir.readRemoteAccess())).devices[0]
			).toMatchObject({
				kind: 'phone',
				name: 'Phone Dev',
			});
			await page.reload();
			await expect(page.locator('[data-signin]')).toBeEnabled();
			await expect(page.locator('#root')).toContainText('Phone Dev');
			await shot(page, 'signin');
			await page.locator('[data-signin]').click();
			await expect(state(page)).toHaveAttribute('data-state', 'app');

			// Home: the machine chip, the project frame and its card.
			await expect(page.locator('[data-machine-chip]')).toBeVisible();
			await expect(page.locator('[data-project-frame]')).toHaveText([/repo/]);
			const card = page.locator('[data-task-card="task"]');
			await expect(card).toContainText('Steering task');
			await shot(page, 'home');

			// The chat: a message starts the turn; one sent during it goes into it (spec/composer-steering-queue-and-ghost#steering).
			await card.click();
			await expect(page.locator('[data-screen="task"]')).toBeVisible();
			const field = page.locator('[data-composer] textarea');
			await field.fill('steer-wait');
			await page.locator('[data-send]').click();
			await expect(page.locator('[data-stop]')).toBeVisible({ timeout: 30_000 });
			await field.fill('make it faster');
			await expect(page.locator('[data-send]')).toBeEnabled();
			await shot(page, 'chat-steer');
			await page.locator('[data-send]').click();
			await expect(page.locator('[data-chat]')).toContainText('heard: make it faster', {
				timeout: 30_000,
			});
			await expect(page.locator('[data-stop]')).toHaveCount(0, { timeout: 30_000 });
			await expect(field).toHaveValue('');
			await shot(page, 'chat');

			// A question answered on the phone (spec/chat-turns-plans-and-questions#question-card).
			await field.fill('question');
			await page.locator('[data-send]').click();
			const question = page.locator('[data-question-id]');
			await expect(question).toBeVisible({ timeout: 30_000 });
			await question.locator('label', { hasText: 'Blue' }).click();
			await shot(page, 'question');
			await question.locator('footer button').last().click();
			await expect(question).toHaveCount(0, { timeout: 30_000 });
			await expect(page.locator('[data-chat]')).toContainText('Blue');

			// A permission answered on the phone.
			await expect(page.locator('[data-stop]')).toHaveCount(0, { timeout: 30_000 });
			await field.fill('permission');
			await page.locator('[data-send]').click();
			const permission = page.locator('[data-permission-id]');
			await expect(permission).toBeVisible({ timeout: 30_000 });
			await shot(page, 'permission');
			await permission.getByRole('button', { name: 'Allow', exact: true }).click();
			await expect(permission).toHaveCount(0, { timeout: 30_000 });

			// The task's menu is a sheet: × closes it, and so does the system «back» (spec/remote-access-and-mobile#phone).
			const menu = page.locator('[data-sheet]');
			await page.locator('[data-screen="task"] header button[aria-label]').last().click();
			await expect(menu).toBeVisible();
			await expect(menu.locator('[data-menu="changes"]')).toBeVisible();
			await shot(page, 'menu');
			await menu.getByRole('button', { name: 'Close' }).click();
			await expect(menu).toHaveCount(0);
			await page.locator('[data-screen="task"] header button[aria-label]').last().click();
			await expect(menu).toBeVisible();
			await page.goBack();
			await expect(menu).toHaveCount(0);
			await expect(page.locator('[data-screen="task"]')).toBeVisible();
			// «Changes» opens the task's change list (spec/remote-access-and-mobile#phone-task-tools); back returns to the chat.
			await page.locator('[data-screen="task"] header button[aria-label]').last().click();
			await menu.locator('[data-menu="changes"]').click();
			await expect(page.locator('[data-screen="tool"]')).toBeVisible();
			await page.goBack();
			await expect(page.locator('[data-screen="task"]')).toBeVisible();

			// Back to the home, a new task from «+».
			await page.locator('[data-back]').click();
			await expect(page.locator('[data-screen="home"]')).toBeVisible();
			await page.locator('[data-screen="home"] header button[aria-label="New task"]').click();
			const sheet = page.locator('[data-new-task]');
			await expect(sheet).toBeVisible();
			await page.locator('[data-new-task-text]').fill('Second task from the phone');
			await shot(page, 'new-task');
			await page.locator('[data-new-task-start]').click();
			await expect(page.locator('[data-screen="task"]')).toBeVisible({ timeout: 30_000 });
			await expect
				.poll(
					async () =>
						(await machineWindow.evaluate(() => window.brigadir.readWorkspace())).tasks.length
				)
				.toBe(2);
			await page.goBack();
			await expect(page.locator('[data-task-card]')).toHaveCount(2);
			await shot(page, 'home-two');
			expect(errors).toEqual([]);
			expect(phone.ios).toBeDefined();
		} finally {
			await device?.app.close();
			await work.close();
		}
	});

/**
 * spec/remote-access-and-mobile#phone-task-tools: the task's tools on the phone — Changes and a file's diff with «Наступний», the PR (a comment, an approval
 * and a squash merge on the fixture GitHub), the files (a .ts in the read-only code view, a .md in its preview), the terminal
 * of a project command with no field to type in, and a notification's key opening the task (an open app and a cold start).
 */
async function toolsMachine() {
	const at = await machine('studio', true, 'Phone tools task');
	const repo = join(at.root, 'repo'),
		git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await mkdir(join(repo, 'src'), { recursive: true });
	await writeFile(
		join(repo, 'src/app.ts'),
		"export const answer = 41;\nexport const name = 'app';\n"
	);
	await writeFile(
		join(repo, 'src/util.ts'),
		'export function add(a: number, b: number) {\n\treturn a + b;\n}\n'
	);
	await writeFile(join(repo, 'README.md'), '# Phone tools\n\nThe first line.\n');
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await git('add', '.');
	await git('commit', '-m', 'Baseline');
	// An origin as GitHub's stand-in: the forge reads the repo through it (the `gh` fixture answers for it).
	const origin = join(at.root, 'origin.git');
	await promisify(execFile)('git', ['init', '--bare', '-b', 'main', origin]);
	await git('remote', 'add', 'origin', origin);
	await git('push', '-u', 'origin', 'main');
	await git('switch', '-c', 'feat/phone');
	await git('push', '-u', 'origin', 'feat/phone');
	// Three changed files for the list, «Наступний» and the gutter; the README gets a section for the preview.
	await writeFile(
		join(repo, 'src/app.ts'),
		"export const answer = 42;\nexport const name = 'app';\n"
	);
	await writeFile(
		join(repo, 'src/util.ts'),
		'export function add(a: number, b: number) {\n\treturn a + b;\n}\nexport const zero = 0;\n'
	);
	await writeFile(
		join(repo, 'README.md'),
		'# Phone tools\n\nThe first line.\n\n## Usage\n\n- `add` sums two numbers\n'
	);
	const settings = JSON.parse(await readFile(join(at.data, 'settings.json'), 'utf8'));
	settings.settings.editor = { diffBase: 'head' };
	await writeFile(join(at.data, 'settings.json'), JSON.stringify(settings));
	const gh = join(at.root, 'gh.json');
	await writeFile(
		gh,
		JSON.stringify({
			viewer: 'me',
			pullRequests: [
				{
					number: 7,
					title: 'Phone tools',
					author: 'olena-p',
					head: 'feat/phone',
					base: 'main',
					mergeState: 'CLEAN',
					reviewDecision: 'APPROVED',
					approvals: 1,
					checkRuns: [{ name: 'build' }, { name: 'typecheck' }],
					commitList: [{ sha: 'a'.repeat(40), subject: 'answer is 42', author: 'olena-p' }],
					threads: [
						{
							path: 'src/app.ts',
							line: 1,
							hunk: '@@ -1,2 +1,2 @@\n+export const answer = 42;',
							comments: [{ author: 'olena-p', body: 'Why 42?' }],
						},
					],
				},
			],
		})
	);
	return { at, gh };
}
for (const phone of phones)
	test(`the phone (${phone.name}) reads the changes, merges the PR, opens files and the terminal, and opens a task from a notification @area:pr`, async ({}, info) => {
		test.setTimeout(300_000);
		const shot = (page: Page, name: string) =>
			page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
		const port = await freePorts();
		const webPort = port + 2;
		const { at, gh } = await toolsMachine();
		const work = await launch(at, port, {
			BRIGADIR_REMOTE_WEB_HOST: 'localhost',
			BRIGADIR_REMOTE_WEB_PORT: String(webPort),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_TEST_GH: resolve('packages/forge/fixtures/gh.mjs'),
			BRIGADIR_TEST_GH_STATE: gh,
		});
		let device: Awaited<ReturnType<typeof phoneAt>> | null = null;
		try {
			const machineWindow = await work.firstWindow();
			const key = { projectId: 'project', id: 'task' };
			await machineWindow.evaluate(async () => {
				await window.brigadir.setRemoteAccess(true, 'correct horse battery');
				return window.brigadir.setRemotePhone(true);
			});
			// The task's PR as the computer records it for the branch; a project command for the terminal.
			await machineWindow.evaluate(async (key) => {
				await window.brigadir.startSession(key);
				const scope = (await window.brigadir.readScopePanel(key.projectId, key.id)).scopes[0]!;
				await window.brigadir.sendCommand(key, {
					kind: 'recordPullRequest',
					scopeId: scope.id,
					pr: {
						number: 7,
						url: 'https://github.com/fixture/repo/pull/7',
						title: 'Phone tools',
						state: 'OPEN',
						head: 'feat/phone',
						base: 'main',
					},
				});
				// A 24-bit colour (the DOM renderer's `style=` without WebGL), then a line the machine answers after its reload.
				await window.brigadir.runProjectCommand(key, {
					line: 'printf "phone output one\\n\\033[38;2;200;80;40mphone output two\\033[0m\\n"; read answer; echo "phone after $answer"',
				});
			}, key);
			device = await phoneAt(
				`http://localhost:${webPort}/`,
				info.outputPath('profile'),
				phone.look
			);
			const { page } = device;
			const errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			// Security: the strict CSP stays (spec/remote-access-and-mobile#phone-task-tools, spec/remote-access-and-mobile#outbox). CodeMirror, the Markdown preview and
			// xterm need no `'unsafe-inline'`: the page reports no violation at all.
			const violations: string[] = [];
			page.on('console', (message) => {
				if (/violates the following Content Security Policy/.test(message.text()))
					violations.push(message.text());
			});
			await expect(state(page)).toHaveAttribute('data-state', 'signin');
			await pairPhone(machineWindow, page, 'Phone Dev');
			// A cold start at a notification's address (the app was closed): after the sign-in the task is open (spec/remote-access-and-mobile#phone-task-tools).
			await page.goto('about:blank');
			await page.goto(`http://localhost:${webPort}/#/t/project/task`);
			await page.locator('[data-signin]').click();
			await expect(state(page)).toHaveAttribute('data-state', 'app');
			await expect(page.locator('[data-screen="task"][data-task="task"]')).toBeVisible();

			// The menu counts the change set; Changes → a file's diff → the next file.
			const menu = page.locator('[data-sheet]');
			await page.locator('[data-screen="task"] header button[aria-label]').last().click();
			await expect(menu.locator('[data-menu="changes"]')).toContainText(/3 files|3 файли/);
			await shot(page, 'w2-menu');
			await menu.locator('[data-menu="changes"]').click();
			await expect(page.locator('[data-tool="changes"] [data-changed-file]')).toHaveCount(3);
			await shot(page, 'w2-changes');
			await page.locator('[data-changed-file="src/app.ts"]').click();
			const diff = page.locator('[data-tool="diff"]');
			await expect(diff).toContainText('export const answer = 42;');
			await expect(diff).toContainText('export const answer = 41;');
			// The computer's syntax tokens colour the diff (readFileSyntax after readFileDiff).
			await expect(diff.locator('.syntax-keyword').first()).toBeVisible();
			await shot(page, 'w2-diff');
			await page.locator('[data-diff-next]').click();
			await expect(diff).toContainText('export const zero = 0;');
			await expect(page.locator('[data-diff-next]')).toBeDisabled();
			// «Наступний» replaced the entry: «back» goes to the list, then to the chat.
			await page.goBack();
			await expect(page.locator('[data-tool="changes"]')).toBeVisible();
			await page.goBack();
			await expect(page.locator('[data-screen="task"]')).toBeVisible();

			// The PR: overview, a comment, an approval, a squash merge with the branch deleted.
			await page.locator('[data-screen="task"] header button[aria-label]').last().click();
			await menu.locator('[data-menu="pr"]').click();
			const pr = page.locator('[data-tool="pr"]');
			await expect(pr.locator('[data-pr="7"]')).toContainText('Phone tools');
			await expect(pr.locator('[data-merge-line="ready"]')).toBeVisible();
			await expect(pr.locator('[data-pr-thread]')).toContainText('Why 42?');
			await shot(page, 'w2-pr');
			await pr.locator('[data-comment-box] textarea').fill('Looks good from the phone.');
			await pr.locator('[data-comment-send]').click();
			await expect
				.poll(async () => JSON.parse(await readFile(gh, 'utf8')).writes ?? [])
				.toContainEqual(
					expect.objectContaining({ method: 'POST', body: { body: 'Looks good from the phone.' } })
				);
			await pr.locator('[data-pr-review]').click();
			const review = page.locator('[data-review-sheet]');
			await review.locator('[data-decision="APPROVE"]').click();
			await review.locator('[data-review-body]').fill('Approved on the phone.');
			await shot(page, 'w2-review');
			await review.locator('[data-review-send]').click();
			await expect(review).toHaveCount(0, { timeout: 30_000 });
			await expect
				.poll(async () =>
					(JSON.parse(await readFile(gh, 'utf8')).writes ?? []).find((write: { path?: string }) =>
						/pulls\/7\/reviews$/.test(write.path ?? '')
					)
				)
				.toMatchObject({ body: { event: 'APPROVE', body: 'Approved on the phone.' } });
			await pr.locator('[data-merge]').click();
			const merge = page.locator('[data-merge-sheet]');
			await expect(merge.locator('[data-method="squash"]')).toHaveAttribute('aria-checked', 'true');
			await shot(page, 'w2-merge');
			await merge.locator('[data-merge-confirm]').click();
			await expect(merge).toHaveCount(0, { timeout: 30_000 });
			const writes: { method?: string; path?: string; body?: { merge_method?: string } }[] =
				JSON.parse(await readFile(gh, 'utf8')).writes;
			expect(writes.find((write) => /pulls\/7\/merge$/.test(write.path ?? ''))).toMatchObject({
				method: 'PUT',
				body: { merge_method: 'squash' },
			});
			expect(
				writes.some(
					(write) => write.method === 'DELETE' && /heads\/feat\/phone$/.test(write.path ?? '')
				)
			).toBe(true);
			await expect(pr.locator('[data-merge-line="merged"]')).toBeVisible({ timeout: 30_000 });
			await page.goBack();

			// Files: a folder, a .ts as read-only code with the change bar, the README as its preview.
			await page.locator('[data-screen="task"] header button[aria-label]').last().click();
			await menu.locator('[data-menu="files"]').click();
			const files = page.locator('[data-tool="files"]');
			await files.locator('[data-file-entry="src"]').click();
			await expect(files.locator('[data-file-entry="app.ts"]')).toContainText('M');
			await shot(page, 'w2-files');
			await files.locator('[data-file-entry="app.ts"]').click();
			const code = page.locator('[data-tool="file"]');
			await expect(code.locator('[data-code]')).toContainText('export const answer = 42;');
			await expect(code.locator('[data-code]')).toHaveAttribute('contenteditable', 'false');
			await expect(code.locator('[data-bar]').first()).toBeVisible();
			await shot(page, 'w2-code');
			await page.goBack();
			await expect(files).toBeVisible();
			await files.locator('[data-crumbs] button').first().click();
			await files.locator('[data-file-entry="README.md"]').click();
			await expect(code.locator('[data-markdown] h2')).toHaveText('Usage');
			await shot(page, 'w2-markdown');
			await code.getByRole('radio', { name: /Code|Код/ }).click();
			await expect(code.locator('[data-code]')).toContainText('## Usage');
			await page.goBack();
			await page.goBack();

			expect(violations).toEqual([]);

			// The terminal: the command's tab and its output, nothing to type into.
			await page.locator('[data-screen="task"] header button[aria-label]').last().click();
			await menu.locator('[data-menu="terminal"]').click();
			const terminal = page.locator('[data-tool="terminal"]');
			await expect(terminal.locator('[data-terminal-tab]')).toHaveCount(1);
			await expect(terminal.locator('[data-terminal-output]')).toContainText('phone output two', {
				timeout: 30_000,
			});
			await expect(
				terminal.locator(
					'input:not([readonly]), textarea:not([readonly]), [contenteditable="true"]'
				)
			).toHaveCount(0);
			await shot(page, 'w2-terminal');
			// A `<style>` and a `style=` made by the app's scripts (xterm's DOM renderer, the scrollbar) apply through adopted
			// style sheets: no violation (spec/remote-access-and-mobile#outbox).
			expect(
				await page.evaluate(() => {
					const sheet = document.createElement('style');
					sheet.textContent = '[data-probe-style] { outline-color: rgb(1, 2, 3); }';
					document.body.append(sheet);
					const probe = document.createElement('span');
					probe.dataset.probeStyle = '';
					probe.setAttribute('style', 'color: rgb(4, 5, 6)');
					document.body.append(probe);
					const look = getComputedStyle(probe);
					const seen = [look.outlineColor, look.color];
					probe.remove();
					sheet.remove();
					return [...seen, getComputedStyle(document.body).outlineColor === seen[0]];
				})
			).toEqual(['rgb(1, 2, 3)', 'rgb(4, 5, 6)', false]);
			// The machine's window reloads: the phone's watch stays and new output still comes (spec/remote-access-and-mobile#outbox).
			await machineWindow.reload();
			await machineWindow.waitForFunction(() => Boolean(window.brigadir?.readCommandRuns));
			await machineWindow.evaluate(async (key) => {
				const [run] = await window.brigadir.readCommandRuns(key);
				await window.brigadir.terminalCommand(key, {
					kind: 'input',
					id: run!.id,
					data: 'reloaded\r',
				});
			}, key);
			await expect(terminal.locator('[data-terminal-output]')).toContainText(
				'phone after reloaded',
				{ timeout: 30_000 }
			);
			// The phone may not type into it, whatever it sends.
			const refused = await page.evaluate(
				(key) =>
					window.brigadir.terminalCommand(key, { kind: 'input', id: 'x', data: 'ls\r' }).then(
						() => 'sent',
						(error: Error) => error.message
					),
				key
			);
			expect(refused).toBe('Not available from a phone.');
			await page.goBack();

			// A notification tapped while the app is open: the service worker's message opens the task without a reload.
			await page.locator('[data-back]').click();
			await expect(page.locator('[data-screen="home"]')).toBeVisible();
			await page.evaluate(() =>
				navigator.serviceWorker.dispatchEvent(
					new MessageEvent('message', { data: { t: 'open-task', key: 'project/task' } })
				)
			);
			await expect(page.locator('[data-screen="task"][data-task="task"]')).toBeVisible();

			// The card's swipe (spec/tasks#archive-actions on the phone): left shows «Завершити» for the idle task; a tap completes it.
			await page.locator('[data-back]').click();
			const swipe = page.locator('[data-swipe="task"]');
			await expect(swipe).toBeVisible();
			const box = (await swipe.boundingBox())!;
			await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
			await page.mouse.down();
			for (let step = 1; step <= 6; step++)
				await page.mouse.move(box.x + box.width - 20 - step * 20, box.y + box.height / 2);
			await page.mouse.up();
			await expect(swipe).toHaveAttribute('data-open', 'true');
			await shot(page, 'w2-swipe');
			await swipe.locator('[data-swipe-action="complete"]').click();
			await expect
				.poll(
					async () =>
						(await machineWindow.evaluate(() => window.brigadir.readWorkspace())).tasks.find(
							(task) => task.id === 'task'
						)?.status
				)
				.toBe('completed');
			// The machine sheet names Brigadir's version on the machine (welcome.version, spec/remote-access-and-mobile#phone-task-tools).
			await page.locator('[data-machine-chip]').click();
			await expect(page.locator('[data-sheet]')).toContainText(/Brigadir \d+\.\d+/);
			await page.goBack();
			// Security: an address with a broken escape (a link from anywhere) opens the home, not a white page.
			await page.evaluate(() => {
				location.hash = '#/t/project/%E0';
			});
			await expect(page.locator('[data-screen="home"]')).toBeVisible();
			expect(errors).toEqual([]);
			expect(violations).toEqual([]);
			// The service worker keeps the app's shell only — the page, its files, icons and manifest — never the machine's
			// data, which comes over the socket (spec/remote-access-and-mobile#outbox).
			const kept = await page.evaluate(async () => {
				const names = await caches.keys();
				const urls: string[] = [];
				for (const name of names)
					for (const request of await (await caches.open(name)).keys())
						urls.push(new URL(request.url).pathname);
				return { names, urls };
			});
			// One cache, named after this build (older builds' caches go when a new worker activates).
			const built = /'(brigadir-shell-[0-9a-f]{12})'/.exec(
				await readFile(resolve('apps/desktop/out/renderer-mobile/sw.js'), 'utf8')
			)?.[1];
			expect(kept.names).toEqual([built]);
			expect(kept.urls).toContain('/');
			for (const url of kept.urls) expect(url).toMatch(/^\/$|^\/assets\/|^\/icon|^\/manifest/);
		} finally {
			await device?.app.close();
			await work.close();
		}
	});
