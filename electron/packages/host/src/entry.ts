import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isRecord, isTaskKey } from '@brigadir/core';
import { startHost, type HostConfig } from './server';
async function main() {
	const path = process.argv[2];
	if (!path) throw new Error('Expected host configuration file');
	const value: unknown = JSON.parse(await readFile(path, 'utf8'));
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!isTaskKey(value.key) ||
		typeof value.dataDir !== 'string' ||
		!isAbsolute(value.dataDir) ||
		typeof value.mcpEntry !== 'string' ||
		!isAbsolute(value.mcpEntry) ||
		(value.runtime !== undefined &&
			(typeof value.runtime !== 'string' || !isAbsolute(value.runtime)))
	)
		throw new Error('Invalid host configuration');
	for (const launch of [value.adapter, value.cli])
		if (
			launch !== undefined &&
			(!isRecord(launch) ||
				typeof launch.command !== 'string' ||
				!Array.isArray(launch.args) ||
				!launch.args.every((a) => typeof a === 'string'))
		)
			throw new Error('Invalid launch configuration');
	if (value.consoleOnly !== undefined && typeof value.consoleOnly !== 'boolean')
		throw new Error('Invalid console configuration');
	if (value.allowScopeConflict !== undefined && typeof value.allowScopeConflict !== 'boolean')
		throw new Error('Invalid repo override');
	const config = value as HostConfig;
	const host = await startHost(config);
	process.once('SIGTERM', () => {
		void host.stop('terminated');
	});
	process.once('SIGINT', () => {
		void host.stop('terminated');
	});
	await host.closed;
}
void main().catch((e) => {
	console.error(e instanceof Error ? e.message : 'Host failed');
	process.exitCode = 1;
});
