import { gitText } from './command';
/**
 * spec/tasks#sheet-base-ref: branches a task can start from — local first, then remote-tracking, newest commit
 * first. `origin/HEAD` is a pointer, not a branch, so it never appears.
 */
export async function listRefs(path: string, limit = 60): Promise<string[]> {
	const text = await gitText(path, [
		'for-each-ref',
		'--sort=-committerdate',
		'--count',
		String(limit),
		'--format=%(refname:short)',
		'refs/heads',
		'refs/remotes',
	]).catch(() => '');
	const refs = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.endsWith('/HEAD'));
	return [...new Set(refs)];
}
