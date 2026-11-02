import {
	_electron as electron,
	expect,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
/**
 * spec/pull-requests-and-ci#pr-panel fixture: a monorepo with several git roots (root, gitignored `kit` and `apps/admin` repos with their own origins),
 * a PR head pushed to `refs/pull/421/head`, and compact GitHub PRs the `gh` fixture expands to GraphQL.
 */
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
export const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
export const loyalty =
	'export function LoyaltyRule({ rule, onChange }: Props) {\n  const [draft, setDraft] = useState(rule);\n\n  const paid = draft.items.filter((i) => !i.free);\n  const total = paid.reduce((s, i) => s + i.price, 0);\n  const free = Math.floor(draft.items.length / 2);\n\n  return (\n    <Card title={t("loyalty.rule")}>\n      <Badge tone="accent">1+1</Badge>\n      <Money value={total} free={free} />\n    </Card>\n  );\n}\n';
export function fixturePRs() {
	return [
		{
			repo: 'admin',
			number: 421,
			title: 'Loyalty 1+1 in admin',
			author: 'mkovalenko',
			requested: ['me'],
			comments: 4,
			checks: 'PENDING',
			updatedAt: ago(12),
			head: 'feat/loyalty-admin',
			base: 'staging',
			approvals: 1,
			mergeState: 'BLOCKED',
			reviewDecision: 'REVIEW_REQUIRED',
			body: '## What\nEvery second item is free.\n\n## How\n- `LoyaltyRule.tsx` counts only **paid** items\n- see [the brief](https://github.com/fixture/admin/issues/7)\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
			threads: [
				{
					path: 'src/loyalty/LoyaltyRule.tsx',
					line: 6,
					comments: [
						{
							author: 'olena-p',
							body: 'For an odd count this rounds down: 3 items give 1 free.',
							at: ago(60),
						},
						{ author: 'mkovalenko', body: 'Brief says every second item.', at: ago(40) },
					],
				},
				{
					path: 'src/loyalty/rules.ts',
					line: 1,
					resolved: true,
					comments: [{ author: 'ihor-s', body: 'Name it everySecondFree?' }],
				},
			],
			files: [
				{ path: 'src/loyalty/LoyaltyRule.tsx', additions: 14, viewed: true },
				{ path: 'src/loyalty/rules.ts', additions: 1 },
			],
			commitList: [
				{
					sha: 'a82e7d4'.padEnd(40, '0'),
					subject: 'loyalty: every second item free',
					author: 'mkovalenko',
					at: ago(300),
				},
			],
			checkRuns: [
				{ name: 'build' },
				{
					name: 'e2e-admin',
					conclusion: 'FAILURE',
					link: 'https://github.com/fixture/admin/actions/runs/7',
				},
			],
		},
		{
			repo: 'admin',
			number: 419,
			title: 'Orders: export to CSV',
			author: 'me',
			reviewDecision: 'CHANGES_REQUESTED',
			comments: 3,
			checks: 'SUCCESS',
			updatedAt: ago(180),
		},
		{
			repo: 'admin',
			number: 416,
			title: 'Bump @tanstack/react-query to 6',
			author: 'dependabot',
			checks: 'FAILURE',
			updatedAt: ago(60 * 26),
		},
		{
			repo: 'admin',
			number: 414,
			title: 'Admin: import menu from CSV',
			author: 'me',
			state: 'MERGED',
			closedAt: ago(60 * 24 * 3),
			updatedAt: ago(60 * 24 * 3),
		},
		{
			repo: 'admin',
			number: 400,
			title: 'Old closed',
			author: 'me',
			state: 'CLOSED',
			closedAt: ago(60 * 24 * 20),
			updatedAt: ago(60 * 24 * 20),
		},
		{
			repo: 'kit',
			number: 88,
			title: 'Kit Button: focus ring token',
			author: 'me',
			checks: 'SUCCESS',
			updatedAt: ago(30),
		},
	];
}
const dirs = [
	'docs/state-management',
	'src/features/liveUpdates/handlers',
	'src/hooks',
	'src/features/menus/_components',
	'src/utils',
];
/** A PR with more files, threads, commits and checks than the PR panel holds. */
export function longPR(number = 1062, author = 'me') {
	const files = Array.from({ length: 62 }, (_, i) => ({
		path: `${dirs[i % dirs.length]}/file${String(i).padStart(2, '0')}.ts`,
		additions: i + 1,
		deletions: i % 3,
		viewed: i < 3,
	}));
	return {
		repo: 'admin',
		number,
		title: 'feat: refresh open pages when data changes',
		author,
		requested: [],
		comments: 0,
		checks: 'SUCCESS',
		updatedAt: ago(5),
		head: 'feat/live-updates',
		base: 'staging',
		files,
		threads: Array.from({ length: 30 }, (_, i) => ({
			path: files[i]!.path,
			line: i + 1,
			comments: [{ author: 'olena-p', body: `Comment ${i} on this line`, at: ago(60) }],
		})),
		commitList: Array.from({ length: 30 }, (_, i) => ({
			sha: String(i).padStart(7, 'a').padEnd(40, '0'),
			subject: `commit ${i}: live updates`,
			author: 'me',
			at: ago(300 - i),
		})),
		checkRuns: Array.from({ length: 30 }, (_, i) => ({ name: `check-${i}` })),
	};
}
export type PRFixture = {
	app: ElectronApplication;
	page: Page;
	root: string;
	repo: string;
	state: string;
	errors: string[];
	task: { projectId: string; id: string };
	gh(): Promise<Record<string, any>>;
	setGh(update: object): Promise<void>;
	/** Closes the app and deletes the fixture dir; its task hosts exit with it (spec/architecture-and-platform#host-lifecycle). */ close(): Promise<void>;
};
export async function launchPRFixture(
	options: {
		theme?: 'light' | 'dark';
		language?: 'en' | 'uk';
		prs?: object[];
		task?: boolean;
		modules?: object;
	} = {}
): Promise<PRFixture> {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-prs-')),
		repo = join(root, 'choice'),
		data = join(root, 'data'),
		state = join(root, 'gh.json');
	await mkdir(repo);
	const run =
		(cwd: string) =>
		async (...args: string[]) =>
			(await promisify(execFile)('git', args, { cwd })).stdout.trim();
	async function init(path: string, files: Record<string, string>) {
		await mkdir(path, { recursive: true });
		const git = run(path),
			remote = join(root, 'remotes', path.replace(/\W/g, '_') + '.git');
		await mkdir(remote, { recursive: true });
		await promisify(execFile)('git', ['init', '--bare', '-b', 'main'], { cwd: remote });
		await git('init', '-b', 'main');
		await git('config', 'user.name', 'Fixture');
		await git('config', 'user.email', 'fixture@example.invalid');
		for (const [file, text] of Object.entries(files)) {
			await mkdir(join(path, file, '..'), { recursive: true });
			await writeFile(join(path, file), text);
		}
		await git('add', '.');
		await git('commit', '-m', 'Baseline');
		await git('remote', 'add', 'origin', remote);
		await git('push', '-u', 'origin', 'main');
		await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
		return git;
	}
	await init(repo, {
		'.gitignore': 'kit/\napps/admin/\n',
		'vite.config.ts': 'export default {};\n',
	});
	await init(join(repo, 'kit'), { 'src/Button/Button.module.css': '.button { outline: none; }\n' });
	const admin = await init(join(repo, 'apps/admin'), {
		'src/features/ai/flags.ts': 'export const flags = {};\n',
	});
	await admin('switch', '-c', 'staging');
	await admin('push', '-u', 'origin', 'staging');
	await admin('switch', '-c', 'feat/loyalty-admin');
	await mkdir(join(repo, 'apps/admin/src/loyalty'), { recursive: true });
	await writeFile(join(repo, 'apps/admin/src/loyalty/LoyaltyRule.tsx'), loyalty);
	await writeFile(
		join(repo, 'apps/admin/src/loyalty/rules.ts'),
		'export const everySecond = true;\n'
	);
	await admin('add', '.');
	await admin('commit', '-m', 'loyalty: every second item free');
	const headSha = await admin('rev-parse', 'HEAD');
	await admin('push', 'origin', 'HEAD:refs/pull/421/head');
	await admin('push', 'origin', 'HEAD:refs/heads/feat/loyalty-admin');
	await admin('switch', 'main');
	await admin('switch', '-c', 'fix/ai-chat-flag-gating');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'choice', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: {
				appearance: options.theme ?? 'light',
				language: options.language ?? 'en',
				...(options.modules ? { modules: options.modules } : {}),
			},
		})
	);
	await writeFile(
		state,
		JSON.stringify({
			repoNames: true,
			viewer: 'me',
			pullRequests:
				options.prs ??
				fixturePRs().map((pr) =>
					pr.number === 421
						? { ...pr, commitList: pr.commitList!.map((commit) => ({ ...commit, sha: headSha })) }
						: pr
				),
		})
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_TEST_GH: resolve('packages/forge/fixtures/gh.mjs'),
			BRIGADIR_TEST_GH_STATE: state,
			// spec/pull-requests-and-ci#ci-bell: the bell's watch polls every second and records notices instead of reaching Notification Center.
			BRIGADIR_TEST_CI_WATCH_MS: '1000',
			BRIGADIR_TEST_NOTIFICATIONS: '1',
		},
	});
	const page = await app.firstWindow(),
		errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
	let task = { projectId: 'project', id: '' };
	if (options.task !== false) {
		task = await page.evaluate(async () => {
			const task = await window.brigadir.createTask(
				'project',
				'Gate AI chat flag',
				'claude',
				'gui',
				false
			);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(async () =>
				(
					await page.evaluate((task) => window.brigadir.readSession(task as never), task)
				).records.some((record) => record.event.kind === 'turn.completed')
			)
			.toBe(true);
		await page
			.locator('aside')
			.getByRole('button', { name: /Gate AI chat flag/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
	}
	return {
		app,
		page,
		root,
		repo,
		state,
		errors,
		task,
		close: async () => {
			try {
				await app.close();
			} finally {
				await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
			}
		},
		gh: async () => JSON.parse(await readFile(state, 'utf8')),
		setGh: async (update) => {
			await writeFile(
				state,
				JSON.stringify({ ...JSON.parse(await readFile(state, 'utf8')), ...update })
			);
		},
	};
}
