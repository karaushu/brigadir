import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CPaceParty, scalarFromLittleEndian } from './cpace';
import { loadWebBundle } from './web-bundle';

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
const hex = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));
const toHex = (data: Uint8Array) => Buffer.from(data).toString('hex');
const ascii = (text: string) => new TextEncoder().encode(text);

/**
 * spec/remote-access-and-mobile#phone-network: `@brigadir/remote/web` is what a phone's page runs. Bundled for a browser (any `node:` import fails the
 * build), its CPace must give the draft's vectors and agree with the machine's CPace in Node.
 */
describe('CPace in the browser build', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-web-'));
	dirs.push(dir);
	const out = join(dir, 'web.mjs');
	await build({
		entryPoints: [resolve(__dirname, 'web.ts')],
		bundle: true,
		platform: 'browser',
		format: 'esm',
		outfile: out,
		logLevel: 'silent',
		// Packages resolve the way Node resolves them from here, not through a stray Yarn PnP file above the repo.
		plugins: [
			{
				name: 'node-resolve',
				setup(on) {
					on.onResolve({ filter: /^@(?:noble|brigadir)\// }, (args) => ({
						path: fileURLToPath(import.meta.resolve(args.path)),
					}));
				},
			},
		],
	});
	const web = (await import(pathToFileURL(out).href)) as typeof import('./web');
	it('gives the draft’s vectors (B.3)', () => {
		const sid = hex('7e4b4791d6a8ef019b936c79fb7f2c57');
		const input = {
			prs: ascii('Password'),
			ci: hex('0b415f696e69746961746f720b425f726573706f6e646572'),
			sid,
		};
		const ya = scalarFromLittleEndian(
			hex('da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08')
		);
		const yb = scalarFromLittleEndian(
			hex('d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d')
		);
		const a = new web.CPaceParty('initiator', input, ascii('ADa'), ya);
		const b = new web.CPaceParty('responder', input, ascii('ADb'), yb);
		expect(toHex(a.share)).toBe('d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157');
		expect(toHex(b.share)).toBe('3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258');
		const isk =
			'b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447';
		expect(toHex(a.finish(b.share, ascii('ADb')))).toBe(isk);
	});
	it('pairs with the machine’s CPace in Node: the same code confirms, another does not', () => {
		const run = (phoneCode: string) => {
			const sid = new Uint8Array(16).fill(3);
			const ci = web.webChannelIdentifier('https://studio.tail1234.ts.net');
			const phone = new web.CPaceParty(
				'initiator',
				{ prs: ascii(phoneCode), ci, sid },
				ascii('iPhone')
			);
			const machine = new CPaceParty(
				'responder',
				{ prs: ascii('5YCPYZKR'), ci, sid },
				ascii('studio')
			);
			machine.finish(phone.share, ascii('iPhone'));
			phone.finish(machine.share, ascii('studio'));
			return phone.verify(machine.tag()) && machine.verify(phone.tag());
		};
		expect(run('5YCPYZKR')).toBe(true);
		expect(run('5YCPYZKS')).toBe(false);
	});
	it('reads the frames the machine writes', () => {
		const frame = web.encodeFrame({
			t: 'event',
			channel: 'x',
			value: { bytes: Uint8Array.of(1, 2), none: undefined },
		});
		expect(web.decodeFrame(frame)).toEqual({
			t: 'event',
			channel: 'x',
			value: { bytes: Uint8Array.of(1, 2), none: undefined },
		});
		expect(web.toBase64Url(web.fromBase64Url('-_8'))).toBe('-_8');
	});
});

describe('the phone bundle’s public files (spec/remote-access-and-mobile#phone-network)', () => {
	it('serves the sign-in page’s closure and the PWA files without a sign-in, the app only with one', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'brigadir-bundle-'));
		dirs.push(dir);
		await mkdir(join(dir, 'assets'));
		for (const name of [
			'index.html',
			'sw.js',
			'manifest.webmanifest',
			'icon.svg',
			'secret.txt',
			'assets/index-1.js',
			'assets/index-1.css',
			'assets/shared-1.js',
			'assets/app-1.js',
			'assets/app-1.css',
			'assets/lazy-1.js',
		])
			await writeFile(join(dir, name), name);
		await mkdir(join(dir, '.hidden'));
		await writeFile(join(dir, '.hidden/x.js'), 'x');
		await writeFile(
			join(dir, 'bundle-manifest.json'),
			JSON.stringify({
				'index.html': {
					file: 'assets/index-1.js',
					isEntry: true,
					imports: ['_shared'],
					css: ['assets/index-1.css'],
				},
				_shared: { file: 'assets/shared-1.js' },
				'app.ts': {
					file: 'assets/app-1.js',
					isEntry: true,
					imports: ['_shared'],
					css: ['assets/app-1.css'],
					dynamicImports: ['lazy.ts'],
				},
				'lazy.ts': { file: 'assets/lazy-1.js', isDynamicEntry: true },
			})
		);
		const bundle = await loadWebBundle(dir);
		const open = [...bundle.files]
			.filter(([, file]) => file.public)
			.map(([path]) => path)
			.sort();
		expect(open).toEqual([
			'/assets/index-1.css',
			'/assets/index-1.js',
			'/assets/shared-1.js',
			'/icon.svg',
			'/index.html',
			'/manifest.webmanifest',
			'/sw.js',
		]);
		expect(bundle.files.get('/assets/app-1.js')?.public).toBe(false);
		expect(bundle.files.get('/assets/lazy-1.js')?.public).toBe(false);
		// Neither a file of an unknown type nor a dot folder nor the manifest itself is there at all.
		expect(bundle.files.has('/secret.txt')).toBe(false);
		expect(bundle.files.has('/.hidden/x.js')).toBe(false);
		expect(bundle.files.has('/bundle-manifest.json')).toBe(false);
		expect(bundle.app).toEqual({ script: '/assets/app-1.js', styles: ['/assets/app-1.css'] });
	});
});
