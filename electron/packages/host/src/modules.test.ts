import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleSettings } from './modules';
it('reads the modules from settings.json and follows an atomic write (spec/settings-modules-and-onboarding#modules)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-modules-'));
	const settings = new ModuleSettings(root);
	try {
		await settings.load();
		expect(settings.current()).toEqual({
			browser: true,
			simulator: false,
			pullRequests: true,
			commands: true,
			remoteAccess: true,
			notes: true,
			schedules: true,
			slack: false,
		});
		const write = async (modules: unknown) => {
			await writeFile(
				join(root, 'settings.tmp'),
				JSON.stringify({ schemaVersion: 1, settings: { modules } })
			);
			await rename(join(root, 'settings.tmp'), join(root, 'settings.json'));
		};
		await write({ browser: false, simulator: true });
		await settings.load();
		expect(settings.current()).toEqual({
			browser: false,
			simulator: true,
			pullRequests: true,
			commands: true,
			remoteAccess: true,
			notes: true,
			schedules: true,
			slack: false,
		});
		settings.start();
		const changed = new Promise((resolve) => settings.subscribe(resolve));
		await write({ browser: true, simulator: true, pullRequests: false, commands: true });
		expect(await changed).toEqual({
			browser: true,
			simulator: true,
			pullRequests: false,
			commands: true,
			remoteAccess: true,
			notes: true,
			schedules: true,
			slack: false,
		});
		await write({ browser: 'yes' });
		await settings.load();
		expect(settings.current()).toEqual({
			browser: true,
			simulator: false,
			pullRequests: true,
			commands: true,
			remoteAccess: true,
			notes: true,
			schedules: true,
			slack: false,
		});
	} finally {
		settings.close();
		await rm(root, { recursive: true, force: true });
	}
});
