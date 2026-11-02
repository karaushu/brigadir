import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Forge, detailQuery } from '@brigadir/forge';
import { SessionStore } from '@brigadir/persistence';
import { gitText, discoverScopes } from '@brigadir/git';
import { PullRequests } from './pull-requests';
import { Changes } from './changes';

/**
 * spec/pull-requests-and-ci#pr-files: a PR file waits for GitHub only once. The remote counts its `upload-pack` runs (one per `git fetch`); the `gh`
 * stub counts reads of the PR. The first file fetches the head and the base in one run; later files, a file after the
 * 20 s TTL or after «Viewed», and a new app with both commits already local fetch and read nothing.
 */
const roots: string[] = [];
const env = process.env.BRIGADIR_TEST_GH;
afterEach(async () => {
	vi.useRealTimers();
	if (env === undefined) delete process.env.BRIGADIR_TEST_GH;
	else process.env.BRIGADIR_TEST_GH = env;
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-pr-trees-'));
	roots.push(dir);
	const root = join(dir, 'repo'),
		remote = join(dir, 'remote.git'),
		log = join(dir, 'fetches.log');
	await mkdir(root);
	await mkdir(remote);
	await gitText(remote, ['init', '--bare', '-b', 'main']);
	const git = (...args: string[]) => gitText(root, args);
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
	await writeFile(join(root, 'b.ts'), 'export const b = 1;\n');
	await git('add', '.');
	await git('commit', '-m', 'Base');
	await git('remote', 'add', 'origin', remote);
	await git('push', 'origin', 'HEAD:refs/heads/staging');
	const base = await git('rev-parse', 'HEAD');
	await writeFile(join(root, 'a.ts'), 'export const a = 2;\n');
	await writeFile(join(root, 'b.ts'), 'export const b = 2;\n');
	await git('commit', '-am', 'Change');
	const head = await git('rev-parse', 'HEAD');
	await git('push', 'origin', 'HEAD:refs/pull/7/head');
	// The local clone has the base, not the head: the head commit is pruned, as in a clone that never fetched the PR.
	await git('reset', '--hard', base);
	await git('reflog', 'expire', '--expire=now', '--all');
	await git('gc', '--prune=now', '--quiet');
	await git('config', 'remote.origin.uploadpack', `echo fetch >> '${log}'; git-upload-pack`);
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(root);
	return {
		dir,
		root,
		log,
		base,
		head,
		project: project.id,
		fetches: async () =>
			(await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length,
	};
}
/** `hold` keeps a PR read until it resolves, with the node id that read answers (spec/pull-requests-and-ci#reading-and-refresh). */
function gh(
	head: string,
	base: string,
	hold?: () => Promise<string>,
	pr: Record<string, unknown> = {}
) {
	const calls: string[][] = [],
		files = [
			{ path: 'a.ts', viewed: false },
			{ path: 'b.ts', viewed: false },
		];
	const forge = new Forge(async (_, args) => {
		calls.push(args);
		if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
		if (args[0] === 'repo')
			return {
				code: 0,
				stdout: JSON.stringify({
					nameWithOwner: 'fixture/repo',
					url: 'https://github.com/fixture/repo',
					defaultBranchRef: { name: 'main' },
				}),
				stderr: '',
			};
		if (args.some((arg) => arg.startsWith('query=mutation')))
			return { code: 0, stdout: '{"data":{}}', stderr: '' };
		if (args.includes(`query=${detailQuery}`)) {
			const node = hold ? await hold() : 'PR_7';
			return {
				code: 0,
				stdout: JSON.stringify({
					data: {
						viewer: { login: 'me' },
						repository: {
							viewerPermission: 'WRITE',
							mergeCommitAllowed: true,
							squashMergeAllowed: true,
							rebaseMergeAllowed: true,
							viewerDefaultMergeMethod: 'MERGE',
							pullRequest: {
								id: node,
								number: 7,
								title: 'Change',
								url: 'https://github.com/fixture/repo/pull/7',
								state: 'OPEN',
								isDraft: false,
								author: { login: 'octo' },
								headRefName: 'feature',
								baseRefName: 'staging',
								updatedAt: new Date().toISOString(),
								closedAt: null,
								mergedAt: null,
								reviewDecision: null,
								totalCommentsCount: 0,
								reviewRequests: { nodes: [] },
								latestReviews: { nodes: [] },
								commits: { nodes: [] },
								body: '',
								createdAt: new Date().toISOString(),
								headRefOid: head,
								baseRefOid: base,
								additions: 2,
								deletions: 2,
								mergeStateStatus: 'CLEAN',
								mergeable: 'MERGEABLE',
								reviewThreads: { nodes: [] },
								comments: { nodes: [] },
								reviews: { nodes: [] },
								files: {
									nodes: files.map((file) => ({
										path: file.path,
										additions: 1,
										deletions: 1,
										changeType: 'MODIFIED',
										viewerViewedState: file.viewed ? 'VIEWED' : 'UNVIEWED',
									})),
								},
								allCommits: { nodes: [] },
								lastCommit: { nodes: [] },
								...pr,
							},
						},
					},
				}),
				stderr: '',
			};
		}
		return {
			code: 0,
			stdout: JSON.stringify({
				data: {
					viewer: { login: 'me' },
					repository: { open: { nodes: [] }, closed: { nodes: [] } },
				},
			}),
			stderr: '',
		};
	});
	return {
		forge,
		calls,
		reads: () => calls.filter((args) => args.includes(`query=${detailQuery}`)).length,
	};
}

it('fetches a PR once for both commits, then opens files without git fetch or a GitHub read, also after the TTL and in a new app (spec/pull-requests-and-ci#pr-files)', async () => {
	process.env.BRIGADIR_TEST_GH = '1';
	const repo = await fixture(),
		{ forge, reads } = gh(repo.head, repo.base),
		changes = new Changes(join(repo.dir, 'data'), join(__dirname, '../../out/services/diff.cjs'));
	const prs = new PullRequests(join(repo.dir, 'data'), forge, changes),
		scope = (await prs.scopes(repo.project, null))[0]!.id;
	await prs.detail(repo.project, null, scope, 7);
	expect(reads()).toBe(1);
	const first = await prs.fileDiff(repo.project, null, scope, 7, 'a.ts');
	expect(first.afterText).toBe('export const a = 2;\n');
	expect(first.beforeText).toBe('export const a = 1;\n');
	expect(await repo.fetches()).toBe(1);
	await prs.fileDiff(repo.project, null, scope, 7, 'b.ts');
	expect(await repo.fetches()).toBe(1);
	// After the 20 s TTL and after own actions drop the PR cache, a file still needs no GitHub read.
	prs.forget();
	vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
	await prs.fileDiff(repo.project, null, scope, 7, 'a.ts');
	await prs.prepare(repo.project, null, scope, 7);
	expect(reads()).toBe(1);
	expect(await repo.fetches()).toBe(1);
	vi.useRealTimers();
	// A new app: the head ref and the base tip are local, so the first file needs no fetch at all.
	const again = gh(repo.head, repo.base),
		next = new PullRequests(join(repo.dir, 'data'), again.forge, changes);
	await next.detail(repo.project, null, scope, 7);
	const diff = await next.fileDiff(repo.project, null, scope, 7, 'b.ts');
	expect(diff.afterText).toBe('export const b = 2;\n');
	expect(await repo.fetches()).toBe(1);
}, 60000);

it('saves «Viewed» with one mutation and keeps the PR read: the next read shows the mark without asking GitHub (spec/pull-requests-and-ci#pr-files)', async () => {
	process.env.BRIGADIR_TEST_GH = '1';
	const repo = await fixture(),
		{ forge, calls, reads } = gh(repo.head, repo.base),
		changes = new Changes(join(repo.dir, 'data'), join(__dirname, '../../out/services/diff.cjs'));
	const prs = new PullRequests(join(repo.dir, 'data'), forge, changes),
		scope = (await prs.scopes(repo.project, null))[0]!.id;
	await prs.list(repo.project, null);
	await prs.detail(repo.project, null, scope, 7);
	const before = calls.length;
	await prs.viewed(
		{ projectId: repo.project, id: null as unknown as string },
		scope,
		7,
		'b.ts',
		true
	);
	expect(
		calls.slice(before).map((args) => args.find((arg) => arg.startsWith('query='))?.slice(6, 80))
	).toEqual([expect.stringContaining('markFileAsViewed')]);
	expect(calls.slice(before)[0]).toEqual(expect.arrayContaining(['pr=PR_7', 'path=b.ts']));
	const detail = await prs.detail(repo.project, null, scope, 7);
	expect(detail.files.map((file) => file.viewed)).toEqual([false, true]);
	await prs.list(repo.project, null);
	expect(calls.length).toBe(before + 1);
	expect(reads()).toBe(1);
	// Unmarking patches the same cached PR.
	await prs.viewed(
		{ projectId: repo.project, id: null as unknown as string },
		scope,
		7,
		'b.ts',
		false
	);
	expect((await prs.detail(repo.project, null, scope, 7)).files.map((file) => file.viewed)).toEqual(
		[false, false]
	);
}, 60000);

/**
 * spec/pull-requests-and-ci#reading-and-refresh: two fresh reads of one PR overlap and the older answers last. The cache keeps the newer read, and so does the
 * last-read PR that «Viewed» takes its node id from.
 */
it('keeps the newer of two overlapping PR reads when the older answers last (spec/pull-requests-and-ci#reading-and-refresh)', async () => {
	process.env.BRIGADIR_TEST_GH = '1';
	const repo = await fixture(),
		gates: { node: string; open: (node: string) => void }[] = [];
	const hold = () =>
		new Promise<string>((resolve) => {
			gates.push({ node: '', open: resolve });
		});
	const { forge, calls } = gh(repo.head, repo.base, hold),
		prs = new PullRequests(join(repo.dir, 'data'), forge, {} as Changes),
		scope = (await prs.scopes(repo.project, null))[0]!.id;
	const older = prs.detail(repo.project, null, scope, 7, true);
	await vi.waitFor(() => expect(gates).toHaveLength(1));
	const newer = prs.detail(repo.project, null, scope, 7, true);
	await vi.waitFor(() => expect(gates).toHaveLength(2));
	gates[1]!.open('PR_new');
	expect((await newer).id).toBe('PR_new');
	gates[0]!.open('PR_old');
	expect((await older).id).toBe('PR_old');
	expect((await prs.detail(repo.project, null, scope, 7)).id).toBe('PR_new');
	const before = calls.length;
	await prs.viewed(
		{ projectId: repo.project, id: null as unknown as string },
		scope,
		7,
		'a.ts',
		true
	);
	expect(calls.slice(before)[0]).toEqual(expect.arrayContaining(['pr=PR_new']));
}, 60000);

/** spec/pull-requests-and-ci#review-drafts: the review drafts belong to the PR — every task of the project and the main tree read and write one file. */
it('shares review drafts of a PR between tasks and joins the old per-task files once (spec/pull-requests-and-ci#review-drafts)', async () => {
	const { dir, root, project, base, head } = await fixture(),
		{ forge } = gh(head, base),
		store = await SessionStore.at(join(dir, 'data'));
	const pulls = new PullRequests(join(dir, 'data'), forge, {} as Changes),
		[scope] = await discoverScopes(root);
	const [a, b, c] = await Promise.all(
		['A', 'B', 'C'].map((title) => store.createTask(project, title, 'claude'))
	);
	const draft = (body: string) => ({
		path: 'a.ts',
		side: 'RIGHT' as const,
		line: 1,
		startLine: null,
		body,
		replyTo: null,
	});
	// Before the project file exists: two tasks had their own files, one draft in both.
	const old = (body: string, id: string, at: string) => ({
		id,
		path: 'a.ts',
		side: 'RIGHT',
		line: 1,
		startLine: null,
		body,
		createdAt: at,
		replyTo: null,
	});
	await writeFile(
		join(await store.taskDir(a!), `pr-review-${scope!.id}-7.json`),
		JSON.stringify({
			schemaVersion: 1,
			review: {
				body: '',
				event: 'COMMENT',
				sendComments: true,
				last: null,
				drafts: [
					old('First', 'd1', '2026-10-01T10:00:00Z'),
					old('Both', 'd2', '2026-10-01T11:00:00Z'),
				],
			},
		})
	);
	await writeFile(
		join(await store.taskDir(b!), `pr-review-${scope!.id}-7.json`),
		JSON.stringify({
			schemaVersion: 1,
			review: {
				body: 'Overall',
				event: 'COMMENT',
				sendComments: true,
				last: null,
				drafts: [
					old('Both', 'd2', '2026-10-01T11:00:00Z'),
					old('Second', 'd3', '2026-10-01T12:00:00Z'),
				],
			},
		})
	);
	expect((await pulls.readDraft(c!, scope!.id, 7)).drafts.map((item) => item.body)).toEqual([
		'First',
		'Both',
		'Second',
	]);
	// The first write creates the PR file; every task, the main tree included, sees the same drafts.
	await pulls.addDraft(a!, scope!.id, 7, draft('From A'));
	const file = JSON.parse(
		await readFile(
			join(dir, 'data/projects', project, 'pull-requests', `review-${scope!.id}-7.json`),
			'utf8'
		)
	);
	expect(file.review.drafts.map((item: { body: string }) => item.body)).toEqual([
		'First',
		'Both',
		'Second',
		'From A',
	]);
	for (const task of [b!, c!, await store.ensureMainTree(project)])
		expect((await pulls.readDraft(task, scope!.id, 7)).drafts.map((item) => item.body)).toEqual([
			'First',
			'Both',
			'Second',
			'From A',
		]);
	// Parallel writes from two tasks are serialized on the PR: neither is lost.
	await Promise.all([
		pulls.addDraft(b!, scope!.id, 7, draft('From B')),
		pulls.addDraft(c!, scope!.id, 7, draft('From C')),
	]);
	expect(
		(await pulls.readDraft(a!, scope!.id, 7)).drafts
			.map((item) => item.body)
			.slice(-2)
			.sort()
	).toEqual(['From B', 'From C']);
});

/**
 * Security review W2 (spec/remote-access-and-mobile#phone-task-tools): «Delete the branch» deletes `refs/heads/<head>` in the PR's base repository. For a
 * PR from a fork that is a branch of the same name here, not the PR's; for a PR whose head is the default branch it is
 * the default branch. Both are refused before the merge, so nothing is merged with a delete GitHub would do to the wrong
 * branch; without the delete the merge goes as before.
 */
it('refuses to delete the branch of a PR from a fork or of the default branch, before merging (security review W2)', async () => {
	process.env.BRIGADIR_TEST_GH = '1';
	const repo = await fixture();
	const writes = (calls: string[][]) =>
		calls
			.filter((args) => args[0] === 'api' && args[1] === '--method')
			.map((args) => `${args[2]} ${args[3]}`);
	for (const pr of [{ isCrossRepository: true }, { headRefName: 'main' }]) {
		const { forge, calls } = gh(repo.head, repo.base, undefined, pr),
			prs = new PullRequests(join(repo.dir, 'data'), forge, {} as Changes),
			scope = (await prs.scopes(repo.project, null))[0]!.id,
			key = { projectId: repo.project, id: null as unknown as string };
		await expect(prs.merge(key, scope, 7, 'squash', true)).rejects.toThrow(/branch/i);
		expect(writes(calls)).toEqual([]);
		await prs.merge(key, scope, 7, 'squash', false);
		expect(writes(calls)).toEqual(['PUT repos/fixture/repo/pulls/7/merge']);
	}
	// A same-repo branch is still deleted with the merge.
	const { forge, calls } = gh(repo.head, repo.base),
		prs = new PullRequests(join(repo.dir, 'data'), forge, {} as Changes),
		scope = (await prs.scopes(repo.project, null))[0]!.id;
	await prs.merge(
		{ projectId: repo.project, id: null as unknown as string },
		scope,
		7,
		'squash',
		true
	);
	expect(writes(calls)).toEqual([
		'PUT repos/fixture/repo/pulls/7/merge',
		'DELETE repos/fixture/repo/git/refs/heads/feature',
	]);
}, 60000);
