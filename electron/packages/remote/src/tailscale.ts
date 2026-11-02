/**
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-network: what Tailscale says about this machine — its name in the tailnet (the phone's address and
 * the passkeys' RP ID) and whether `tailscale serve` sends `https://<name>/` to the web listener. Read from the CLI's JSON,
 * never more than 5 s a call; without the CLI the settings show the command to run.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export type TailscaleState = {
	/** The CLI that answered, or null. */
	cli: string | null;
	/** `studio.tail1234.ts.net`, lowercase, no trailing dot; null when Tailscale is off or has no MagicDNS name. */
	host: string | null;
	/** spec/remote-access-and-mobile#tailscale-guidance: HTTPS certificates are on for the tailnet (`CertDomains` in `tailscale status --json`). */
	https: boolean;
	/** `tailscale serve` proxies `https://<host>:443/` to this listener. */
	serving: boolean;
	/** Tailscale Funnel publishes `<host>:443` on the internet: the listener refuses to run behind it. */
	funnel: boolean;
	/**
	 * Another path of `https://<host>` goes to another service (`tailscale serve --set-path`): its pages share the origin
	 * with the phone's, so the listener refuses to run (security review W0, W3).
	 */
	shared: boolean;
};
export const tailscaleCandidates = [
	'tailscale',
	'/Applications/Tailscale.app/Contents/MacOS/Tailscale',
	'/opt/homebrew/bin/tailscale',
	'/usr/local/bin/tailscale',
];
export function tailscaleServeCommand(port: number): string {
	return `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;
}
/** Only MagicDNS names under `ts.net`: that is where `tailscale serve` gets a certificate the phone trusts. */
export function isTailnetHost(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 253 &&
		/^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*\.ts\.net$/.test(value)
	);
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
/** `tailscale status --json` → `Self.DNSName` without its dot. */
export function tailnetHost(status: unknown): string | null {
	if (!isRecord(status) || !isRecord(status.Self)) return null;
	if (status.BackendState !== undefined && status.BackendState !== 'Running') return null;
	const name = status.Self.DNSName;
	if (typeof name !== 'string') return null;
	const host = name.replace(/\.$/, '').toLowerCase();
	return isTailnetHost(host) ? host : null;
}
/** spec/remote-access-and-mobile#tailscale-guidance: `CertDomains` is set only when HTTPS is on in the tailnet's DNS settings. */
export function tailnetHttps(status: unknown): boolean {
	return (
		isRecord(status) &&
		Array.isArray(status.CertDomains) &&
		status.CertDomains.some((item) => typeof item === 'string' && item.length > 0)
	);
}
/**
 * `tailscale serve status --json` (an `ipn.ServeConfig`, maybe with foreground sessions): whether `<host>:443` has a `/`
 * handler proxying to `http://127.0.0.1:<port>` (or `localhost`), and whether Funnel is on for it.
 */
export function serveState(
	config: unknown,
	host: string,
	port: number
): { serving: boolean; funnel: boolean; shared: boolean } {
	const configs: Record<string, unknown>[] = [];
	if (isRecord(config)) {
		configs.push(config);
		if (isRecord(config.Foreground))
			for (const item of Object.values(config.Foreground)) if (isRecord(item)) configs.push(item);
	}
	const target = new RegExp(
		`^(?:https?\\+insecure://|http://)?(?:127\\.0\\.0\\.1|localhost):${port}/?$`
	);
	let serving = false,
		funnel = false,
		others = false;
	for (const item of configs) {
		const web = isRecord(item.Web) ? item.Web[`${host}:443`] : undefined;
		const handlers = isRecord(web) && isRecord(web.Handlers) ? web.Handlers : {};
		for (const [path, handler] of Object.entries(handlers)) {
			if (
				path === '/' &&
				isRecord(handler) &&
				typeof handler.Proxy === 'string' &&
				target.test(handler.Proxy)
			)
				serving = true;
			else others = true;
		}
		if (isRecord(item.AllowFunnel) && item.AllowFunnel[`${host}:443`] === true) funnel = true;
	}
	return { serving, funnel, shared: serving && others };
}
export type RunJson = (command: string, args: string[]) => Promise<unknown>;
const runJson: RunJson = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			if (error) return reject(error);
			try {
				resolve(JSON.parse(stdout));
			} catch (parse) {
				reject(parse);
			}
		});
	});
export async function readTailscale(
	port: number,
	run: RunJson = runJson,
	candidates: readonly string[] = tailscaleCandidates
): Promise<TailscaleState> {
	for (const cli of candidates) {
		if (cli.startsWith('/') && !existsSync(cli)) continue;
		let status: unknown;
		try {
			status = await run(cli, ['status', '--json']);
		} catch (error) {
			// Not there (ENOENT): the next one. There but failing (Tailscale stopped): this is the CLI, without a name.
			if ((error as { code?: unknown }).code === 'ENOENT') continue;
			return { cli, host: null, https: false, serving: false, funnel: false, shared: false };
		}
		const host = tailnetHost(status);
		const https = tailnetHttps(status);
		if (!host) return { cli, host: null, https, serving: false, funnel: false, shared: false };
		try {
			return {
				cli,
				host,
				https,
				...serveState(await run(cli, ['serve', 'status', '--json']), host, port),
			};
		} catch {
			return { cli, host, https, serving: false, funnel: false, shared: false };
		}
	}
	return { cli: null, host: null, https: false, serving: false, funnel: false, shared: false };
}
