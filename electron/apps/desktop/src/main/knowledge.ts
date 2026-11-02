import { randomUUID } from 'node:crypto';
import {
	emptyJournalCursor,
	isRecord,
	isId,
	isUserQuestion,
	mineKnowledge,
	knowledgePrompt,
	type JournalCursor,
	type KnowledgeExchange,
	type KnowledgeProposal,
	type KnowledgeTarget,
	type KnowledgePreview,
	type KnowledgeReceipt,
	type KnowledgeSnapshot,
} from '@brigadir/core';
import {
	SessionStore,
	readWorkspace,
	readDocument,
	safePath,
	atomicJson,
	scanQuestions,
	readKnowledgeFile,
	replaceKnowledgeFile,
	projectFile,
} from '@brigadir/persistence';
import { discoverScopes } from '@brigadir/git';
type Receipt = KnowledgeReceipt & {
	root: string;
	before: string | null;
	after: string;
	phase: 'prepared' | 'added' | 'undoing' | 'undone' | 'dismissed';
};
type Document = {
	schemaVersion: 1;
	cursors: Record<string, JournalCursor>;
	exchanges: KnowledgeExchange[];
	proposals: KnowledgeProposal[];
	restored: string[];
	lastDay: string | null;
	nextTask: number;
	receipts: Receipt[];
};
const fresh = (): Document => ({
	schemaVersion: 1,
	cursors: {},
	exchanges: [],
	proposals: [],
	restored: [],
	lastDay: null,
	nextTask: 0,
	receipts: [],
});
const text = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number =>
	Number.isSafeInteger(value) && (value as number) >= 0;
const exchange = (v: unknown): v is KnowledgeExchange =>
	isRecord(v) &&
	isId(v.taskId) &&
	text(v.questionId) &&
	number(v.turn) &&
	number(v.seq) &&
	text(v.question) &&
	text(v.answer);
function validate(v: Record<string, unknown>): Document {
	if (
		!isRecord(v.cursors) ||
		!Object.entries(v.cursors).every(
			([id, c]) =>
				isId(id) &&
				isRecord(c) &&
				number(c.offset) &&
				number(c.turn) &&
				text(c.identity) &&
				text(c.carry) &&
				c.carry.length < 90000 &&
				typeof c.discard === 'boolean' &&
				isRecord(c.pending) &&
				Object.values(c.pending).every(
					(p) => isRecord(p) && isUserQuestion(p.question) && number(p.turn) && number(p.seq)
				)
		) ||
		!Array.isArray(v.exchanges) ||
		!v.exchanges.every(exchange) ||
		!Array.isArray(v.proposals) ||
		!v.proposals.every(
			(p) =>
				isRecord(p) &&
				text(p.signature) &&
				Array.isArray(p.tokens) &&
				p.tokens.every(text) &&
				Array.isArray(p.sources) &&
				p.sources.every(exchange) &&
				['proposed', 'rejected', 'added'].includes(p.state as string) &&
				text(p.createdAt)
		) ||
		!Array.isArray(v.restored) ||
		!v.restored.every(text) ||
		!(v.lastDay === null || text(v.lastDay)) ||
		!number(v.nextTask) ||
		!Array.isArray(v.receipts) ||
		!v.receipts.every(
			(r) =>
				isRecord(r) &&
				text(r.id) &&
				text(r.signature) &&
				isRecord(r.target) &&
				text(r.target.scopeId) &&
				text(r.target.path) &&
				text(r.root) &&
				(r.before === null || text(r.before)) &&
				text(r.after) &&
				text(r.added) &&
				['prepared', 'added', 'undoing', 'undone', 'dismissed'].includes(r.phase as string)
		)
	)
		throw new Error('Invalid project knowledge');
	return v as Document;
}
export class Knowledge {
	private tails = new Map<string, Promise<unknown>>();
	private observing = new Map<string, Promise<void>>();
	private previews = new Map<
		string,
		{
			projectId: string;
			signature: string;
			target: KnowledgeTarget;
			root: string;
			before: string | null;
		}
	>();
	private generations = new Map<string, AbortController>();
	isRemoving: (projectId: string) => boolean = () => false;
	constructor(
		private dataDir: string | undefined,
		/** spec/agents-and-providers#provider-terms: main passes the Helper agent (spec/composer-steering-queue-and-ghost#ghost-headless); without it nothing is written. */
		private writeText: (prompt: string, signal: AbortSignal) => Promise<string> = async () => {
			throw new Error('The helper agent is off.');
		}
	) {}
	get isSaving() {
		return this.tails.size > 0;
	}
	waitForWrites() {
		return Promise.allSettled([...this.tails.values()]);
	}
	cancelAll() {
		for (const controller of this.generations.values()) controller.abort();
	}
	cancel(projectId: string) {
		for (const [key, controller] of this.generations)
			if (key.startsWith(projectId + '/')) controller.abort();
	}
	private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
		if (this.isRemoving(id)) return Promise.reject(new Error('Project removal is in progress'));
		const next = (this.tails.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
		this.tails.set(id, next);
		void next
			.finally(() => {
				if (this.tails.get(id) === next) this.tails.delete(id);
			})
			.catch(() => {});
		return next;
	}
	private async load(projectId: string) {
		const store = await SessionStore.at(this.dataDir),
			project = await store.project(projectId),
			path = await safePath(store.root, 'projects', projectId, 'knowledge.json');
		let doc: Document,
			exists = true;
		try {
			doc = validate(await readDocument(path, 32 * 1024 * 1024));
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') throw error;
			doc = fresh();
			exists = false;
		}
		return { store, project, path, doc, exists };
	}
	private async save(path: string, doc: Document) {
		if (Buffer.byteLength(JSON.stringify(doc)) > 32 * 1024 * 1024)
			throw new Error('Project knowledge reached its storage limit');
		await atomicJson(path, doc);
	}
	private async scopes(projectId: string) {
		const { project } = await this.load(projectId);
		const scopes = await discoverScopes(project.path);
		return scopes.some((scope) => scope.path === project.path)
			? scopes
			: [{ id: 'root', name: '.', path: project.path }, ...scopes];
	}
	private async resolve(projectId: string, target: KnowledgeTarget) {
		const scope = (await this.scopes(projectId)).find((item) => item.id === target.scopeId);
		if (!scope) throw new Error('Repo is unavailable');
		await projectFile(scope.path, target.path);
		return scope;
	}
	private proposal(doc: Document, signature: string) {
		const proposal = doc.proposals.find(
			(item) => item.signature === signature && item.state === 'proposed'
		);
		if (!proposal) throw new Error('The proposal is no longer available');
		return proposal;
	}
	/** Mines questions after a finished turn of any task: no repo discovery, no rewrite without a change, and turns
	 *  that end while a pass is still queued for the project share it. */
	observe(projectId: string): Promise<void> {
		const queued = this.observing.get(projectId);
		if (queued) return queued;
		const pass = this.serial(projectId, async () => {
			this.observing.delete(projectId);
			await this.mine(projectId);
		});
		this.observing.set(projectId, pass);
		void pass
			.catch(() => {})
			.finally(() => {
				if (this.observing.get(projectId) === pass) this.observing.delete(projectId);
			});
		return pass;
	}
	read(projectId: string): Promise<KnowledgeSnapshot> {
		return this.serial(projectId, async () => {
			const doc = await this.mine(projectId);
			const scopes = await this.scopes(projectId);
			return {
				proposals: doc.proposals,
				scopes: scopes.map(({ id, name }) => ({ id, name })),
				receipts: doc.receipts
					.filter((item) => item.phase === 'added')
					.map(({ id, signature, target, added }) => ({ id, signature, target, added })),
			};
		});
	}
	private async mine(projectId: string): Promise<Document> {
		const { store, path, doc, exists } = await this.load(projectId),
			before = exists ? JSON.stringify(doc) : null;
		// A prepared receipt survives a crash between the working-file write and final metadata.
		for (const receipt of doc.receipts.filter(
			(item) => item.phase === 'prepared' || item.phase === 'undoing'
		)) {
			const scope = await this.resolve(projectId, receipt.target);
			if (scope.path !== receipt.root) throw new Error('Repo changed');
			const current = await readKnowledgeFile(scope.path, receipt.target.path);
			if (current === receipt.after) {
				receipt.phase = 'added';
				const proposal = doc.proposals.find((item) => item.signature === receipt.signature);
				if (proposal) proposal.state = 'added';
			} else if (current === receipt.before) {
				const undoing = receipt.phase === 'undoing';
				receipt.phase = 'undone';
				if (undoing) {
					const proposal = doc.proposals.find((item) => item.signature === receipt.signature);
					if (proposal) proposal.state = 'proposed';
				}
			} else throw new Error('The file changed during an interrupted knowledge write.');
		}
		const tasks = (await readWorkspace(this.dataDir ? { dataDir: this.dataDir } : {})).tasks.filter(
			(task) => task.projectId === projectId
		);
		let budget = 1024 * 1024,
			visited = 0;
		while (visited < tasks.length && budget > 0) {
			const index = doc.nextTask % tasks.length,
				task = tasks[index]!;
			doc.nextTask = (index + 1) % tasks.length;
			visited++;
			const scan = await scanQuestions(
				await safePath(await store.taskDir(task), 'events.jsonl'),
				task.id,
				(Object.hasOwn(doc.cursors, task.id) ? doc.cursors[task.id] : undefined) ??
					emptyJournalCursor(),
				Math.min(budget, 256 * 1024)
			);
			Object.defineProperty(doc.cursors, task.id, {
				value: scan.cursor,
				enumerable: true,
				writable: true,
				configurable: true,
			});
			budget -= scan.bytes;
			for (const item of scan.exchanges)
				if (
					!doc.exchanges.some(
						(prior) => prior.taskId === item.taskId && prior.questionId === item.questionId
					)
				)
					doc.exchanges.push(item);
		}
		doc.exchanges = doc.exchanges.slice(-1000);
		Object.assign(doc, mineKnowledge(doc, new Date()));
		if (JSON.stringify(doc) !== before) await this.save(path, doc);
		return doc;
	}
	prepare(
		projectId: string,
		signature: string,
		target: KnowledgeTarget
	): Promise<KnowledgePreview> {
		return this.serial(projectId, async () => {
			const { doc } = await this.load(projectId);
			this.proposal(doc, signature);
			const scope = await this.resolve(projectId, target),
				before = await readKnowledgeFile(scope.path, target.path),
				id = randomUUID();
			this.previews.set(id, {
				projectId,
				signature,
				target: { ...target },
				root: scope.path,
				before,
			});
			while (this.previews.size > 100) this.previews.delete(this.previews.keys().next().value!);
			return { id, target: { ...target }, exists: before !== null, text: before ?? '' };
		});
	}
	private preview(projectId: string, signature: string, id: string) {
		const preview = this.previews.get(id);
		if (!preview || preview.projectId !== projectId || preview.signature !== signature)
			throw new Error('Review the destination again.');
		return preview;
	}
	async generate(projectId: string, signature: string, id: string) {
		const key = projectId + '/' + signature;
		if (this.generations.has(key)) throw new Error('Generation is already in progress');
		if (this.isRemoving(projectId)) throw new Error('Project removal is in progress');
		const controller = new AbortController();
		this.generations.set(key, controller);
		try {
			const preview = this.preview(projectId, signature, id),
				{ doc } = await this.load(projectId),
				proposal = this.proposal(doc, signature);
			if (controller.signal.aborted) throw new Error('Cancelled');
			const output = (
				await this.writeText(
					knowledgePrompt(proposal.sources, preview.before ?? ''),
					controller.signal
				)
			).trim();
			if (!output || output.length > 16000)
				throw new Error('The agent did not return an addition.');
			return output;
		} finally {
			this.generations.delete(key);
		}
	}
	reject(projectId: string, signature: string) {
		return this.serial(projectId, async () => {
			this.cancel(projectId);
			const { doc, path } = await this.load(projectId);
			this.proposal(doc, signature).state = 'rejected';
			await this.save(path, doc);
		});
	}
	restore(projectId: string, signature: string) {
		return this.serial(projectId, async () => {
			const { doc, path } = await this.load(projectId),
				proposal = doc.proposals.find(
					(item) => item.signature === signature && item.state === 'rejected'
				);
			if (!proposal) throw new Error('The rejected proposal is unavailable');
			doc.exchanges.push(
				...proposal.sources.filter(
					(source) =>
						!doc.exchanges.some(
							(item) => item.taskId === source.taskId && item.questionId === source.questionId
						)
				)
			);
			doc.proposals = doc.proposals.filter((item) => item !== proposal);
			doc.restored.push(signature);
			await this.save(path, doc);
		});
	}
	add(projectId: string, signature: string, id: string, text: string): Promise<KnowledgeReceipt> {
		return this.serial(projectId, async () => {
			if (!text.trim() || text.length > 16000) throw new Error('Enter the addition.');
			const preview = this.preview(projectId, signature, id),
				{ doc, path } = await this.load(projectId),
				proposal = this.proposal(doc, signature),
				scope = await this.resolve(projectId, preview.target);
			if (scope.path !== preview.root) throw new Error('Repo changed');
			const newline =
					preview.before?.includes('\r\n') && !/(?<!\r)\n/.test(preview.before) ? '\r\n' : '\n',
				added =
					(preview.before && !preview.before.endsWith('\n') ? newline : '') +
					(preview.before ? newline : '') +
					text.trim().replace(/\r?\n/g, newline) +
					newline,
				after = (preview.before ?? '') + added;
			const receipt: Receipt = {
				id: randomUUID(),
				signature,
				target: preview.target,
				root: scope.path,
				before: preview.before,
				after,
				added,
				phase: 'prepared',
			};
			doc.receipts.push(receipt);
			doc.receipts = doc.receipts.slice(-50);
			await this.save(path, doc);
			try {
				await replaceKnowledgeFile(scope.path, preview.target.path, preview.before, after);
			} catch (error) {
				receipt.phase = 'undone';
				await this.save(path, doc);
				throw error;
			}
			receipt.phase = 'added';
			proposal.state = 'added';
			await this.save(path, doc);
			this.previews.delete(id);
			return { id: receipt.id, signature, target: receipt.target, added };
		});
	}
	undo(projectId: string, id: string) {
		return this.serial(projectId, async () => {
			const { doc, path } = await this.load(projectId),
				receipt = doc.receipts.find((item) => item.id === id && item.phase === 'added');
			if (!receipt) throw new Error('The addition is unavailable');
			const scope = await this.resolve(projectId, receipt.target);
			if (scope.path !== receipt.root) throw new Error('Repo changed');
			receipt.phase = 'undoing';
			await this.save(path, doc);
			try {
				await replaceKnowledgeFile(scope.path, receipt.target.path, receipt.after, receipt.before);
			} catch (error) {
				receipt.phase = 'added';
				await this.save(path, doc);
				throw error;
			}
			receipt.phase = 'undone';
			const proposal = doc.proposals.find((item) => item.signature === receipt.signature);
			if (proposal) proposal.state = 'proposed';
			await this.save(path, doc);
		});
	}
	dismiss(projectId: string, id: string) {
		return this.serial(projectId, async () => {
			const { doc, path } = await this.load(projectId),
				receipt = doc.receipts.find((item) => item.id === id && item.phase === 'added');
			if (receipt) {
				receipt.phase = 'dismissed';
				await this.save(path, doc);
			}
		});
	}
	async file(projectId: string, target: KnowledgeTarget) {
		const scope = await this.resolve(projectId, target);
		return {
			path: await projectFile(scope.path, target.path),
			text: await readKnowledgeFile(scope.path, target.path),
		};
	}
}
