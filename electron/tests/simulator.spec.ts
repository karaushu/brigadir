import { _electron as electron, expect, test } from '@playwright/test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
// The sim-helper framing (spec/browser-and-simulator#simulator) from a stand-in: ready, a config, key frames on request, replies; stdin logged.
// `SIM_FIXTURE_H264` may name a recorded {config, frame} pair from the real helper, so the canvas shows a real screen.
const helperSource = `#!/usr/bin/env node
const fs=require('node:fs');const out=(type,payload)=>{const body=Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));const head=Buffer.alloc(5);head[0]=type;head.writeUInt32BE(body.length,1);process.stdout.write(Buffer.concat([head,body]));};
const log={write:line=>fs.appendFileSync(process.env.HELPER_LOG,line)};log.write(JSON.stringify({argv:process.argv.slice(2)})+'\\n');
const recorded=process.env.SIM_FIXTURE_H264&&fs.existsSync(process.env.SIM_FIXTURE_H264)?JSON.parse(fs.readFileSync(process.env.SIM_FIXTURE_H264,'utf8')):null;
const config=recorded?.config??{codec:'avc1.640028',width:1206,height:2622,description:'AQID'};
const frame=recorded?Buffer.from(recorded.frame,'base64'):Buffer.concat([Buffer.from([1,0,0,0,0,0,0,3,232]),Buffer.from([0,0,0,1,9])]);
out(1,{event:'ready',width:config.width,height:config.height,pointWidth:402,pointHeight:874});out(2,config);out(3,frame);
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);log.write(line+'\\n');const message=JSON.parse(line);if(message.cmd==='keyframe')out(3,frame);if(typeof message.id==='number')out(1,{event:'reply',id:message.id,result:null});}});
process.stdin.on('end',()=>process.exit(0));
`;
test('the simulator column starts a device, shows its screen and sends touches (spec/browser-and-simulator#simulator) @area:browser', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-simulator-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		helper = join(root, 'sim-helper'),
		log = join(root, 'helper.log');
	await mkdir(repo);
	const taskDir = join(data, 'projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Simulator fixture',
				status: 'done',
				provider: 'claude',
				transport: 'gui',
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
				modules: { browser: true, simulator: true },
			},
		})
	);
	await writeFile(helper, helperSource);
	await chmod(helper, 0o755);
	await writeFile(
		join(root, 'fixture.json'),
		JSON.stringify({
			xcodebuild: 'Xcode 27.0\n',
			helper,
			simctl: {
				devices: {
					'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
						{
							udid: '4900CF11-BDEA-4EC2-BE33-11CE51B20141',
							name: 'iPhone 17 Pro',
							state: 'Shutdown',
						},
						{ udid: '13E89BD9-E5BA-44DB-ACF3-C80F1A7DA1FF', name: 'iPhone Air', state: 'Shutdown' },
					],
				},
			},
		})
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_SIMULATOR: join(root, 'fixture.json'),
			HELPER_LOG: log,
			SIM_FIXTURE_H264: resolve('tests/fixtures/sim-frame.json'),
		},
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
		await page.getByRole('button', { name: /Simulator fixture/ }).click();
		const toolbar = page.locator('header[aria-label="View"]');
		// spec/task-window-workspace#work-area: ⇧⌘M opens the simulator tab in the work area.
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Simulator')!
				.click()
		);
		const panel = page.getByRole('region', { name: 'Simulator', exact: true });
		await expect(panel).toBeVisible();
		await expect(panel.getByText('iPhone 17 Pro is off')).toBeVisible();
		await page.screenshot({ animations: 'disabled', path: info.outputPath('simulator-off.png') });
		// spec/task-window-workspace#tool-tab-look: the device picker is a ghost trigger in the strip; its list marks the chosen device with ✓.
		const picker = panel.getByRole('button', { name: 'Simulator', exact: true });
		expect(await picker.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
			'rgba(0, 0, 0, 0)'
		);
		await picker.click();
		const chosen = page.getByRole('option', { name: /iPhone 17 Pro/, selected: true });
		await expect(chosen.locator('svg').first()).toBeVisible();
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('simulator-picker.png'),
		});
		await page.keyboard.press('Escape');
		// spec/task-window-workspace#work-area: a tab of the work area, under the toolbar; its tab names it.
		const [tab, bar] = await Promise.all([panel.boundingBox(), toolbar.boundingBox()]);
		expect(tab!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
		await expect(page.locator('[data-tool=simulator]')).toHaveCount(1);
		await panel.getByRole('button', { name: 'Start', exact: true }).click();
		const screen = panel
			.getByRole('img', { name: 'Simulator screen' })
			.or(panel.locator('canvas[aria-label="Simulator screen"]'));
		await expect(screen).toBeVisible();
		await page.screenshot({ animations: 'disabled', path: info.outputPath('simulator-on.png') });
		const box = (await screen.boundingBox())!;
		expect(box.height / box.width).toBeCloseTo(874 / 402, 1);
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 4);
		await expect
			.poll(async () =>
				(await readFile(log, 'utf8'))
					.split('\n')
					.filter(Boolean)
					.map((line) => JSON.parse(line))
					.filter((entry) => entry.cmd === 'touch')
					.map((entry) => entry.phase)
			)
			.toEqual(['down', 'up']);
		const touch = (await readFile(log, 'utf8'))
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.find((entry) => entry.cmd === 'touch')!;
		expect(touch.x).toBeCloseTo(0.5, 1);
		expect(touch.y).toBeCloseTo(0.25, 1);
		await screen.focus();
		await page.keyboard.press('KeyA');
		await expect
			.poll(async () => (await readFile(log, 'utf8')).includes('"cmd":"key","usage":4,"down":true'))
			.toBe(true);
		await panel.getByRole('button', { name: 'Home', exact: true }).click();
		await expect
			.poll(async () => (await readFile(log, 'utf8')).includes('"cmd":"button","name":"home"'))
			.toBe(true);
		// Rotate: the frame keeps the device's portrait pixels and turns; a touch goes back to the device frame.
		await panel.getByRole('button', { name: 'Rotate', exact: true }).click();
		await expect(screen).toHaveAttribute('data-orientation', 'landscapeLeft');
		await expect
			.poll(async () => {
				const box = (await screen.boundingBox())!;
				return Math.round((box.width / box.height) * 100) / 100;
			})
			.toBeCloseTo(874 / 402, 1);
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('simulator-landscape.png'),
		});
		const turned = (await screen.boundingBox())!;
		await page.mouse.click(
			turned.x + (turned.width * 150) / 874,
			turned.y + (turned.height * 32) / 402
		);
		await expect
			.poll(
				async () =>
					(await readFile(log, 'utf8'))
						.split('\n')
						.filter(Boolean)
						.map((line) => JSON.parse(line))
						.filter((entry) => entry.cmd === 'touch').length
			)
			.toBe(4);
		const down = (await readFile(log, 'utf8'))
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.cmd === 'touch')
			.at(-2)!;
		expect(down.x).toBeCloseTo(1 - 32 / 402, 1);
		expect(down.y).toBeCloseTo(150 / 874, 1);
		expect(
			await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((item) => item.label))
		).toContain('Simulator');
		// spec/task-window-workspace#tool-tab-look.1: a running device has a green dot and its own shut-down button in place of
		// «Booted»; no «Shut down …» row. → reaches the button, Enter shuts that device down without choosing a row.
		await picker.click();
		const running = page.getByRole('option', { name: /iPhone 17 Pro/ });
		const off = running.getByRole('button', { name: 'Shut down iPhone 17 Pro', exact: true });
		await expect(off).toBeVisible();
		expect(await off.evaluate((node) => node.getBoundingClientRect().height)).toBe(24);
		await expect(running.locator('i')).toHaveCount(1);
		await expect(page.getByRole('option', { name: /iPhone Air/ }).getByRole('button')).toHaveCount(
			0
		);
		await expect(page.getByRole('option', { name: /^Shut down/ })).toHaveCount(0);
		await expect(running).not.toContainText('Booted');
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('simulator-picker-running.png'),
		});
		await page.keyboard.press('ArrowRight');
		await expect(off).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(panel.getByText('iPhone 17 Pro is off')).toBeVisible();
		await expect(off).toHaveCount(0);
		await expect(page.getByRole('option', { name: /iPhone 17 Pro/, selected: true })).toBeVisible();
		await page.keyboard.press('Escape');
		for (const theme of ['dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await page.waitForTimeout(300);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`simulator-${theme}.png`),
			});
		}
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// No device on this machine: the column says so and offers Check, instead of « is off» without a name.
test('the simulator column without devices says there are none and checks again @area:browser', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-simulator-none-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		taskDir = join(data, 'projects/project/tasks/task');
	await mkdir(repo);
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'No devices',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: { appearance: 'light', language: 'en', modules: { simulator: true } },
		})
	);
	await writeFile(
		join(root, 'fixture.json'),
		JSON.stringify({ xcodebuild: 'Xcode 27.0\n', helper: '/nonexistent', simctl: { devices: {} } })
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data, BRIGADIR_TEST_SIMULATOR: join(root, 'fixture.json') },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /No devices/ }).click();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Simulator')!
				.click()
		);
		const panel = page.getByRole('region', { name: 'Simulator', exact: true }),
			hint = panel.getByText('Create a simulator in Xcode, then check again.');
		await expect(hint).toBeVisible();
		await expect(panel.getByText(/ is off$/)).toHaveCount(0);
		await expect(panel.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
		await panel.getByRole('button', { name: 'Check', exact: true }).click();
		await expect(hint).toBeVisible();
		await page.screenshot({ animations: 'disabled', path: info.outputPath('simulator-none.png') });
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
