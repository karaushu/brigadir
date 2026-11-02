import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFiles } from './agent-files';
import type { Scope } from '@brigadir/core';
it('uses the most specific scope, permits bounded reads, creates safe new files and refuses read-only, metadata, symlink and external writes', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-agent-fs-')));
	try {
		await mkdir(join(root, 'child'));
		await writeFile(join(root, 'read.txt'), 'first\nsecond\nthird\n');
		await writeFile(join(root, 'child/edit.txt'), 'before\n');
		const base: Scope = {
			id: '0000000000000000',
			path: root,
			name: '.',
			kind: 'root',
			branch: 'main',
			selected: false,
		};
		const fs = new AgentFiles(root, () => [
			base,
			{
				...base,
				id: '1111111111111111',
				path: join(root, 'child'),
				name: 'child',
				kind: 'nested',
				selected: true,
			},
		]);
		expect(await fs.read(join(root, 'read.txt'), 2, 1)).toBe('second');
		await expect(fs.write(join(root, 'read.txt'), 'changed')).rejects.toThrow('not in the task');
		await fs.write(join(root, 'child/edit.txt'), 'after\n');
		expect(await readFile(join(root, 'child/edit.txt'), 'utf8')).toBe('after\n');
		await fs.write(join(root, 'child/new/deep.txt'), 'new\n');
		expect(await readFile(join(root, 'child/new/deep.txt'), 'utf8')).toBe('new\n');
		await expect(fs.write(join(root, '../outside'), 'bad')).rejects.toThrow();
		await expect(fs.write(join(root, 'child/.git/config'), 'bad')).rejects.toThrow();
		await symlink(join(root, 'read.txt'), join(root, 'child/alias'));
		await expect(fs.write(join(root, 'child/alias'), 'bad')).rejects.toThrow();
		await expect(fs.write(join(root, 'child/binary'), 'bad\0data')).rejects.toThrow();
		await expect(fs.read(join(root, 'read.txt'), 0)).rejects.toThrow('line range');
		expect(await readFile(join(root, 'read.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('refuses every write from a checker, even into a repo in the task (spec/projects-and-board#repo-selection, point 4)', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-agent-fs-checker-')));
	try {
		await writeFile(join(root, 'edit.txt'), 'before\n');
		const scope: Scope = {
			id: '0000000000000000',
			path: root,
			name: '.',
			kind: 'root',
			branch: 'main',
			selected: true,
		};
		const checker = new AgentFiles(
			root,
			() => [scope],
			() => true
		);
		await expect(checker.write(join(root, 'edit.txt'), 'after\n')).rejects.toThrow(
			'do not write code'
		);
		expect(await readFile(join(root, 'edit.txt'), 'utf8')).toBe('before\n');
		expect(await checker.read(join(root, 'edit.txt'))).toBe('before\n');
		const developer = new AgentFiles(root, () => [scope]);
		await developer.write(join(root, 'edit.txt'), 'after\n');
		expect(await readFile(join(root, 'edit.txt'), 'utf8')).toBe('after\n');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('writes into an external repo in the task and only reads a folder without git (spec/projects-and-board#external-folders)', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-agent-fs-root-')));
	const outside = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-agent-fs-outside-')));
	try {
		await mkdir(join(outside, 'backend'));
		await writeFile(join(outside, 'backend/api.ts'), 'before\n');
		await mkdir(join(outside, 'notes'));
		await writeFile(join(outside, 'notes/brief.md'), 'context\n');
		const project: Scope = {
			id: '0000000000000000',
			path: root,
			name: '.',
			kind: 'root',
			branch: 'main',
			selected: true,
		};
		const backend: Scope = {
			id: '1111111111111111',
			path: join(outside, 'backend'),
			name: 'backend',
			kind: 'external',
			branch: 'main',
			selected: true,
		};
		const notes: Scope = {
			id: '2222222222222222',
			path: join(outside, 'notes'),
			name: 'notes',
			kind: 'folder',
			branch: null,
			selected: true,
		};
		const fs = new AgentFiles(root, () => [project, backend, notes]);
		await fs.write(join(outside, 'backend/api.ts'), 'after\n');
		expect(await readFile(join(outside, 'backend/api.ts'), 'utf8')).toBe('after\n');
		expect(await fs.read(join(outside, 'notes/brief.md'))).toBe('context\n');
		await expect(fs.write(join(outside, 'notes/brief.md'), 'changed\n')).rejects.toThrow(
			'not in the task'
		);
		expect(await readFile(join(outside, 'notes/brief.md'), 'utf8')).toBe('context\n');
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
