import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { editorText } from './editor-text';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const run = promisify(execFile);
/** Live `host.cjs` processes whose config lives under `data`. */
const hosts = async (data: string) =>
	(await run('ps', ['-Ao', 'pid=,command='])).stdout
		.split('\n')
		.filter((line) => line.includes('host.cjs') && line.includes(data))
		.map((line) => Number(line.trim().split(/\s+/)[0]));
const running = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
/** A project «repository» with finished tasks `{ id: title }`; the first one is `dir`. */
async function fixture(prefix: string, tasks: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), `brigadir-${prefix}-`)),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks', Object.keys(tasks)[0]!);
	await mkdir(repo);
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	for (const [id, title] of Object.entries(tasks)) {
		await mkdir(join(data, 'projects/project/tasks', id), { recursive: true });
		await writeFile(
			join(data, 'projects/project/tasks', id, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: { id, projectId: 'project', title, status: 'done', provider: 'claude' },
			})
		);
	}
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	return { root, repo, data, dir, agentLog: join(root, 'agent.jsonl') };
}
const launch = (root: string, data: string, agentLog: string, extra: Record<string, string> = {}) =>
	electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_FIXTURE_LOG: agentLog,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			...extra,
		},
	});
// spec/architecture-and-platform#host-lifecycle: the host outlives the app (spec/tasks#task-states) and exits once its data dir is deleted, so a test run leaves no hosts behind.
test('a task host survives app.close and exits when its data dir is deleted @area:tasks', async () => {
	test.setTimeout(60000);
	const { root, data, dir, agentLog } = await fixture('host-orphan', { task: 'Orphan fixture' });
	const app = await launch(root, data, agentLog);
	let pid = 0;
	try {
		const page = await app.firstWindow();
		await page.getByRole('button', { name: /Orphan fixture/ }).click();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute(
			'aria-busy',
			'false'
		);
		pid = (JSON.parse(await readFile(join(dir, 'host.json'), 'utf8')) as { pid: number }).pid;
		expect(await hosts(data)).toEqual([pid]);
		await app.close();
		// spec/tasks#task-states: quitting the app never takes the task (the idle stop is 15 min away).
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(running(pid)).toBe(true);
	} finally {
		await app.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
	await expect.poll(() => hosts(data), { timeout: 20000 }).toEqual([]);
	expect(running(pid)).toBe(false);
});
// spec/architecture-and-platform#host-lifecycle (BG-09): a host stopped for idleness leaves no banner; the next message starts it, resumes the session and is delivered once.
test('an idle host stops unnoticed and the next message resumes the same session with its attachment @area:tasks', async () => {
	test.setTimeout(120000);
	const { root, repo, data, dir, agentLog } = await fixture('idle-host', {
		task: 'Idle fixture',
		other: 'Other task',
	});
	await writeFile(join(repo, 'notes.txt'), 'remember this\n');
	const app = await launch(root, data, agentLog, { BRIGADIR_TEST_IDLE_MS: '1500' });
	const key = { projectId: 'project', id: 'task' };
	const journal = () =>
		readFile(join(dir, 'events.jsonl'), 'utf8').then((text) =>
			text
				.trim()
				.split('\n')
				.map(
					(line) =>
						JSON.parse(line) as {
							seq: number;
							event: {
								kind: string;
								reason?: string;
								sessionId?: string;
								text?: string;
								attachments?: unknown[];
							};
						}
				)
		);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Idle fixture/ }).click();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await message.fill('hello');
		await message.press('Enter');
		await expect(page.getByRole('log')).toContainText('world');
		// The selected task never stops; another task selected, it stops after the (shortened) idle time like Stop, status kept.
		await page.waitForTimeout(3000);
		expect((await journal()).at(-1)!.event.kind).not.toBe('host.stopped');
		await page.getByRole('button', { name: /Other task/ }).click();
		await expect(page.getByRole('button', { name: /Other task/ })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect
			.poll(async () => (await journal()).at(-1)!.event, { timeout: 20000 })
			.toEqual({ kind: 'host.stopped', reason: 'idle' });
		await expect
			.poll(async () =>
				access(join(dir, 'host.lock')).then(
					() => true,
					() => false
				)
			)
			.toBe(false);
		await expect(page.getByRole('button', { name: /Idle fixture/ })).toHaveAttribute(
			'data-status',
			'done'
		);
		// Opening the task starts nothing and shows no recovery banner; the composer stays usable.
		await page.getByRole('button', { name: /Idle fixture/ }).click();
		await expect(message).toBeEnabled();
		await expect(page.getByRole('log')).toContainText('world');
		await page.waitForTimeout(1000);
		await expect(page.getByText('Agent is not running.')).toHaveCount(0);
		await expect(page.getByText('The host is disconnected.')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
		expect(
			await page.evaluate(
				(key) => window.brigadir.readSession(key).then((value) => value.connected),
				key
			)
		).toBe(false);
		expect((await journal()).at(-1)!.event.reason).toBe('idle');
		await app.evaluate(
			({ dialog }, path) => {
				dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
			},
			join(repo, 'notes.txt')
		);
		// spec/composer#mentions: the attachment stands in the text as a pill, after what is typed.
		await message.fill('again');
		await page.getByRole('button', { name: 'Attach files', exact: true }).click();
		await expect(message.locator('[data-mention-pill]', { hasText: 'notes.txt' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
		await message.press('Enter');
		await expect
			.poll(
				async () =>
					(await journal()).filter((record) => record.event.kind === 'turn.completed').length,
				{ timeout: 30000 }
			)
			.toBe(2);
		await expect.poll(() => editorText(message)).toBe('');
		await expect(message.locator('[data-mention-pill]')).toHaveCount(0);
		const records = await journal(),
			turns = records.filter((record) => record.event.kind === 'turn.started'),
			starts = records.filter((record) => record.event.kind === 'session.started');
		expect(turns[0]!.event.text).toBe('hello');
		expect(turns[1]!.event.text).toMatch(/^again @\[att:[0-9a-f-]{36}\] $/);
		expect(turns[1]!.event.attachments).toHaveLength(1);
		expect(starts.map((record) => record.event.sessionId)).toEqual([
			'fixture-session',
			'fixture-session',
		]);
		const agent = (await readFile(agentLog, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { event: string; params: unknown });
		expect(
			agent
				.filter((entry) => entry.event === 'new' || entry.event === 'load')
				.map((entry) => entry.event)
		).toEqual(['new', 'load']);
		const prompts = agent
			.filter((entry) => entry.event === 'prompt')
			.map((entry) => String(entry.params));
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain('again');
		expect(
			JSON.stringify(agent.filter((entry) => entry.event === 'prompt-blocks').at(-1)!.params)
		).toContain('attached_context name=\\"notes.txt\\"');
		await expect(page.getByText('Agent is not running.')).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
