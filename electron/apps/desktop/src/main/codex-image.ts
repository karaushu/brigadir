import { spawn } from 'node:child_process';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { projectImageLimit } from '@brigadir/core';

export type CodexCommand = { command: string; args: string[]; env: NodeJS.ProcessEnv };
/** A thread id of Codex (a UUID): the only name the image folder may have before it is read and removed. */
const threadId = (value: unknown): value is string =>
	typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
/**
 * spec/projects-and-board#project-icon: one image from `codex exec` with its own image generation tool. The prompt goes on stdin; the JSON events
 * name the thread, and Codex saves what it drew under `$CODEX_HOME/generated_images/<thread>/`. The newest PNG there is the
 * answer; the thread's folder is removed after it is read (ours: `--ephemeral` leaves no session either).
 */
export async function generateCodexImage(input: {
	cli: CodexCommand;
	cwd: string;
	prompt: string;
	codexHome: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<Buffer> {
	const child = spawn(
		input.cli.command,
		[
			...input.cli.args,
			'exec',
			'--json',
			'--ephemeral',
			'--skip-git-repo-check',
			'--sandbox',
			'read-only',
			'--enable',
			'image_generation',
			'-',
		],
		{
			cwd: input.cwd,
			env: { ...input.cli.env, CODEX_HOME: input.codexHome },
			stdio: ['pipe', 'pipe', 'ignore'],
		}
	);
	let thread: string | null = null,
		completed = false,
		failure: string | null = null,
		buffer = '';
	const stop = () => child.kill('SIGTERM');
	const timer = setTimeout(() => {
		failure ??= 'Image generation timed out';
		stop();
	}, input.timeoutMs ?? 180_000);
	const abort = () => {
		failure ??= 'Image generation was cancelled';
		stop();
	};
	input.signal?.addEventListener('abort', abort, { once: true });
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		buffer += chunk;
		let end: number;
		while ((end = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, end).trim();
			buffer = buffer.slice(end + 1);
			if (!line.startsWith('{')) continue;
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (event.type === 'thread.started' && threadId(event.thread_id)) thread = event.thread_id;
			if (event.type === 'turn.completed') completed = true;
			if (event.type === 'turn.failed' || event.type === 'error')
				failure ??= 'Codex could not finish the image';
		}
	});
	child.stdin.on('error', () => {});
	child.stdin.end(input.prompt);
	try {
		await new Promise<void>((done, fail) => {
			child.once('error', fail);
			child.once('close', () => done());
		});
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener('abort', abort);
	}
	if (!thread) throw new Error(failure ?? 'Codex did not start');
	const folder = join(input.codexHome, 'generated_images', thread);
	try {
		if (failure) throw new Error(failure);
		if (!completed) throw new Error('Codex did not finish the image');
		const found: { path: string; time: number }[] = [];
		for (const name of await readdir(folder).catch(() => [])) {
			if (!name.toLowerCase().endsWith('.png')) continue;
			const info = await stat(join(folder, name)).catch(() => null);
			if (info?.isFile() && info.size > 0 && info.size <= projectImageLimit)
				found.push({ path: join(folder, name), time: info.mtimeMs });
		}
		const newest = found.sort((a, b) => b.time - a.time)[0];
		if (!newest) throw new Error('Codex drew no image');
		return await readFile(newest.path);
	} finally {
		await rm(folder, { recursive: true, force: true }).catch(() => {});
	}
}
