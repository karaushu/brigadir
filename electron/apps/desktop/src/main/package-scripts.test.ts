import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageManagerAt, readProjectScripts } from './package-scripts';

const roots: string[] = [];
async function project() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-scripts-'));
	roots.push(root);
	return root;
}
const write = async (root: string, path: string, value: unknown) => {
	await mkdir(join(root, path, '..'), { recursive: true });
	await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' });
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('package.json scripts of a project (spec/search-menus-and-commands#package-scripts)', () => {
	it('lists the package.json files Git sees, not node_modules nor ignored ones, with their manager', async () => {
		const root = await project();
		git(root, 'init', '-q');
		await write(root, 'package.json', { scripts: { dev: 'vite' } });
		await write(root, 'pnpm-lock.yaml', '');
		await write(root, 'apps/admin/package.json', { scripts: { start: 'next' } });
		await write(root, 'apps/site/package.json', {
			packageManager: 'yarn@4.1.0',
			scripts: { build: 'astro build' },
		});
		await write(root, 'apps/empty/package.json', { name: 'x' });
		await write(root, 'node_modules/lib/package.json', { scripts: { postinstall: 'x' } });
		await write(root, '.gitignore', 'node_modules\nbuild/\n');
		await write(root, 'build/package.json', { scripts: { gone: 'x' } });
		const { repos, packages } = await readProjectScripts(root);
		expect(repos).toEqual(['']);
		expect(packages.map((item) => [item.directory, item.manager, item.scripts])).toEqual([
			['', 'pnpm', [{ name: 'dev', body: 'vite' }]],
			['apps/admin', 'pnpm', [{ name: 'start', body: 'next' }]],
			['apps/site', 'yarn', [{ name: 'build', body: 'astro build' }]],
		]);
	});
	it('reads a nested repo as its own repo and a folder without Git by its root only', async () => {
		const root = await project();
		await write(root, 'package.json', { scripts: { lint: 'eslint' } });
		await write(root, 'tools/package.json', { scripts: { hidden: 'x' } });
		const inner = join(root, 'web');
		await mkdir(inner);
		git(inner, 'init', '-q');
		await write(root, 'web/package.json', { scripts: { web: 'expo start --web' } });
		await write(root, 'web/yarn.lock', '');
		const { repos, packages } = await readProjectScripts(root);
		expect(repos).toEqual(['', 'web']);
		expect(packages.map((item) => [item.repo, item.directory, item.manager])).toEqual([
			['', '', 'npm'],
			['web', '', 'yarn'],
		]);
	});
	it('walks up to the repo root for a lock file and falls back to npm', async () => {
		const root = await project();
		await write(root, 'bun.lockb', '');
		expect(await packageManagerAt(root, 'a/b', {})).toBe('bun');
		expect(await packageManagerAt(root, 'a/b', { packageManager: 'pnpm@9' })).toBe('pnpm');
		const bare = await project();
		expect(await packageManagerAt(bare, '', {})).toBe('npm');
	});
});
