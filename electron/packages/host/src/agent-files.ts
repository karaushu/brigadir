import { open, mkdir, link, unlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { editorByteLimit, isRecord, writableByAgent, type Scope } from '@brigadir/core';
import { projectFile, readProjectFile, writeProjectFile } from '@brigadir/persistence';
/** ACP filesystem calls share the task root and choose the most specific repository. */
export class AgentFiles {
	constructor(
		private root: string,
		private scopes: () => readonly Scope[],
		private readOnlyAgent: () => boolean = () => false
	) {}
	/** The root a file is resolved from: the project, or for an external repo or folder (spec/projects-and-board#external-folders) — itself.
	 *  Otherwise a path outside the project root would fail `projectFile`, and nothing could be written to an external repo. */
	private async base(path: string) {
		const root = await realpath(this.root);
		if (path === root || path.startsWith(`${root}/`)) return root;
		const outside = this.scopes()
			.filter(
				(scope) =>
					(scope.kind === 'external' || scope.kind === 'folder') &&
					(path === scope.path || path.startsWith(`${scope.path}/`))
			)
			.sort((a, b) => b.path.length - a.path.length)[0];
		return outside ? realpath(outside.path) : root;
	}
	private async path(path: string) {
		if (!isAbsolute(path) || path.includes('\0'))
			throw new Error('Expected an absolute workspace file path');
		const root = await this.base(path),
			local = relative(root, path);
		return { root, local, file: await projectFile(root, local) };
	}
	async read(path: string, line?: number | null, limit?: number | null) {
		if (
			(line != null && (!Number.isSafeInteger(line) || line < 1)) ||
			(limit != null && (!Number.isSafeInteger(limit) || limit < 0))
		)
			throw new Error('Invalid line range');
		const { root, local } = await this.path(path),
			file = await readProjectFile(root, local);
		if (file.state !== 'text') throw new Error('The file is not supported as text');
		return line != null || limit != null
			? file.text
					.split('\n')
					.slice((line ?? 1) - 1, limit == null ? undefined : (line ?? 1) - 1 + limit)
					.join('\n')
			: file.text;
	}
	async write(path: string, text: string) {
		if (Buffer.byteLength(text) > editorByteLimit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
			throw new Error('The file content is not supported');
		const { root, local, file } = await this.path(path),
			scopes = this.scopes(),
			scope = scopes
				.filter((scope) => file === scope.path || file.startsWith(`${scope.path}/`))
				.sort((a, b) => b.path.length - a.path.length)[0];
		// spec/projects-and-board#repo-selection: a reviewer writes no code — the right lives on the agent, not on the repo set.
		if (this.readOnlyAgent())
			throw new Error('You check the work and do not write code. Do not edit files.');
		if (scopes.length && (!scope || !writableByAgent(scope)))
			throw new Error('This repository is not in the task. Do not edit it through other tools.');
		try {
			const current = await readProjectFile(root, local);
			if (current.state !== 'text') throw new Error('The file is not supported as text');
			const result = await writeProjectFile(root, {
				path: local,
				expectedVersion: current.version,
				text,
			});
			if (result.status !== 'saved') throw new Error('The file changed during the write');
			return;
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') throw error;
		}
		await mkdir(dirname(file), { recursive: true });
		await this.path(path);
		const temp = join(dirname(file), `.${basename(file)}.brigadir-${randomUUID()}.tmp`),
			handle = await open(temp, 'wx', 0o644);
		try {
			try {
				await handle.writeFile(text);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.path(path);
			await link(temp, file);
			const parent = await open(dirname(file), 'r');
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		} finally {
			await unlink(temp).catch(() => {});
		}
	}
}
