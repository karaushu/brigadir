import { isId, isRecord } from './workspace';

/**
 * spec/design-review: a screen checked against its Figma design node by node — the contract an agent files with
 * `submit_design_review`, the screenshots the host keeps, and what the host verifies by itself.
 */
export const designLimits = {
	nodes: 24,
	rowsPerNode: 40,
	rows: 200,
	imageBytes: 10 * 1024 * 1024,
	shotsKept: 200,
	reviewsKept: 50,
	links: 20,
	fetchMs: 10_000,
} as const;

/** Where something is on a screenshot, as fractions (0–1) of its width and height. */
export type DesignArea = { x: number; y: number; width: number; height: number };
export type DesignRow = {
	property: string;
	expected: string;
	actual: string;
	match: boolean;
	area?: DesignArea;
};
/** spec/design-review#verify: `ok` — both images and a screenshot taken after the last change; anything else refuses the node's rows. */
export type DesignNodeState = 'ok' | 'no-figma' | 'no-shot' | 'old-shot';
export type DesignShotRef = { id: string; file: string; at: string; device?: string };
export type DesignNode = {
	name: string;
	figma: string;
	/** The design image copied into the task's folder, relative to it (`design/<id>/figma-1.png`). */
	figmaFile?: string;
	shot?: DesignShotRef;
	area?: DesignArea;
	state: DesignNodeState;
	reason?: string;
	rows: DesignRow[];
};
export type DesignReviewState = 'passed' | 'mismatch' | 'refused';
export type DesignVerdict = 'passed' | 'mismatch';
export type DesignTree = { scopeId: string; tree: string };
/** One design review as `design/design-reviews.json` keeps it; the journal's `design.reviewed` is the same without `trees` and `at`. */
export type DesignReview = {
	id: string;
	screen: string;
	at: string;
	state: DesignReviewState;
	verdict: DesignVerdict;
	reviewId?: string;
	trees: DesignTree[];
	nodes: DesignNode[];
};
export type DesignReviewsDocument = { schemaVersion: 1; reviews: DesignReview[] };
export const emptyDesignReviews: DesignReviewsDocument = { schemaVersion: 1, reviews: [] };
/** spec/design-review#shots: a screenshot a task's own tool took, with the trees of the task's files just before it. */
export type DesignShot = {
	id: string;
	file: string;
	tool: 'simulator' | 'browser';
	device?: string;
	at: string;
	trees: DesignTree[];
	/** A design review named it: its card keeps the image (spec/design-review#shots). */
	kept?: boolean;
};
export type DesignShotsDocument = { schemaVersion: 1; next: number; shots: DesignShot[] };
export const emptyDesignShots: DesignShotsDocument = { schemaVersion: 1, next: 1, shots: [] };

const isText = (value: unknown, max: number) =>
	typeof value === 'string' && value.length >= 1 && value.length <= max;
const fraction = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export function isDesignArea(value: unknown): value is DesignArea {
	return (
		isRecord(value) &&
		fraction(value.x) &&
		fraction(value.y) &&
		fraction(value.width) &&
		fraction(value.height)
	);
}
export function isDesignRow(value: unknown): value is DesignRow {
	return (
		isRecord(value) &&
		isText(value.property, 80) &&
		isText(value.expected, 200) &&
		isText(value.actual, 200) &&
		typeof value.match === 'boolean' &&
		(value.area === undefined || isDesignArea(value.area))
	);
}
export const designNodeStates: readonly DesignNodeState[] = [
	'ok',
	'no-figma',
	'no-shot',
	'old-shot',
];
export const isShotId = (value: unknown): value is string =>
	typeof value === 'string' && /^s[1-9][0-9]{0,8}$/.test(value);
/** A file of the task's folder the window may show: a kept screenshot or a copied design image. */
export const isDesignFile = (value: unknown): value is string =>
	typeof value === 'string' &&
	(/^shots\/s[1-9][0-9]{0,8}\.(jpg|png|webp)$/.test(value) ||
		/^design\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/figma-[1-9][0-9]?\.(jpg|png|webp)$/.test(value));
function isShotRef(value: unknown): value is DesignShotRef {
	return (
		isRecord(value) &&
		isShotId(value.id) &&
		isDesignFile(value.file) &&
		typeof value.at === 'string' &&
		(value.device === undefined || isText(value.device, 200))
	);
}
export function isDesignNode(value: unknown): value is DesignNode {
	return (
		isRecord(value) &&
		isText(value.name, 80) &&
		isText(value.figma, 500) &&
		(value.figmaFile === undefined || isDesignFile(value.figmaFile)) &&
		(value.shot === undefined || isShotRef(value.shot)) &&
		(value.area === undefined || isDesignArea(value.area)) &&
		designNodeStates.includes(value.state as DesignNodeState) &&
		(value.reason === undefined || typeof value.reason === 'string') &&
		Array.isArray(value.rows) &&
		value.rows.length >= 1 &&
		value.rows.length <= designLimits.rowsPerNode &&
		value.rows.every(isDesignRow)
	);
}
export const isDesignReviewState = (value: unknown): value is DesignReviewState =>
	value === 'passed' || value === 'mismatch' || value === 'refused';
export const isDesignVerdict = (value: unknown): value is DesignVerdict =>
	value === 'passed' || value === 'mismatch';
const isTree = (value: unknown): value is DesignTree =>
	isRecord(value) && typeof value.scopeId === 'string' && typeof value.tree === 'string';
export function isDesignReview(value: unknown): value is DesignReview {
	return (
		isRecord(value) &&
		isId(value.id) &&
		isText(value.screen, 80) &&
		typeof value.at === 'string' &&
		isDesignReviewState(value.state) &&
		isDesignVerdict(value.verdict) &&
		(value.reviewId === undefined || isId(value.reviewId)) &&
		Array.isArray(value.trees) &&
		value.trees.every(isTree) &&
		Array.isArray(value.nodes) &&
		value.nodes.length >= 1 &&
		value.nodes.length <= designLimits.nodes &&
		value.nodes.every(isDesignNode)
	);
}
/** An entry that does not validate is dropped; the others stay. */
export function readDesignReviews(value: unknown): DesignReviewsDocument {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.reviews))
		return emptyDesignReviews;
	return { schemaVersion: 1, reviews: value.reviews.filter(isDesignReview) };
}
function isShot(value: unknown): value is DesignShot {
	return (
		isRecord(value) &&
		isShotId(value.id) &&
		isDesignFile(value.file) &&
		(value.tool === 'simulator' || value.tool === 'browser') &&
		(value.device === undefined || isText(value.device, 200)) &&
		typeof value.at === 'string' &&
		Array.isArray(value.trees) &&
		value.trees.every(isTree) &&
		(value.kept === undefined || typeof value.kept === 'boolean')
	);
}
export function readDesignShots(value: unknown): DesignShotsDocument {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.shots))
		return emptyDesignShots;
	const shots = value.shots.filter(isShot);
	const top = shots.reduce((max, shot) => Math.max(max, Number(shot.id.slice(1))), 0);
	const next = Number.isSafeInteger(value.next) ? Math.max(Number(value.next), top + 1) : top + 1;
	return { schemaVersion: 1, next, shots };
}

/** spec/design-review#verify: the state of the whole screen from its nodes. */
export function designReviewState(nodes: readonly Pick<DesignNode, 'state' | 'rows'>[]) {
	if (nodes.some((node) => node.state !== 'ok')) return 'refused' as const;
	return nodes.every((node) => node.rows.every((row) => row.match))
		? ('passed' as const)
		: ('mismatch' as const);
}
/** The counts of the card's foot (spec/design-review#card). */
export function designCounts(nodes: readonly Pick<DesignNode, 'state' | 'rows'>[]) {
	const counts = { rows: 0, match: 0, mismatch: 0, old: 0, noShot: 0, noFigma: 0, shots: 0 };
	for (const node of nodes) {
		counts.rows += node.rows.length;
		if (node.state === 'ok') {
			counts.shots++;
			for (const row of node.rows) row.match ? counts.match++ : counts.mismatch++;
		} else if (node.state === 'old-shot') counts.old += node.rows.length;
		else if (node.state === 'no-shot') counts.noShot += node.rows.length;
		else counts.noFigma += node.rows.length;
	}
	return { ...counts, notAccepted: counts.old + counts.noShot + counts.noFigma };
}
/** spec/design-review#flow: a design review covers a round when every tree the round reads is among the trees it was filed on. */
export function designCovers(
	filed: readonly DesignTree[],
	round: readonly { tree: string }[]
): boolean {
	if (!round.length) return false;
	const trees = new Set(filed.map((item) => item.tree));
	return round.every((item) => trees.has(item.tree));
}

/** spec/design-review#design-source: Figma addresses of designs, prototypes and files in a text, at most 20, each once. */
export function figmaLinks(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(
		/https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/[A-Za-z0-9]+[^\s<>()"'`\]]*/g
	)) {
		found.add(match[0].replace(/[.,;:!?]+$/, ''));
		if (found.size >= designLimits.links) break;
	}
	return [...found];
}
/** `node-id=412-88` (or `412%3A88`) of a Figma address as Figma writes a node id, `412:88`. */
export function figmaNodeId(link: string): string | null {
	const match = /[?&]node-id=([0-9]+)(?:-|%3A|:)([0-9]+)/i.exec(link);
	return match ? `${match[1]}:${match[2]}` : null;
}
/** The short id the card shows for a node's `figma` reference: the address's node id, else the reference itself. */
export function designNodeLabel(figma: string): string {
	return figmaNodeId(figma) ?? figma;
}

/** spec/design-review#prompt: how the checking agent works, in the tool's description and the reviewer's design paragraph (rule 12). */
export const designCheckPrompt =
	"Check the screen against its design node by node, in the running app. A node is a part of the design such as a header, a list row, a tab bar or a button, never the whole screen at once. For each node: open it in Figma and save its image to a file (your Figma tool's export or download, or the image address it gives); open the screen on the device and take simulator_screenshot (browser_screenshot for a web page) after your last change; read the values from the design and from the app (sizes and positions from simulator_ui or browser_ui), and fill one row per property: size, padding and gaps, corner radius, border, shadow, colour or token, typography, each icon and its size, and the states the design draws. Icons, paddings, radii, borders and shadows are rows. A row's on-device value comes from the screenshot or the UI tree, never from the code. Then call submit_design_review with every node.";
