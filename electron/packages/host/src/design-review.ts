import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
	designCheckPrompt,
	designCounts,
	designCovers,
	designLimits,
	designNodeLabel,
	designReviewState,
	isDesignArea,
	isRecord,
	isShotId,
	readDesignReviews,
	readDesignShots,
	type DesignArea,
	type DesignNode,
	type DesignReview,
	type DesignRow,
	type DesignShot,
	type DesignTree,
	type SessionEvent,
	type TaskKey,
} from '@brigadir/core';
import {
	atomicJson,
	atomicText,
	readDocument,
	safePath,
	type SessionStore,
} from '@brigadir/persistence';

/**
 * spec/design-review: the screenshots a task's own tools took (`shots/`), the design reviews it filed (`design/`), what the host verifies of
 * each node by itself, and the gate a review puts on its reviewer's approval.
 */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: TaskKey, work: () => Promise<T>): Promise<T> {
	const id = `${key.projectId}/${key.id}`,
		result = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
	queues.set(id, result);
	return result;
}
async function shotsFile(store: SessionStore, key: TaskKey) {
	return safePath(await store.taskDir(key), 'shots', 'shots.json');
}
async function reviewsFile(store: SessionStore, key: TaskKey) {
	return safePath(await store.taskDir(key), 'design', 'design-reviews.json');
}
export async function readShots(store: SessionStore, key: TaskKey) {
	try {
		return readDesignShots(await readDocument(await shotsFile(store, key)));
	} catch {
		return readDesignShots(null);
	}
}
export async function readDesignReviewsOf(store: SessionStore, key: TaskKey) {
	try {
		return readDesignReviews(await readDocument(await reviewsFile(store, key), 16 * 1024 * 1024))
			.reviews;
	} catch {
		return [];
	}
}
const shotExtension = (mimeType: string) =>
	mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
/** spec/design-review#shots: keeps a screenshot the task's own tool returned, with the trees of the task's files taken just before it. */
export function saveShot(
	store: SessionStore,
	key: TaskKey,
	shot: {
		data: string;
		mimeType: string;
		tool: 'simulator' | 'browser';
		device?: string;
		trees: DesignTree[];
	}
): Promise<DesignShot> {
	return serial(key, async () => {
		const doc = await readShots(store, key),
			id = `s${doc.next}`,
			file = `shots/${id}.${shotExtension(shot.mimeType)}`,
			dir = await safePath(await store.taskDir(key), 'shots');
		await mkdir(dir, { recursive: true });
		await atomicText(
			await safePath(await store.taskDir(key), file),
			Buffer.from(shot.data, 'base64')
		);
		const entry: DesignShot = {
			id,
			file,
			tool: shot.tool,
			...(shot.device ? { device: shot.device.slice(0, 200) } : {}),
			at: new Date().toISOString(),
			trees: shot.trees.map(({ scopeId, tree }) => ({ scopeId, tree })),
		};
		let shots = [...doc.shots, entry];
		// The last 200 stay; an older shot's file goes unless a design review names it.
		if (shots.length > designLimits.shotsKept) {
			const named = new Set(
				(await readDesignReviewsOf(store, key)).flatMap((review) =>
					review.nodes.flatMap((node) => (node.shot ? [node.shot.id] : []))
				)
			);
			const drop = shots.slice(0, shots.length - designLimits.shotsKept);
			shots = shots.slice(-designLimits.shotsKept);
			for (const old of drop)
				if (named.has(old.id)) shots.unshift(old);
				else await rm(await safePath(await store.taskDir(key), old.file), { force: true });
		}
		await atomicJson(await shotsFile(store, key), {
			schemaVersion: 1,
			next: doc.next + 1,
			shots,
		});
		return entry;
	});
}

/** PNG, JPEG or WebP by its first bytes; the extension the copy gets. */
export function imageKind(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
		return 'png';
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
	if (
		Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'RIFF' &&
		Buffer.from(bytes.subarray(8, 12)).toString('latin1') === 'WEBP'
	)
		return 'webp';
	return null;
}
/** spec/design-review#verify: the node's design image — an absolute path or an http(s) address; a reason when it cannot be read. */
export async function readDesignImage(
	source: string,
	fetcher: typeof fetch = fetch
): Promise<{ bytes: Uint8Array; kind: 'png' | 'jpg' | 'webp' } | { reason: string }> {
	let bytes: Uint8Array;
	if (/^https?:\/\//i.test(source)) {
		try {
			const response = await fetcher(source, {
				signal: AbortSignal.timeout(designLimits.fetchMs),
				redirect: 'follow',
			});
			if (!response.ok) return { reason: `the address answered ${response.status}` };
			const length = Number(response.headers.get('content-length') ?? 0);
			if (length > designLimits.imageBytes) return { reason: 'it is larger than 10 MB' };
			bytes = new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			return {
				reason: `the address did not answer (${error instanceof Error ? error.message : 'error'})`,
			};
		}
	} else {
		if (!isAbsolute(source)) return { reason: 'the path is not absolute' };
		try {
			const info = await lstat(source);
			if (!info.isFile()) return { reason: 'it is not a file' };
			if (info.size > designLimits.imageBytes) return { reason: 'it is larger than 10 MB' };
			const handle = await open(source, 'r');
			try {
				bytes = new Uint8Array(await handle.readFile());
			} finally {
				await handle.close();
			}
		} catch {
			return { reason: 'no such file' };
		}
	}
	if (bytes.length > designLimits.imageBytes) return { reason: 'it is larger than 10 MB' };
	const kind = imageKind(bytes);
	return kind ? { bytes, kind } : { reason: 'it is not a PNG, JPEG or WebP image' };
}

const sameTrees = (a: readonly DesignTree[], b: readonly DesignTree[]) =>
	a.length === b.length &&
	b.every((tree) => a.some((item) => item.scopeId === tree.scopeId && item.tree === tree.tree));
const text = (value: unknown, max: number) =>
	typeof value === 'string' ? value.trim().slice(0, max) : '';
type NodeInput = {
	name: string;
	figma: string;
	figmaImage: string;
	shot: string;
	area?: DesignArea;
	rows: DesignRow[];
};
/** The tool's input, re-checked by the host (the MCP schema already shaped it). */
export function checkDesignInput(input: Record<string, unknown>) {
	const screen = text(input.screen, 80);
	if (!screen) throw new Error('screen is required');
	if (input.verdict !== 'passed' && input.verdict !== 'mismatch')
		throw new Error('verdict is passed or mismatch');
	const raw = Array.isArray(input.nodes) ? input.nodes : [];
	if (!raw.length || raw.length > designLimits.nodes)
		throw new Error(`nodes: 1 to ${designLimits.nodes} design nodes`);
	let total = 0;
	const nodes: NodeInput[] = raw.map((item, index) => {
		if (!isRecord(item)) throw new Error(`nodes[${index}] is not a node`);
		const name = text(item.name, 80),
			figma = text(item.figma, 500),
			figmaImage = text(item.figmaImage, 8192),
			shot = text(item.shot, 20);
		if (!name || !figma) throw new Error(`nodes[${index}]: name and figma are required`);
		const rows = (Array.isArray(item.rows) ? item.rows : []).map((row, at) => {
			if (!isRecord(row) || typeof row.match !== 'boolean')
				throw new Error(`${name}: rows[${at}] needs property, expected, actual and match`);
			const checked: DesignRow = {
				property: text(row.property, 80),
				expected: text(row.expected, 200),
				actual: text(row.actual, 200),
				match: row.match,
				...(isDesignArea(row.area) ? { area: row.area } : {}),
			};
			if (!checked.property || !checked.expected || !checked.actual)
				throw new Error(`${name}: rows[${at}] needs property, expected, actual and match`);
			return checked;
		});
		if (!rows.length || rows.length > designLimits.rowsPerNode)
			throw new Error(`${name}: 1 to ${designLimits.rowsPerNode} rows`);
		total += rows.length;
		return {
			name,
			figma,
			figmaImage,
			shot,
			...(isDesignArea(item.area) ? { area: item.area } : {}),
			rows,
		};
	});
	if (total > designLimits.rows) throw new Error(`At most ${designLimits.rows} rows in all`);
	const reviewId =
		typeof input.reviewId === 'string' && input.reviewId.trim() ? input.reviewId.trim() : undefined;
	return { screen, verdict: input.verdict, nodes, ...(reviewId ? { reviewId } : {}) } as const;
}

export type DesignReviewDeps = {
	store: SessionStore;
	key: TaskKey;
	/** A checkpoint of the task's files now, and its trees. */
	trees(): Promise<DesignTree[]>;
	emit(event: SessionEvent): Promise<void>;
	fetch?: typeof fetch;
};
/** spec/design-review#tool, spec/design-review#verify: checks every node by itself, keeps the design review and tells the agent what to redo. */
export function submitDesignReview(deps: DesignReviewDeps, input: Record<string, unknown>) {
	const checked = checkDesignInput(input);
	if (
		checked.verdict === 'mismatch' &&
		checked.nodes.every((node) => node.rows.every((row) => row.match))
	)
		throw new Error('Every row matches: mark the row that does not, or send verdict passed.');
	return serial(deps.key, async () => {
		const now = await deps.trees(),
			shots = await readShots(deps.store, deps.key),
			id = randomUUID(),
			dir = await deps.store.taskDir(deps.key);
		const nodes: DesignNode[] = [];
		for (const [index, node] of checked.nodes.entries()) {
			const base = {
				name: node.name,
				figma: node.figma,
				...(node.area ? { area: node.area } : {}),
				rows: node.rows,
			};
			const shot = isShotId(node.shot) ? shots.shots.find((item) => item.id === node.shot) : null;
			const shotRef = shot
				? {
						id: shot.id,
						file: shot.file,
						at: shot.at,
						...(shot.device ? { device: shot.device } : {}),
					}
				: null;
			const image = node.figmaImage
				? await readDesignImage(node.figmaImage, deps.fetch)
				: { reason: 'figmaImage is missing' };
			let figmaFile: string | undefined;
			if ('bytes' in image) {
				figmaFile = `design/${id}/figma-${index + 1}.${image.kind}`;
				await mkdir(await safePath(dir, 'design', id), { recursive: true });
				await atomicText(await safePath(dir, figmaFile), image.bytes);
			}
			const shotThere =
				shot &&
				(await lstat(join(dir, shot.file)).then(
					(info) => info.isFile(),
					() => false
				));
			const state: DesignNode['state'] = !figmaFile
				? 'no-figma'
				: !shot || !shotThere
					? 'no-shot'
					: !sameTrees(shot.trees, now)
						? 'old-shot'
						: 'ok';
			const reason =
				state === 'no-figma'
					? `The design image could not be read (${'reason' in image ? image.reason : ''}). Save the node's image from Figma to a file.`
					: state === 'no-shot'
						? `${node.shot || 'shot'} is not a screenshot of this task. Take one with simulator_screenshot or browser_screenshot.`
						: state === 'old-shot'
							? `${node.shot} was taken before the files changed. Take a new screenshot of this node and submit the screen again.`
							: undefined;
			nodes.push({
				...base,
				...(figmaFile ? { figmaFile } : {}),
				...(shotRef && shotThere ? { shot: shotRef } : {}),
				state,
				...(reason ? { reason } : {}),
			});
		}
		const state = designReviewState(nodes);
		const review: DesignReview = {
			id,
			screen: checked.screen,
			at: new Date().toISOString(),
			state,
			verdict: checked.verdict,
			...(checked.reviewId ? { reviewId: checked.reviewId } : {}),
			trees: now.map(({ scopeId, tree }) => ({ scopeId, tree })),
			nodes,
		};
		const reviews = [...(await readDesignReviewsOf(deps.store, deps.key)), review].slice(
			-designLimits.reviewsKept
		);
		await mkdir(await safePath(dir, 'design'), { recursive: true });
		await atomicJson(await reviewsFile(deps.store, deps.key), { schemaVersion: 1, reviews });
		await deps.emit({
			kind: 'design.reviewed',
			id,
			screen: review.screen,
			state,
			verdict: review.verdict,
			...(review.reviewId ? { reviewId: review.reviewId } : {}),
			nodes,
		});
		return designAnswer(review);
	});
}
/** spec/design-review#answer */
export function designAnswer(review: DesignReview) {
	const counts = designCounts(review.nodes);
	const redo = review.nodes
		.filter((node) => node.state !== 'ok')
		.map((node) => ({ node: node.name, state: node.state, reason: node.reason ?? '' }));
	const mismatches = review.nodes.flatMap((node) =>
		node.state === 'ok'
			? node.rows
					.filter((row) => !row.match)
					.map((row) => ({
						node: node.name,
						property: row.property,
						expected: row.expected,
						actual: row.actual,
					}))
			: []
	);
	const lines = redo.map((item) => `${item.node}: ${item.reason}`);
	if (review.verdict === 'passed' && review.state !== 'passed')
		lines.unshift('The verdict passed is not accepted: not every node is verified and matching.');
	if (mismatches.length)
		lines.push(
			'Fix the mismatches, take new screenshots of those nodes and submit the screen again.'
		);
	if (review.state === 'passed') lines.push('The design review passed.');
	return {
		id: review.id,
		state: review.state,
		accepted: counts.rows - counts.notAccepted,
		notAccepted: counts.notAccepted,
		redo,
		mismatches,
		next: lines.join('\n'),
	};
}

/** The newest design review of each screen, newest first. */
export function latestPerScreen(reviews: readonly DesignReview[]) {
	const seen = new Set<string>(),
		latest: DesignReview[] = [];
	for (const review of [...reviews].reverse()) {
		const screen = review.screen.toLowerCase();
		if (seen.has(screen)) continue;
		seen.add(screen);
		latest.push(review);
	}
	return latest;
}
export type DesignGateInput = {
	/** spec/design-review#design-source: the task's Figma links. */
	links: readonly string[];
	/** The task's own design reviews. */
	own: readonly DesignReview[];
	/** The ones this reviewer filed with this reviewId. */
	reviewer: readonly DesignReview[];
	/** The trees the round reads. */
	round: readonly { tree: string }[];
	/** The task's folder, for the image paths the reviewer opens. */
	taskDir: string;
	reviewerDir?: string;
};
/** spec/design-review#design-source: a task with a Figma link, or one that filed a design review. */
export const designRequired = (input: Pick<DesignGateInput, 'links' | 'own' | 'reviewer'>) =>
	input.links.length > 0 || input.own.length > 0 || input.reviewer.length > 0;
/** spec/reviews#design: a passed design review that covers the round lets the reviewer approve. */
export function designCovered(input: DesignGateInput) {
	return [...input.own, ...input.reviewer].some(
		(review) => review.state === 'passed' && designCovers(review.trees, input.round)
	);
}
function describe(review: DesignReview, round: DesignGateInput['round'], dir: string) {
	const covers = designCovers(review.trees, round);
	const head = `- ${review.screen}: ${review.state}${covers ? '' : ', filed on another state of the files'}`;
	const nodes = review.nodes.map((node) => {
		const images = [
			node.figmaFile ? `design ${join(dir, node.figmaFile)}` : null,
			node.shot ? `device ${join(dir, node.shot.file)}` : null,
		]
			.filter(Boolean)
			.join(', ');
		const rows = node.rows
			.map(
				(row) =>
					`    ${row.match ? 'ok' : 'MISMATCH'} ${row.property}: expected ${row.expected}, on device ${row.actual}`
			)
			.join('\n');
		return `  ${node.name} (${designNodeLabel(node.figma)}) — ${node.state}${images ? `; ${images}` : ''}\n${rows}`;
	});
	return [head, ...nodes].join('\n');
}
/** spec/reviews#design: the reviewer's design paragraph — the links, the latest design review per screen with its images, the prompt. */
export function designPrompt(input: DesignGateInput) {
	if (!designRequired(input)) return '';
	const own = latestPerScreen(input.own).map((review) =>
		describe(review, input.round, input.taskDir)
	);
	return [
		'\n\nThis task has a design source, so its screens are checked node by node against it (a design review).',
		input.links.length ? `Design links: ${input.links.join(' ')}` : '',
		own.length
			? `The task's design reviews, the newest per screen (open the image files to compare them):\n${own.join('\n')}`
			: 'The task has filed no design review.',
		'You may approve only when a passed design review covers the state you read. Otherwise leave a finding for each mismatched node at the line that sets the property ("<node> · <property>: expected …, on device …"), and one finding at the screen\'s file when no design review covers this state, or check the screen yourself with submit_design_review passing this reviewId:',
		designCheckPrompt,
	]
		.filter(Boolean)
		.join('\n');
}
/** spec/reviews#design: why an approval is refused, or null when it may go. */
export function designGate(input: DesignGateInput, closure: boolean): string | null {
	if (!designRequired(input) || designCovered(input)) return null;
	const latest = latestPerScreen([...input.own, ...input.reviewer]);
	const state = latest.length
		? latest
				.map(
					(review) =>
						`${review.screen}: ${review.state}${designCovers(review.trees, input.round) ? '' : ' on another state of the files'}`
				)
				.join('; ')
		: 'no design review was filed';
	return `No approval from the code: this task has a design source, and no passed design review covers the state you read (${state}). ${
		closure
			? 'Keep the design finding open with submit_review {replyTo, text}, or check the screen yourself with submit_design_review passing this reviewId.'
			: "Leave a finding for each mismatched node at the line that sets the property, or one at the screen's file when no design review covers this state; or check the screen yourself with submit_design_review passing this reviewId."
	}`;
}
