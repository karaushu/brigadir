import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './command';
/** A synthetic monorepo for git process counts: a root, two submodules, an ignored and a non-ignored nested repo,
 *  a linked worktree inside the root. Commands run only in a temporary directory. */
export async function initRepo(path: string, files = 1) {
	await mkdir(path, { recursive: true });
	await git(path, ['init', '-q', '-b', 'main']);
	await git(path, ['config', 'user.name', 'Fixture']);
	await git(path, ['config', 'user.email', 'fixture@localhost']);
	for (let i = 0; i < files; i++) {
		await mkdir(join(path, `d${i % 10}`), { recursive: true });
		await writeFile(join(path, `d${i % 10}`, `f${i}.txt`), `file ${i}\n`);
	}
	await git(path, ['add', '-A']);
	await git(path, ['commit', '-qm', 'base']);
}
export async function monorepo(dir: string, files = 300) {
	const repo = join(dir, 'mono');
	await initRepo(repo, files);
	await writeFile(join(repo, '.gitignore'), 'apps/admin/\nnode_modules/\n');
	for (const name of ['kit', 'skills']) {
		const source = join(dir, `${name}-source`);
		await initRepo(source, Math.ceil(files / 10));
		await git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, name]);
	}
	await git(repo, ['add', '-A']);
	await git(repo, ['commit', '-qm', 'submodules']);
	for (const name of ['kit', 'skills']) {
		const path = join(repo, name);
		await git(path, ['config', 'user.name', 'Fixture']);
		await git(path, ['config', 'user.email', 'fixture@localhost']);
	}
	await initRepo(join(repo, 'apps/admin'), files);
	await initRepo(join(repo, 'apps/plain'), Math.ceil(files / 10));
	await git(repo, ['worktree', 'add', '-q', join(repo, '.claude/worktrees/wt'), '-b', 'wt']);
	return {
		repo,
		kit: join(repo, 'kit'),
		skills: join(repo, 'skills'),
		admin: join(repo, 'apps/admin'),
		plain: join(repo, 'apps/plain'),
		wt: join(repo, '.claude/worktrees/wt'),
	};
}
