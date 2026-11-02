import { afterEach, expect, it } from 'vitest';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterCommand, adapterRefreshCommand, installedAdapter } from './adapter';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function install(root: string, hash: string, version: string, executable = true) {
	const modules = join(root, hash, 'node_modules'),
		bin = join(modules, '.bin', 'claude-agent-acp');
	await mkdir(join(modules, '@agentclientprotocol/claude-agent-acp'), { recursive: true });
	await mkdir(join(modules, '.bin'), { recursive: true });
	await writeFile(
		join(modules, '@agentclientprotocol/claude-agent-acp/package.json'),
		JSON.stringify({ version })
	);
	await writeFile(bin, '#!/bin/sh\n');
	await chmod(bin, executable ? 0o755 : 0o644);
	await writeFile(
		join(modules, '.package-lock.json'),
		JSON.stringify({
			packages: { 'node_modules/@agentclientprotocol/claude-agent-acp': { version } },
		})
	);
	return bin;
}
it('runs the newest adapter npx installed and falls back to npx without one', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-npx-'));
	roots.push(root);
	expect(installedAdapter('claude', root)).toBeNull();
	await install(root, 'a', '0.9.12');
	const newest = await install(root, 'b', '0.81.1');
	await install(root, 'c', '0.100.0', false);
	expect(installedAdapter('claude', root)).toBe(newest);
	expect(installedAdapter('codex', root)).toBeNull();
	const previous = process.env.npm_config_cache;
	process.env.npm_config_cache = join(root, '..', `missing-${Date.now()}`);
	try {
		expect(adapterCommand('claude', '')).toEqual({
			command: 'npx',
			args: ['--yes', '@agentclientprotocol/claude-agent-acp'],
		});
	} finally {
		if (previous === undefined) delete process.env.npm_config_cache;
		else process.env.npm_config_cache = previous;
	}
});
it('skips and removes an install npm recorded but did not finish (spec/agents-and-providers#adapter-launch)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-npx-'));
	roots.push(root);
	const older = await install(root, 'a', '0.85.0');
	await install(root, 'b', '0.86.0');
	// The refresh was cut off: the lockfile lists the native SDK package, its folder holds only a partial binary.
	const modules = join(root, 'b', 'node_modules'),
		sdk = 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64';
	await mkdir(join(root, 'b', sdk), { recursive: true });
	await writeFile(join(root, 'b', sdk, 'claude'), 'partial');
	await writeFile(
		join(modules, '.package-lock.json'),
		JSON.stringify({
			packages: {
				'node_modules/@agentclientprotocol/claude-agent-acp': { version: '0.86.0' },
				[sdk]: { version: '0.3.287' },
			},
		})
	);
	expect(installedAdapter('claude', root)).toBe(older);
	expect(adapterRefreshCommand('claude', root)).toEqual({
		command: 'npx',
		args: [
			'--yes',
			'--package=@agentclientprotocol/claude-agent-acp@latest',
			'--',
			'node',
			'-e',
			'',
		],
	});
	await expect(access(join(root, 'b'))).rejects.toThrow();
	await access(join(root, 'a'));
	await rm(join(modules, '..', '..', 'a', 'node_modules', '.package-lock.json'));
	expect(installedAdapter('claude', root)).toBeNull();
});
