import { constants } from 'node:fs';
import { cp, readdir, readFile, rename, rm, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
/** Content hash of a build tree: relative paths and bytes, in a stable order. */
export async function buildDigest(directory) {
	const hash = createHash('sha256');
	async function visit(relative = '') {
		for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort(
			(a, b) => a.name.localeCompare(b.name)
		)) {
			const path = join(relative, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) {
				hash.update(path);
				hash.update('\0');
				hash.update(await readFile(join(directory, path)));
				hash.update('\0');
			}
		}
	}
	await visit();
	return hash.digest('hex').slice(0, 16);
}
/** Command lines of every live process: a snapshot is in use while any of them names its path. */
export async function liveCommandLines() {
	const { stdout } = await run('/bin/ps', ['-axww', '-o', 'command='], {
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.split('\n');
}
/**
 * spec/architecture-and-platform#crash-recovery: the app runs from a copy of `out/` that no rebuild touches. Main resolves services, preload and the
 * renderer next to itself, so one launch and the hosts it starts read one build. The same content reuses its copy;
 * a copy no live process names is removed. APFS clones the files, so a copy costs no disk space.
 */
export async function launchSnapshot(out, root, running = liveCommandLines) {
	const id = await buildDigest(out),
		target = join(root, id);
	try {
		await stat(join(target, 'main/index.js'));
	} catch {
		await mkdir(root, { recursive: true });
		const staging = join(root, `.${id}-${process.pid}`);
		await rm(staging, { recursive: true, force: true });
		await cp(out, staging, { recursive: true, mode: constants.COPYFILE_FICLONE });
		try {
			await rename(staging, target);
		} catch (error) {
			await rm(staging, { recursive: true, force: true });
			try {
				await stat(join(target, 'main/index.js'));
			} catch {
				throw error;
			}
		}
	}
	const lines = await running();
	for (const entry of await readdir(root)) {
		if (entry === id || entry.startsWith('.')) continue;
		const path = join(root, entry);
		if (!lines.some((line) => line.includes(`${path}/`)))
			await rm(path, { recursive: true, force: true });
	}
	return { id, path: target };
}
