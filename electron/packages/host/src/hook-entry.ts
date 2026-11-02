// Kept for CLIs launched with an earlier build's settings; new launches relay through resources/hook.zsh (perf review TUI-06).
import { createConnection } from 'node:net';
import { Peer } from './peer';
import { cliHook } from '@brigadir/transport/cli-hooks';
async function main() {
	let input = '';
	for await (const chunk of process.stdin) {
		input += chunk;
		if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Hook input is too large');
	}
	const hook = cliHook(JSON.parse(input));
	if (!hook) return;
	const peer = new Peer(createConnection(process.env.BRIGADIR_HOST_SOCKET!));
	const timer = setTimeout(() => peer.close(), 8000);
	try {
		await peer.request('handshake', {
			protocolVersion: 1,
			instance: process.env.BRIGADIR_HOST_INSTANCE,
			key: { projectId: process.env.BRIGADIR_PROJECT_ID, id: process.env.BRIGADIR_TASK_ID },
			role: 'hook',
			token: process.env.BRIGADIR_HOOK_TOKEN,
		});
		// Host validates the original shape independently; the relay only bounds/filter input.
		const output = await peer.request('cli_hook', JSON.parse(input));
		if (output) process.stdout.write(JSON.stringify(output));
	} finally {
		clearTimeout(timer);
		peer.close();
	}
}
void main().catch(() => {
	process.stderr.write('Brigadir could not record this CLI hook.\n');
	process.exitCode = 1;
});
