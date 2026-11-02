import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLoginState } from '@brigadir/core';
import { AgentLogin } from './agent-login';
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
// A sign-in command: prints the page URL, waits for a code line (or exits by itself), writes what it read.
async function script(body: string) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-login-'));
	roots.push(root);
	const file = join(root, 'login.mjs');
	await writeFile(file, body);
	return { root, file };
}
const until = async (check: () => boolean) => {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
	expect(check()).toBe(true);
};
function service(file: string, signedIn: boolean | null = true) {
	const states: AgentLoginState[] = [],
		retry = vi.fn(async () => {}),
		openUrl = vi.fn(async () => {});
	const login = new AgentLogin({
		command: async () => ({
			command: process.execPath,
			args: [file],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		}),
		signedIn: async () => signedIn,
		openUrl,
		publish: (state) => states.push(state),
		retry,
	});
	return { login, states, retry, openUrl };
}
// spec/agents-and-providers#sign-in-recovery: the URL from the output, the code into stdin, success only with the CLI's own check, then every host retries.
it('reads the page URL, passes the code and retries after a confirmed sign-in', async () => {
	const { root, file } = await script(
		`import {writeFileSync} from 'node:fs';console.log('Opening browser to sign in…');console.log('If the browser didn\\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x');process.stdin.once('data',chunk=>{writeFileSync(${JSON.stringify('CODE')}.replace('CODE',process.argv[1]+'.code'),String(chunk));process.exit(0);});`
	);
	const { login, states, retry, openUrl } = service(file);
	expect((await login.start('claude')).phase).toBe('waiting');
	await until(() => login.state('claude').url !== null);
	expect(login.state('claude').url).toBe(
		'https://claude.com/cai/oauth/authorize?code=true&state=x'
	);
	await login.reopen('claude');
	expect(openUrl).toHaveBeenCalledWith('https://claude.com/cai/oauth/authorize?code=true&state=x');
	expect(() => login.submitCode('claude', 'a\nb')).toThrow();
	login.submitCode('claude', ' abc-123 ');
	await until(() => login.state('claude').phase === 'done');
	expect(await readFile(join(root, 'login.mjs.code'), 'utf8')).toBe('abc-123\n');
	await until(() => retry.mock.calls.length === 1);
	expect(retry).toHaveBeenCalledWith('claude');
	expect(states.map((state) => state.phase)).toEqual(['waiting', 'waiting', 'done']);
});
it('fails when the command exits without a sign-in and goes idle when cancelled', async () => {
	const { file } = await script(`process.exit(0);`);
	const { login, retry } = service(file, false);
	await login.start('codex');
	await until(() => login.state('codex').phase === 'failed');
	expect(retry).not.toHaveBeenCalled();
	expect(() => login.submitCode('codex', 'x')).toThrow();
	const hold = await script(`setInterval(()=>{},1000);`);
	const second = service(hold.file);
	await second.login.start('claude');
	await second.login.start('claude');
	second.login.cancel('claude');
	await until(() => second.login.state('claude').phase === 'idle');
	expect(second.retry).not.toHaveBeenCalled();
});
