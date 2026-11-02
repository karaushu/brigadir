/**
 * spec/git#commit-dialog: the commit dialog's baskets. A basket is one future commit of one repo: its message and whole files.
 * Every file of a repo is in exactly one basket of that repo; a basket never takes a file of another repo. The order of
 * the array is the order of the commits: repos as the preview lists them (deepest first, a submodule before its parent),
 * baskets of a repo in their own order. Pure functions: the renderer keeps the state, main commits the plan.
 */
import type { CommitPreview, CommitSplitProposal } from './commits';
export type CommitBasket = {
	id: string;
	scopeId: string;
	message: string;
	files: string[];
	/** The agent's short reason for this basket (spec/git#commit-dialog); gone after the person's first change of the basket. */
	reason?: string | undefined;
};
/** A repo of the preview: its id, name and changed files, in the preview's order. */
export type BasketScope = { id: string; name: string; files: string[] };
export function basketScopes(preview: CommitPreview): BasketScope[] {
	return preview.scopes.map((item) => ({
		id: item.scope.id,
		name: item.scope.name,
		files: item.files.map((file) => file.path),
	}));
}
let sequence = 0;
/** A basket id: unique in a window's life, valid for `isCommitBasketId`. */
export function newBasketId(): string {
	sequence += 1;
	return `b${Date.now().toString(36)}-${sequence.toString(36)}`;
}
/** Repos in the preview's order, baskets of a repo keeping theirs. */
function ordered(baskets: CommitBasket[], scopes: BasketScope[]): CommitBasket[] {
	const index = new Map(scopes.map((scope, i) => [scope.id, i]));
	return baskets
		.map((basket, i) => ({ basket, i }))
		.sort(
			(a, b) =>
				(index.get(a.basket.scopeId) ?? 1e9) - (index.get(b.basket.scopeId) ?? 1e9) || a.i - b.i
		)
		.map((item) => item.basket);
}
/** The first opening: one basket per repo with all its files; the first one's message is the strip's. */
export function initialBaskets(
	scopes: BasketScope[],
	message: string,
	newId: () => string = newBasketId
): CommitBasket[] {
	return scopes
		.filter((scope) => scope.files.length)
		.map((scope, i) => ({
			id: newId(),
			scopeId: scope.id,
			message: i === 0 ? message : '',
			files: [...scope.files],
		}));
}
/**
 * The preview was read again: files gone from git status leave their baskets, new files go to the first basket of
 * their repo (a new basket when the repo has none), baskets of a repo with nothing left to commit go. Empty baskets
 * the person made stay while their repo has changes.
 */
export function reconcileBaskets(
	baskets: CommitBasket[],
	scopes: BasketScope[],
	newId: () => string = newBasketId,
	/** Files the person took out of every basket («not in a commit», `fileKey`): they stay out. */
	aside: ReadonlySet<string> = new Set()
): CommitBasket[] {
	const live = new Map(scopes.map((scope) => [scope.id, new Set(scope.files)]));
	let next = baskets
		.filter((basket) => live.get(basket.scopeId)?.size)
		.map((basket) => {
			const files = basket.files.filter((path) => live.get(basket.scopeId)!.has(path));
			return files.length === basket.files.length ? basket : { ...basket, files };
		});
	for (const scope of scopes) {
		const placed = new Set(
			next.filter((basket) => basket.scopeId === scope.id).flatMap((basket) => basket.files)
		);
		const loose = scope.files.filter(
			(path) => !placed.has(path) && !aside.has(fileKey(scope.id, path))
		);
		if (!loose.length) continue;
		const first = next.find((basket) => basket.scopeId === scope.id);
		next = first
			? next.map((basket) =>
					basket === first ? { ...basket, files: [...basket.files, ...loose] } : basket
				)
			: [...next, { id: newId(), scopeId: scope.id, message: '', files: loose }];
	}
	const changed = next.length !== baskets.length || next.some((basket, i) => basket !== baskets[i]);
	return changed ? ordered(next, scopes) : baskets;
}
/** `C1…Cn` across repos, in commit order. */
export function basketLabels(baskets: CommitBasket[]): Map<string, string> {
	return new Map(baskets.map((basket, i) => [basket.id, `C${i + 1}`]));
}
export function basketOf(
	baskets: CommitBasket[],
	scopeId: string,
	path: string
): CommitBasket | undefined {
	return baskets.find((basket) => basket.scopeId === scopeId && basket.files.includes(path));
}
export type BasketFile = { scopeId: string; path: string };
/** One key for a file of a repo, for sets of selected or set-aside files. */
export function fileKey(scopeId: string, path: string): string {
	return `${scopeId}\0${path}`;
}
/** × on a chip: the files leave their baskets and stay out of the commits («not in a commit»). */
export function takeOut(baskets: CommitBasket[], files: BasketFile[]): CommitBasket[] {
	const keys = new Set(files.map((file) => fileKey(file.scopeId, file.path)));
	return baskets.map((basket) => {
		if (!basket.files.some((path) => keys.has(fileKey(basket.scopeId, path)))) return basket;
		const { reason: _reason, ...rest } = basket;
		return {
			...rest,
			files: basket.files.filter((path) => !keys.has(fileKey(basket.scopeId, path))),
		};
	});
}
/**
 * Moves files into `target` (a basket id, or `{ newIn }` — a new basket of that repo after its last one). A file of
 * another repo is refused: commits never cross repos. The moved files lose the agent's reason of both baskets.
 */
export function moveFiles(
	baskets: CommitBasket[],
	files: BasketFile[],
	target: string | { newIn: string },
	newId: () => string = newBasketId
): { baskets: CommitBasket[]; moved: number; refused: number; target: string | null } {
	let next = baskets,
		targetId = typeof target === 'string' ? target : null;
	const scopeId =
		typeof target === 'string'
			? baskets.find((basket) => basket.id === target)?.scopeId
			: target.newIn;
	if (!scopeId) return { baskets, moved: 0, refused: files.length, target: null };
	const own = files.filter((file) => file.scopeId === scopeId),
		paths = new Set(own.map((file) => file.path)),
		refused = files.length - own.length;
	if (!targetId) {
		targetId = newId();
		const last = next.findLastIndex((basket) => basket.scopeId === scopeId);
		const fresh: CommitBasket = { id: targetId, scopeId, message: '', files: [] };
		next =
			last < 0 ? [...next, fresh] : [...next.slice(0, last + 1), fresh, ...next.slice(last + 1)];
	}
	// A file of another basket of the repo, or one set aside; a file already in the target does not move.
	const inTarget = new Set(next.find((basket) => basket.id === targetId)?.files ?? []);
	const moving = new Set([...paths].filter((path) => !inTarget.has(path)));
	if (!moving.size)
		return typeof target === 'string'
			? { baskets, moved: 0, refused, target: targetId }
			: { baskets: next, moved: 0, refused, target: targetId };
	next = next.map((basket) => {
		if (basket.scopeId !== scopeId) return basket;
		if (basket.id === targetId) {
			const { reason: _reason, ...rest } = basket;
			return {
				...rest,
				files: [...basket.files, ...[...moving].filter((p) => !basket.files.includes(p))],
			};
		}
		if (!basket.files.some((path) => moving.has(path))) return basket;
		const { reason: _reason, ...rest } = basket;
		return { ...rest, files: basket.files.filter((path) => !moving.has(path)) };
	});
	return { baskets: next, moved: moving.size, refused, target: targetId };
}
/** «+ New commit»: an empty basket after the repo's last one. */
export function addBasket(
	baskets: CommitBasket[],
	scopeId: string,
	newId: () => string = newBasketId
): CommitBasket[] {
	return moveFiles(baskets, [], { newIn: scopeId }, newId).baskets;
}
/** Only an empty basket goes; a basket with files keeps them (move them first). */
export function removeBasket(baskets: CommitBasket[], id: string): CommitBasket[] {
	const basket = baskets.find((item) => item.id === id);
	return basket && !basket.files.length ? baskets.filter((item) => item !== basket) : baskets;
}
export function setBasketMessage(
	baskets: CommitBasket[],
	id: string,
	message: string
): CommitBasket[] {
	return baskets.map((basket) => (basket.id === id ? { ...basket, message } : basket));
}
/** What `Commit N` commits: the non-empty baskets in order; empty ones are skipped with a note. */
export function commitPlan(baskets: CommitBasket[]) {
	return {
		plan: baskets.filter((basket) => basket.files.length),
		skipped: baskets.filter((basket) => !basket.files.length),
		missing: baskets.filter((basket) => basket.files.length && !basket.message.trim()),
	};
}
/** After a run: the committed baskets go, the rest stay for «Retry». */
export function dropCommitted(baskets: CommitBasket[], done: ReadonlySet<string>): CommitBasket[] {
	return baskets.filter((basket) => !done.has(basket.id));
}
/**
 * The agent's proposal replaces the baskets of the repos it names. Each file counts once and only in its own repo; an
 * unknown path is ignored; files of the repo it did not name go to its last proposed basket of that repo. A repo the
 * agent did not name keeps the person's baskets. Empty proposed baskets are dropped.
 */
export function applyProposal(
	baskets: CommitBasket[],
	scopes: BasketScope[],
	proposal: CommitSplitProposal,
	newId: () => string = newBasketId
): CommitBasket[] {
	const files = new Map(scopes.map((scope) => [scope.id, new Set(scope.files)]));
	const used = new Map<string, Set<string>>();
	const proposed: CommitBasket[] = [];
	for (const item of proposal) {
		const own = files.get(item.scopeId);
		if (!own) continue;
		const taken = used.get(item.scopeId) ?? new Set<string>();
		used.set(item.scopeId, taken);
		const paths = item.files.filter((path) => own.has(path) && !taken.has(path));
		for (const path of paths) taken.add(path);
		if (!paths.length) continue;
		proposed.push({
			id: newId(),
			scopeId: item.scopeId,
			message: item.message.trim(),
			files: paths,
			...(item.reason.trim() ? { reason: item.reason.trim() } : {}),
		});
	}
	const named = new Set(proposed.map((basket) => basket.scopeId));
	if (!named.size) return baskets;
	for (const scopeId of named) {
		const taken = used.get(scopeId)!,
			loose = [...files.get(scopeId)!].filter((path) => !taken.has(path));
		if (!loose.length) continue;
		const last = proposed.findLast((basket) => basket.scopeId === scopeId)!;
		last.files = [...last.files, ...loose];
	}
	return ordered([...baskets.filter((basket) => !named.has(basket.scopeId)), ...proposed], scopes);
}
