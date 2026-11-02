import { describe, expect, it } from 'vitest';
import {
	readTailscale,
	serveState,
	tailnetHost,
	tailnetHttps,
	tailscaleServeCommand,
} from './tailscale';

const status = { BackendState: 'Running', Self: { DNSName: 'Studio.tail1234.ts.net.' } };
const serve = (proxy: string, extra: object = {}) => ({
	TCP: { '443': { HTTPS: true } },
	Web: { 'studio.tail1234.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } },
	...extra,
});

describe('Tailscale (spec/remote-access-and-mobile#phone-network)', () => {
	it('reads the machine’s tailnet name, only a ts.net one of a running backend', () => {
		expect(tailnetHost(status)).toBe('studio.tail1234.ts.net');
		expect(tailnetHost({ ...status, BackendState: 'Stopped' })).toBeNull();
		expect(tailnetHost({ Self: { DNSName: 'studio.example.com.' } })).toBeNull();
		expect(tailnetHost({ Self: { DNSName: 'evil.ts.net/x.' } })).toBeNull();
		expect(tailnetHost(null)).toBeNull();
	});
	it('knows when serve proxies the name to the listener, and when Funnel publishes it', () => {
		const host = 'studio.tail1234.ts.net';
		expect(serveState(serve('http://127.0.0.1:7422'), host, 7422)).toEqual({
			serving: true,
			funnel: false,
			shared: false,
		});
		expect(serveState(serve('http://localhost:7422/'), host, 7422).serving).toBe(true);
		expect(serveState(serve('http://127.0.0.1:7423'), host, 7422).serving).toBe(false);
		expect(serveState(serve('http://192.168.1.2:7422'), host, 7422).serving).toBe(false);
		expect(
			serveState({ Foreground: { abc: serve('http://127.0.0.1:7422') } }, host, 7422).serving
		).toBe(true);
		expect(
			serveState(
				serve('http://127.0.0.1:7422', { AllowFunnel: { [`${host}:443`]: true } }),
				host,
				7422
			)
		).toEqual({ serving: true, funnel: true, shared: false });
		expect(serveState({}, host, 7422)).toEqual({ serving: false, funnel: false, shared: false });
	});
	it('knows when another service shares the origin through another path (security review W0, W3)', () => {
		const host = 'studio.tail1234.ts.net';
		const shared = {
			TCP: { '443': { HTTPS: true } },
			Web: {
				[`${host}:443`]: {
					Handlers: {
						'/': { Proxy: 'http://127.0.0.1:7422' },
						'/grafana': { Proxy: 'http://127.0.0.1:3000' },
					},
				},
			},
		};
		expect(serveState(shared, host, 7422)).toEqual({ serving: true, funnel: false, shared: true });
		// Another port of the same name is another origin.
		const otherPort = {
			...serve('http://127.0.0.1:7422'),
			Web: {
				[`${host}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7422' } } },
				[`${host}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
			},
		};
		expect(serveState(otherPort, host, 7422).shared).toBe(false);
		// A foreground `tailscale serve` of another path counts too.
		expect(
			serveState(
				{
					...serve('http://127.0.0.1:7422'),
					Foreground: {
						abc: { Web: { [`${host}:443`]: { Handlers: { '/x': { Path: '/tmp' } } } } },
					},
				},
				host,
				7422
			).shared
		).toBe(true);
	});
	it('spec/remote-access-and-mobile#tailscale-guidance: HTTPS on in the tailnet is a non-empty CertDomains', () => {
		expect(tailnetHttps({ CertDomains: ['studio.tail1234.ts.net'] })).toBe(true);
		expect(tailnetHttps({ CertDomains: [] })).toBe(false);
		expect(tailnetHttps({ CertDomains: null })).toBe(false);
		expect(tailnetHttps({})).toBe(false);
		expect(tailnetHttps(null)).toBe(false);
	});
	it('tries the CLI where it lives and says what to run', async () => {
		const asked: string[] = [];
		const run = async (cli: string, args: string[]) => {
			asked.push(`${cli} ${args.join(' ')}`);
			if (cli === 'tailscale') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			return args[0] === 'status' ? status : serve('http://127.0.0.1:7422');
		};
		expect(await readTailscale(7422, run, ['tailscale', 'other'])).toEqual({
			cli: 'other',
			host: 'studio.tail1234.ts.net',
			https: false,
			serving: true,
			funnel: false,
			shared: false,
		});
		expect(asked).toEqual([
			'tailscale status --json',
			'other status --json',
			'other serve status --json',
		]);
		expect(await readTailscale(7422, run, ['tailscale'])).toEqual({
			cli: null,
			host: null,
			https: false,
			serving: false,
			funnel: false,
			shared: false,
		});
		expect(tailscaleServeCommand(7422)).toBe(
			'tailscale serve --bg --https=443 http://127.0.0.1:7422'
		);
	});
});
