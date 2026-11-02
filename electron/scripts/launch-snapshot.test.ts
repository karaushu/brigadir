import { expect, test } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchSnapshot } from './launch-snapshot.mjs';
// spec/architecture-and-platform#crash-recovery: the running app reads a copy of out/ that a rebuild does not touch.
test('a launch reuses the copy of the same build and keeps copies that live processes use', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-launch-'));
	try {
		const out = join(root, 'out'),
			launch = join(root, '.launch');
		await mkdir(join(out, 'main'), { recursive: true });
		await mkdir(join(out, 'renderer/assets'), { recursive: true });
		await writeFile(join(out, 'main/index.js'), 'one');
		await writeFile(join(out, 'renderer/assets/TerminalPanel-a.js'), 'chunk a');
		const first = await launchSnapshot(out, launch, async () => []);
		expect(await readFile(join(first.path, 'renderer/assets/TerminalPanel-a.js'), 'utf8')).toBe(
			'chunk a'
		);
		expect((await launchSnapshot(out, launch, async () => [])).path).toBe(first.path);
		// A rebuild replaces the chunk in out/; the first launch still finds its own.
		await rm(join(out, 'renderer/assets/TerminalPanel-a.js'));
		await writeFile(join(out, 'renderer/assets/TerminalPanel-b.js'), 'chunk b');
		const second = await launchSnapshot(out, launch, async () => [
			`/Applications/Brigadir ${first.path}/services/host.cjs config.json`,
		]);
		expect(second.id).not.toBe(first.id);
		expect(await readFile(join(first.path, 'renderer/assets/TerminalPanel-a.js'), 'utf8')).toBe(
			'chunk a'
		);
		// Nobody runs the first build any more: the next launch removes it.
		await launchSnapshot(out, launch, async () => []);
		expect(await readdir(launch)).toEqual([second.id]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
