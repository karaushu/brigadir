import { parentPort } from 'node:worker_threads';
import { join } from 'node:path';
import { analyze, declarations } from './index';
const assets = join(__dirname, 'syntax-assets');
type Request =
	| { mode: 'declarations'; language: string; texts: string[]; name: string }
	| { mode?: undefined; path: string; text: string };
// A keep-alive worker (main/worker.ts): the runtime and grammars load once, requests arrive one at a time.
parentPort!.on('message', (request: Request) => {
	if (request.mode === 'declarations')
		void declarations(request.language, request.texts, request.name, assets)
			.then((value) => parentPort!.postMessage({ value }))
			.catch(() => parentPort!.postMessage({ value: [] }));
	else
		void analyze(request.path, request.text, assets)
			.then((value) => parentPort!.postMessage({ value }))
			.catch(() =>
				parentPort!.postMessage({
					value: { status: 'failed', language: null, tokens: [], symbols: [] },
				})
			);
});
