import {
	ipcInvokeRows,
	remoteActiveOnly,
	remoteCallRefusal,
	webCallRefusal,
	type AppSettings,
} from '@brigadir/core';
import type { Client } from './clients';

export type Handler = (client: Client, args: unknown[]) => unknown;
export type DispatchRules = {
	handlers: ReadonlyMap<string, Handler>;
	/** spec/remote-access-and-mobile#architecture: what a device's `settings:save` may not change stays as it is. */
	guardSettings(client: Client, value: AppSettings): AppSettings;
	/** spec/remote-access-and-mobile#architecture: whether the client controls the machine now. */
	isActive(client: Client): boolean;
	/** spec/remote-access-and-mobile#pairing: a device asked for a row it may not call; the audit notes it. */
	refused?(client: Client, channel: string): void;
};
/**
 * spec/architecture-and-platform#ipc-boundary, spec/remote-access-and-mobile#architecture: the one way into a handler — for the local window, a device over the gateway and a window
 * of this machine that shows another one. The table's validator runs first for each; a window of another machine sends
 * its remote-class calls there; a device never reaches a client-class or forbidden row, and its `settings:save` keeps
 * the remote access settings as they are; a phone reaches the `web` class only (spec/remote-access-and-mobile#phone-network); per-client state follows
 * only the client in control.
 */
export async function dispatchCall(
	rules: DispatchRules,
	client: Client | null,
	channel: string,
	args: unknown[]
): Promise<unknown> {
	const row = ipcInvokeRows.get(channel),
		run = rules.handlers.get(channel);
	if (!client || !row || !run) throw new Error('Invalid IPC request');
	if (!row.validate(args)) throw new Error('Invalid IPC arguments');
	if (client.forward && row.class === 'remote') return client.forward(channel, args);
	if (client.device) {
		// spec/remote-access-and-mobile#phone-network: a phone reaches only the rows of the `web` class, and some of them only with certain arguments.
		const refusal =
			remoteCallRefusal(channel) ??
			(client.device.kind === 'phone' ? webCallRefusal(channel, args) : null);
		if (refusal) {
			rules.refused?.(client, channel);
			throw new Error(refusal);
		}
		if (row.remote === 'guarded' && channel === 'settings:save')
			args = [rules.guardSettings(client, args[0] as AppSettings)];
	}
	if (remoteActiveOnly(channel, args) && !rules.isActive(client)) return undefined;
	return run(client, args);
}
