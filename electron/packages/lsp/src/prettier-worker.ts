/**
 * spec/editor-code-intelligence#format-on-save: the project's own Prettier, one process per module path, run with Electron's Node
 * (`ELECTRON_RUN_AS_NODE`). JSON-RPC over stdio with the LSP framing; argv[2] is the Prettier package directory.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FrameReader, frame, type RpcMessage } from './rpc';
type Prettier = {
	version?: string;
	format(text: string, options: Record<string, unknown>): string | Promise<string>;
	resolveConfig(
		file: string,
		options?: Record<string, unknown>
	): Promise<Record<string, unknown> | null>;
	getFileInfo(
		file: string,
		options?: Record<string, unknown>
	): Promise<{ ignored: boolean; inferredParser: string | null }>;
};
// The package is the project's, resolved at run time from its own directory (`main`: index.cjs in Prettier 3).
const directory = process.argv[2] ?? '';
const prettier = createRequire(join(directory, 'package.json'))(directory) as Prettier;
type Params = { file: string; ignorePath: string | null; text?: string };
async function info(params: Params) {
	const found = await prettier.getFileInfo(params.file, {
		...(params.ignorePath ? { ignorePath: params.ignorePath } : {}),
		resolveConfig: true,
	});
	return {
		version: prettier.version ?? null,
		ignored: found.ignored,
		parser: found.inferredParser,
	};
}
async function format(params: Params) {
	const found = await info(params);
	if (found.ignored) return { status: 'ignored' };
	if (!found.parser) return { status: 'unsupported' };
	const config = (await prettier.resolveConfig(params.file, { editorconfig: true })) ?? {};
	// The editor holds LF text; the file keeps its own line endings when it is written.
	try {
		return {
			status: 'formatted',
			text: await prettier.format(params.text ?? '', {
				...config,
				filepath: params.file,
				endOfLine: 'lf',
			}),
		};
	} catch (error) {
		const loc = (error as { loc?: { start?: { line?: unknown } } }).loc?.start?.line;
		if (typeof loc === 'number' || (error as Error).name === 'SyntaxError')
			return { status: 'syntax', ...(typeof loc === 'number' ? { line: loc } : {}) };
		throw error;
	}
}
/** spec/editor#indentation: what the project's own config says about indentation for this file, and what only `.editorconfig` adds to it. */
async function indent(params: Params) {
	const pick = (config: Record<string, unknown> | null) => ({
		...(typeof config?.useTabs === 'boolean' ? { useTabs: config.useTabs } : {}),
		...(typeof config?.tabWidth === 'number' && Number.isSafeInteger(config.tabWidth)
			? { tabWidth: config.tabWidth }
			: {}),
	});
	const own = pick(await prettier.resolveConfig(params.file, { editorconfig: false }));
	const merged = pick(await prettier.resolveConfig(params.file, { editorconfig: true }));
	return { own, merged };
}
const send = (message: RpcMessage) => {
	process.stdout.write(frame(message));
};
const reader = new FrameReader(
	(message) => {
		if (message.id === undefined || message.id === null || typeof message.method !== 'string')
			return;
		const id = message.id;
		const params = message.params as Params;
		const run =
			message.method === 'info'
				? info(params)
				: message.method === 'format'
					? format(params)
					: message.method === 'indent'
						? indent(params)
						: Promise.reject(new Error(`Unknown method ${message.method}`));
		run.then(
			(result) => send({ jsonrpc: '2.0', id, result }),
			(error: Error) =>
				send({
					jsonrpc: '2.0',
					id,
					error: { code: -32603, message: String(error?.message ?? error).slice(0, 2000) },
				})
		);
	},
	() => process.exit(1)
);
process.stdin.on('data', (chunk: Buffer) => reader.push(chunk));
process.stdin.on('end', () => process.exit(0));
