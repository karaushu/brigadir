import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const run = promisify(execFile);
const packaged = process.env.BRIGADIR_PACKAGED_APP;
const processes = async () => (await run('ps', ['-Ao', 'pid=,command='])).stdout.split('\n');
// spec/architecture-and-platform#macos-package: a release bundle (`pnpm dist:mac`, then BRIGADIR_PACKAGED_APP=electron/dist/mac-arm64/Brigadir.app) runs main
// from app.asar and the host, the agent and the helpers from Contents/Resources/services, with the login shell's PATH.
test('the packaged app starts its host and helpers from Contents/Resources/services @area:shell', async () => {
	test.skip(!packaged, 'set BRIGADIR_PACKAGED_APP to a Brigadir.app built by pnpm dist:mac');
	test.setTimeout(90000);
	const app = packaged!,
		resources = join(app, 'Contents/Resources'),
		services = join(resources, 'services');
	// A bundle without this Mac's architecture (x64 on Apple Silicon) would run under Rosetta, and macOS 27 answers
	// every translated launch with a «will not open in macOS 28» banner. x64 is checked statically by check-dist.
	const archs = (
		await run('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS/Brigadir')])
	).stdout
		.trim()
		.split(/\s+/);
	test.skip(
		!archs.includes(process.arch === 'x64' ? 'x86_64' : 'arm64'),
		`the bundle is ${archs.join(' ')}; this Mac runs ${process.arch}, so only check-dist covers it`
	);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-packaged-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Packaged fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	// Finder hands an app this PATH; spec/architecture-and-platform#packaging widens it from the login shell.
	const electronApp = await electron.launch({
		executablePath: join(app, 'Contents/MacOS/Brigadir'),
		args: [`--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	let pid = 0;
	try {
		const page = await electronApp.firstWindow();
		const main = await electronApp.evaluate(({ app }) => ({
			packaged: app.isPackaged,
			resources: process.resourcesPath,
			name: app.getName(),
			version: app.getVersion(),
		}));
		expect(main).toEqual({
			packaged: true,
			resources,
			name: 'Brigadir',
			version: expect.stringMatching(/^\d+\.\d+\.\d+/),
		});
		await expect
			.poll(() => electronApp.evaluate(() => process.env.PATH ?? ''), { timeout: 15000 })
			.toContain('/opt/homebrew/bin');
		// The font catalog helper (spec/appearance#interface-font) runs from the bundle, not from an asar path.
		await expect
			.poll(
				async () => (await processes()).some((line) => line.includes(join(services, 'fonts'))),
				{ timeout: 15000 }
			)
			.toBe(true);
		await page.getByRole('button', { name: /Packaged fixture/ }).click();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0, {
			timeout: 30000,
		});
		await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute(
			'aria-busy',
			'false',
			{ timeout: 30000 }
		);
		pid = (JSON.parse(await readFile(join(dir, 'host.json'), 'utf8')) as { pid: number }).pid;
		const host =
			(await processes()).find((line) => Number(line.trim().split(/\s+/)[0]) === pid) ?? '';
		expect(host).toContain(join(app, 'Contents/MacOS/Brigadir'));
		expect(host).toContain(join(services, 'host.cjs'));
	} finally {
		await electronApp.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
	// spec/architecture-and-platform#host-lifecycle: the host leaves once its data dir is gone.
	if (pid)
		await expect
			.poll(
				() => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				},
				{ timeout: 20000 }
			)
			.toBe(false);
});
