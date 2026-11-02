import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateCodexImage } from './codex-image';

const thread = '01a16938-3731-7f50-b491-8675b25debde';
/** A fake `codex`: reads the prompt, prints the JSON events of `mode`, and saves an image the way Codex does. */
const fake = `
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const mode = process.env.FAKE_MODE;
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
	const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
	if (mode === 'no-thread') process.exit(1);
	say({ type: 'thread.started', thread_id: '${thread}' });
	say({ type: 'turn.started' });
	const folder = join(process.env.CODEX_HOME, 'generated_images', '${thread}');
	if (mode !== 'no-image') {
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, 'exec-1.png'), 'old');
		const later = Date.now() / 1000 + 5;
		writeFileSync(join(folder, 'exec-2.png'), 'image:' + prompt + ':' + process.argv.slice(2).join(' '));
		require('node:fs').utimesSync(join(folder, 'exec-2.png'), later, later);
	}
	if (mode === 'hang') return setTimeout(() => {}, 60000);
	say({ type: mode === 'failed' ? 'turn.failed' : 'turn.completed' });
});
`;
let dir: string, script: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'brigadir-codex-image-'));
	script = join(dir, 'codex.js');
	await writeFile(script, fake);
});
afterEach(() => rm(dir, { recursive: true, force: true }));
const run = (mode: string, timeoutMs?: number) =>
	generateCodexImage({
		cli: {
			command: process.execPath,
			args: [script],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FAKE_MODE: mode },
		},
		cwd: dir,
		prompt: 'draw a truck',
		codexHome: join(dir, 'home'),
		...(timeoutMs ? { timeoutMs } : {}),
	});

describe('Codex image generation (spec/projects-and-board#project-icon)', () => {
	it('reads the newest PNG of its thread and removes the thread folder', async () => {
		const image = (await run('ok')).toString();
		expect(image).toContain('image:draw a truck:');
		expect(image).toContain('exec --json --ephemeral --skip-git-repo-check --sandbox read-only');
		expect(image).toContain('--enable image_generation -');
		expect(await readdir(join(dir, 'home', 'generated_images'))).toEqual([]);
	});
	it('fails without an image, a thread or a finished turn, and still cleans up', async () => {
		await expect(run('no-image')).rejects.toThrow('Codex drew no image');
		await expect(run('no-thread')).rejects.toThrow('Codex did not start');
		await expect(run('failed')).rejects.toThrow('Codex could not finish the image');
		expect(await readdir(join(dir, 'home', 'generated_images'))).toEqual([]);
	});
	it('stops Codex at the time limit', async () => {
		await expect(run('hang', 800)).rejects.toThrow('Image generation timed out');
		expect(await readdir(join(dir, 'home', 'generated_images'))).toEqual([]);
	});
});
