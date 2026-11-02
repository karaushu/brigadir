import { afterEach, expect, it } from 'vitest';
import {
	mkdtemp,
	writeFile,
	readFile,
	mkdir,
	symlink,
	rm,
	chmod,
	stat,
	readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectFile, writeProjectFile } from './files';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-file-'));
	roots.push(root);
	return root;
}
it('saves exact UTF-8 bytes, BOM/CRLF and mode while rejecting a stale version', async () => {
	const root = await setup();
	const path = join(root, 'source.ts');
	await writeFile(path, '\uFEFFone\r\n');
	await chmod(path, 0o755);
	const first = await readProjectFile(root, 'source.ts');
	expect(first.lineEnding).toBe('\r\n');
	await writeFile(path, 'external\n');
	const conflict = await writeProjectFile(root, {
		path: 'source.ts',
		expectedVersion: first.version,
		text: 'mine\n',
	});
	expect(conflict.status).toBe('conflict');
	expect(await readFile(path, 'utf8')).toBe('external\n');
	const saved = await writeProjectFile(root, {
		path: 'source.ts',
		expectedVersion: conflict.content.version,
		text: '\uFEFFmine\r\n',
	});
	expect(saved.status).toBe('saved');
	expect(await readFile(path, 'utf8')).toBe('\uFEFFmine\r\n');
	expect((await stat(path)).mode & 0o777).toBe(0o755);
	expect(await readdir(root)).toEqual(['source.ts']);
});
it('rejects traversal, Git internals, symlink escapes, binary and oversized content', async () => {
	const root = await setup();
	const outside = await setup();
	await writeFile(join(outside, 'secret'), 'secret');
	await symlink(outside, join(root, 'alias'));
	await mkdir(join(root, '.git'));
	await writeFile(join(root, '.git/config'), 'data');
	for (const path of ['../secret', 'alias/secret', '.git/config'])
		await expect(readProjectFile(root, path)).rejects.toThrow();
	await writeFile(join(root, 'binary'), Buffer.from([0, 2, 255]));
	expect((await readProjectFile(root, 'binary')).state).toBe('binary');
	await writeFile(join(root, 'large'), 'x'.repeat(9 * 1024 * 1024));
	expect((await readProjectFile(root, 'large')).state).toBe('too-large');
});
