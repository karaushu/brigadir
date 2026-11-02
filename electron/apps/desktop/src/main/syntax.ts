import { createHash } from 'node:crypto';
import { syntaxLanguage, syntaxLimit, type SyntaxSnapshot } from '@brigadir/core';
import { WorkerPool } from './worker';
/**
 * `view` serves the diff sides, the editor and review anchors; `code` the fences of assistant answers; `lookup` the
 * code-intelligence fallback. Separate queues keep a streaming answer or a declaration batch from delaying the open
 * file (perf review R7). Each queue is bounded; a request past the bound fails without entering the cache.
 */
export type SyntaxLane = 'view' | 'code' | 'lookup';
export class Syntax {
	private cache = new Map<string, Promise<SyntaxSnapshot>>();
	/** Tokens of each resolved entry: the cache also stays under `tokenBudget` tokens in total, since one file may now carry
	 *  up to 150k tokens (perf review SYN-02). */
	private weights = new Map<string, number>();
	private lanes: Record<SyntaxLane, WorkerPool>;
	constructor(
		readonly workerPath: string,
		private tokenBudget = 400_000
	) {
		this.lanes = {
			view: new WorkerPool(workerPath, { size: 2, queue: 32 }),
			code: new WorkerPool(workerPath, { queue: 32 }),
			lookup: new WorkerPool(workerPath, { queue: 12 }),
		};
	}
	/** `supersede` names the editor buffer: its newer text replaces a request still waiting in the queue. */
	read(
		path: string,
		text: string,
		lane: SyntaxLane = 'view',
		supersede?: string
	): Promise<SyntaxSnapshot> {
		const language = syntaxLanguage(path);
		if (!language || Buffer.byteLength(text) > syntaxLimit || text.split('\n').length > 50000)
			return Promise.resolve({
				status: language ? 'large' : 'plain',
				language,
				tokens: [],
				symbols: [],
			});
		const id = createHash('sha256')
			.update(language + '\0' + text)
			.digest('hex');
		const cached = this.cache.get(id);
		// Least recently used goes first: a hit moves to the end.
		if (cached) {
			this.cache.delete(id);
			this.cache.set(id, cached);
			return cached;
		}
		const result = this.lanes[lane]
			.run<SyntaxSnapshot>({ path, text }, supersede)
			.catch((): SyntaxSnapshot => ({ status: 'failed', language, tokens: [], symbols: [] }));
		void result.then((value) => {
			if (this.cache.get(id) !== result) return;
			if (value.status === 'failed') this.cache.delete(id);
			else {
				this.weights.set(id, value.tokens.length);
				this.trim();
			}
		});
		this.cache.set(id, result);
		this.trim();
		return result;
	}
	private trim() {
		let total = 0;
		for (const weight of this.weights.values()) total += weight;
		while (this.cache.size > 16 || (total > this.tokenBudget && this.cache.size > 1)) {
			const oldest = this.cache.keys().next().value!;
			this.cache.delete(oldest);
			total -= this.weights.get(oldest) ?? 0;
			this.weights.delete(oldest);
		}
	}
	/** Fallback declaration lookup (spec/editor-code-intelligence#fallback-mode): one worker job for a batch. */
	declarations(
		language: string,
		texts: string[],
		name: string
	): Promise<{ index: number; from: number }[]> {
		return this.lanes.lookup
			.run<{ index: number; from: number }[]>({ mode: 'declarations', language, texts, name })
			.catch(() => []);
	}
	close() {
		for (const lane of Object.values(this.lanes)) lane.close();
	}
}
