import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ProcessCoordinator } from './process-owner';
it('terminates a setup process group when its controlling parent dies', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-setup-lifetime-')),
		helper = resolve('apps/desktop/out/services/process-owner'),
		processes = new ProcessCoordinator(helper);
	// This parent mirrors the stdio lifetime used by ProcessCoordinator.run.
	const script = `const {spawn}=require('node:child_process');const child=spawn(process.argv[1],['run',process.argv[2],'/bin/sh','echo $$ > setup.pid; exec sleep 30'],{stdio:['pipe','ignore','ignore']});child.stdin.write('s');setInterval(()=>{},1000);`;
	const parent = spawn(process.execPath, ['-e', script, helper, root], { stdio: 'ignore' }),
		exited = new Promise<void>((resolve) => parent.once('exit', () => resolve()));
	try {
		let pid = 0;
		await expect
			.poll(async () => {
				try {
					pid = Number(await readFile(join(root, 'setup.pid'), 'utf8'));
					return pid > 0;
				} catch {
					return false;
				}
			})
			.toBe(true);
		expect(await processes.identity(pid)).not.toBeNull();
		parent.kill('SIGKILL');
		await exited;
		await expect.poll(() => processes.identity(pid), { timeout: 5000 }).toBeNull();
	} finally {
		if (parent.exitCode === null && parent.signalCode === null) {
			parent.kill('SIGKILL');
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});
