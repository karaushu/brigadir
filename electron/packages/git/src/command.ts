import { spawn } from 'node:child_process';
export class GitError extends Error {
	constructor(
		readonly args: string[],
		readonly code: number | null,
		message: string
	) {
		super(message);
	}
}
// At most 6 concurrent git processes per process; a FIFO queue, a freed slot passes to the next with no gap. The timeout counts from spawn.
let running = 0;
const waiting: (() => void)[] = [];
export async function git(
	cwd: string,
	args: string[],
	options: {
		env?: Record<string, string>;
		input?: string | Buffer;
		maxBytes?: number;
		timeoutMs?: number;
		/** spec/git#commit-dialog: the repo's own hooks run — only the person's explicit commit from the commit dialog. */
		hooks?: boolean;
	} = {}
): Promise<Buffer> {
	if (running < 6) running++;
	else await new Promise<void>((resolve) => waiting.push(resolve));
	try {
		return await spawnGit(cwd, args, options);
	} finally {
		const next = waiting.shift();
		if (next) next();
		else running--;
	}
}
// Without `GIT_OPTIONAL_LOCKS=0`, `status` takes index.lock and rewrites the user's index, and the child `status` in each
// submodule (both `status` and `add` in the root run it) rewrites the submodule's index; the agent's `git add`/`commit`
// then fails on the lock. The optional lock is only the side stat refresh: it does not disable the mandatory write lock
// (tested on add and commit). Only commands that never write the user's repo get the env: read subcommands and anything
// over our private index (`GIT_INDEX_FILE`). A worktree `git diff` rewrites the root index even with it, so unmerged
// paths are read with `ls-files -u`.
const readOnly = new Set([
	'status',
	'diff',
	'diff-tree',
	'ls-files',
	'ls-tree',
	'cat-file',
	'rev-parse',
	'rev-list',
	'log',
	'for-each-ref',
	'merge-base',
	'check-ignore',
	'merge-tree',
	'blame',
	'show',
]);
export function subcommand(args: readonly string[]): string | undefined {
	let i = 0;
	while (i < args.length && args[i]!.startsWith('-'))
		i += args[i] === '-c' || args[i] === '-C' ? 2 : 1;
	return args[i];
}
export function optionalLocksOff(args: readonly string[], env?: Record<string, string>): boolean {
	return env?.GIT_INDEX_FILE !== undefined || readOnly.has(subcommand(args) ?? '');
}
function spawnGit(
	cwd: string,
	args: string[],
	options: Parameters<typeof git>[2] = {}
): Promise<Buffer> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
	);
	return new Promise((resolve, reject) => {
		const child = spawn(
			'git',
			[
				...(options.hooks ? [] : ['-c', 'core.hooksPath=/dev/null']),
				'-c',
				'core.fsmonitor=false',
				'-c',
				'commit.gpgsign=false',
				...args,
			],
			{
				cwd,
				env: {
					...env,
					...(optionalLocksOff(args, options.env) ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
					...options.env,
				},
				stdio: 'pipe',
				shell: false,
			}
		);
		const output: Buffer[] = [];
		const errors: Buffer[] = [];
		let size = 0;
		let exceeded = false;
		const timer = setTimeout(() => {
			exceeded = true;
			child.kill('SIGKILL');
		}, options.timeoutMs ?? 60_000);
		timer.unref();
		child.stdout.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > (options.maxBytes ?? 32 * 1024 * 1024)) {
				exceeded = true;
				child.kill('SIGKILL');
			} else output.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			if (errors.reduce((n, b) => n + b.length, 0) < 100_000) errors.push(chunk);
		});
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.stdin.on('error', () => {});
		child.once('close', (code) => {
			clearTimeout(timer);
			if (code === 0 && !exceeded) resolve(Buffer.concat(output));
			else
				reject(
					new GitError(
						args,
						code,
						exceeded
							? 'Git operation exceeded its resource limit'
							: Buffer.concat(errors).toString('utf8').trim()
					)
				);
		});
		child.stdin.end(options.input);
	});
}
export async function gitText(
	cwd: string,
	args: string[],
	options: Parameters<typeof git>[2] = {}
) {
	return (await git(cwd, args, options)).toString('utf8').trim();
}
export function isSha(value: unknown): value is string {
	return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}
