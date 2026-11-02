import { spawn } from 'node:child_process';
import {
	isRecord,
	isWebURL,
	isPRRef,
	type ForgeAuth,
	type ForgeRepository,
	type PRRef,
	type PRDetails,
	type PRCheck,
	type PullRequestSummary,
	type PullRequestDetail,
	type CIRun,
	type CIRunDetail,
	type CIRunsQuery,
	type CIDeploy,
	type CIAnnotation,
} from '@brigadir/core';
import { listQuery, detailQuery, parseList, parseDetail } from './pull-requests';
export * from './pull-requests';
import { parseRuns, parseJobs, parseDeploy, parseAnnotation } from './ci-runs';
export * from './ci-runs';
export type GhResult = { code: number | null; stdout: string; stderr: string };
export type GhRunner = (cwd: string, args: string[], input?: string) => Promise<GhResult>;
export class ForgeError extends Error {}
export function ghCommand(command = 'gh', prefix: string[] = []): GhRunner {
	return (cwd, args, input) =>
		new Promise((resolve, reject) => {
			const child = spawn(command, [...prefix, ...args], {
				cwd,
				env: {
					...process.env,
					GH_PROMPT_DISABLED: '1',
					GH_NO_UPDATE_NOTIFIER: '1',
					GH_PAGER: 'cat',
					GIT_TERMINAL_PROMPT: '0',
				},
				stdio: 'pipe',
				shell: false,
			});
			let stdout = '',
				stderr = '',
				oversized = false;
			const timer = setTimeout(() => {
				oversized = true;
				child.kill('SIGKILL');
			}, 60000);
			timer.unref();
			child.stdout.on('data', (chunk) => {
				stdout += chunk.toString();
				if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
					oversized = true;
					child.kill('SIGKILL');
				}
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk.toString();
				if (Buffer.byteLength(stderr) > 64000) {
					oversized = true;
					child.kill('SIGKILL');
				}
			});
			child.stdin.on('error', () => {});
			child.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once('close', (code) => {
				clearTimeout(timer);
				if (oversized) reject(new ForgeError('GitHub command exceeded its resource limit'));
				else resolve({ code, stdout, stderr });
			});
			child.stdin.end(input);
		});
}
export const runGh = ghCommand();
const fields = 'number,url,title,state,headRefName,baseRefName';
/**
 * `gh api` prints the response body on stdout even for an HTTP error, and only «gh: Unprocessable Entity (HTTP 422)» on stderr.
 * GitHub's own reasons («Can not request changes on your own pull request») are in `errors`; they are what the person needs.
 */
function failure(result: GhResult) {
	let reasons: string[] = [];
	try {
		const value: unknown = JSON.parse(result.stdout);
		if (isRecord(value) && Array.isArray(value.errors))
			reasons = value.errors
				.map((item) =>
					typeof item === 'string'
						? item
						: isRecord(item) && typeof item.message === 'string'
							? item.message
							: ''
				)
				.filter(Boolean)
				.slice(0, 3)
				.map((item) => item.slice(0, 500));
	} catch {
		/* not JSON */
	}
	const status = result.stderr.trim();
	return reasons.length
		? `${reasons.join('; ')}${status ? ` (${status.replace(/^gh:\s*/, '')})` : ''}`
		: status || 'GitHub request failed';
}
function json(result: GhResult) {
	if (result.code !== 0) throw new ForgeError(failure(result));
	try {
		return JSON.parse(result.stdout) as unknown;
	} catch {
		throw new ForgeError('Invalid GitHub response');
	}
}
function pr(value: unknown): PRRef {
	if (!isRecord(value)) throw new ForgeError('Invalid pull request');
	const ref = {
		number: value.number,
		url: value.url,
		title: value.title,
		state: value.state,
		head: value.headRefName,
		base: value.baseRefName,
	};
	if (!isPRRef(ref)) throw new ForgeError('Invalid pull request');
	return ref;
}
export class Forge {
	private run: GhRunner;
	private running = 0;
	private waiting: (() => void)[] = [];
	/** At most 4 concurrent gh processes per instance; a freed slot passes to the next in the queue. */
	constructor(run: GhRunner = runGh) {
		this.run = async (cwd, args, input) => {
			if (this.running < 4) this.running++;
			else await new Promise<void>((resolve) => this.waiting.push(resolve));
			try {
				return await run(cwd, args, input);
			} finally {
				const next = this.waiting.shift();
				if (next) next();
				else this.running--;
			}
		};
	}
	async auth(cwd: string): Promise<ForgeAuth> {
		try {
			const result = await this.run(cwd, ['auth', 'status']);
			if (result.code === 0) return 'ready';
			return /not logged|authentication failed|token[^\n]*invalid/i.test(
				result.stderr + result.stdout
			)
				? 'login'
				: 'error';
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return 'missing';
			throw error;
		}
	}
	async repository(cwd: string, remote: string): Promise<ForgeRepository> {
		const value = json(
			await this.run(cwd, ['repo', 'view', remote, '--json', 'nameWithOwner,url,defaultBranchRef'])
		);
		if (
			!isRecord(value) ||
			typeof value.nameWithOwner !== 'string' ||
			!isWebURL(value.url) ||
			!isRecord(value.defaultBranchRef) ||
			typeof value.defaultBranchRef.name !== 'string'
		)
			throw new ForgeError('Invalid repository response');
		return {
			name: value.nameWithOwner,
			url: value.url,
			defaultBranch: value.defaultBranchRef.name,
		};
	}
	async pullRequest(
		cwd: string,
		repository: ForgeRepository,
		branch: string
	): Promise<PRRef | null> {
		const value = json(
			await this.run(cwd, [
				'pr',
				'list',
				'--repo',
				repository.url,
				'--head',
				branch,
				'--state',
				'all',
				'--limit',
				'100',
				'--json',
				fields,
			])
		);
		if (!Array.isArray(value)) throw new ForgeError('Invalid pull request list');
		const refs = value
			.map(pr)
			.filter((ref) => ref.head === branch)
			.sort(
				(a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number
			);
		return refs[0] ?? null;
	}
	async details(cwd: string, repository: ForgeRepository, number: number): Promise<PRDetails> {
		if (!Number.isSafeInteger(number) || number < 1)
			throw new ForgeError('Invalid pull request number');
		const [view, checkResult] = await Promise.all([
			this.run(cwd, [
				'pr',
				'view',
				String(number),
				'--repo',
				repository.url,
				'--json',
				`${fields},mergeable`,
			]),
			this.run(cwd, [
				'pr',
				'checks',
				String(number),
				'--repo',
				repository.url,
				'--json',
				'name,bucket,link',
			]),
		]);
		const value = json(view);
		if (!isRecord(value) || typeof value.mergeable !== 'string')
			throw new ForgeError('Invalid pull request response');
		let checks: PRCheck[] = [];
		// gh uses exit1 for failed checks/no workflow, exit8 for pending. Only valid
		// structured output or its explicit no-checks diagnostic is a successful read.
		if (
			checkResult.code === 1 &&
			(!checkResult.stdout.trim() || checkResult.stdout.trim() === '[]') &&
			/\bno checks reported\b/i.test(checkResult.stderr)
		)
			checks = [];
		else {
			let list: unknown;
			try {
				list = JSON.parse(checkResult.stdout);
			} catch {
				throw new ForgeError(checkResult.stderr.trim() || 'Cannot read pull request checks');
			}
			if (
				![0, 1, 8].includes(checkResult.code ?? -1) ||
				!Array.isArray(list) ||
				(list.length === 0 && checkResult.code !== 0) ||
				!list.every(
					(item) =>
						isRecord(item) &&
						typeof item.name === 'string' &&
						item.name.length <= 2000 &&
						['pass', 'fail', 'pending', 'skipping', 'cancel'].includes(String(item.bucket)) &&
						typeof item.link === 'string' &&
						(item.link === '' || isWebURL(item.link))
				)
			)
				throw new ForgeError('Invalid checks response');
			checks = list as PRCheck[];
		}
		return { pr: pr(value), mergeable: value.mergeable, checks };
	}
	/** spec/pull-requests-and-ci#reading-and-refresh: the repository's `owner/name` comes from `repo view`, not from the remote string. */
	private async graphql(
		cwd: string,
		repository: ForgeRepository,
		query: string,
		fields: string[] = []
	): Promise<unknown> {
		const [owner, name] = repository.name.split('/');
		if (!owner || !name) throw new ForgeError('Invalid repository');
		return json(
			await this.run(cwd, [
				'api',
				'graphql',
				'-f',
				`query=${query}`,
				'-f',
				`owner=${owner}`,
				'-f',
				`name=${name}`,
				...fields,
			])
		);
	}
	async pullRequests(
		cwd: string,
		repository: ForgeRepository
	): Promise<{ viewer: string; prs: PullRequestSummary[] }> {
		try {
			return parseList(await this.graphql(cwd, repository, listQuery));
		} catch (error) {
			if (error instanceof ForgeError) throw error;
			throw new ForgeError('Invalid pull request list');
		}
	}
	async pullRequestDetail(
		cwd: string,
		repository: ForgeRepository,
		number: number
	): Promise<PullRequestDetail> {
		if (!Number.isSafeInteger(number) || number < 1)
			throw new ForgeError('Invalid pull request number');
		try {
			return parseDetail(
				await this.graphql(cwd, repository, detailQuery, ['-F', `number=${number}`])
			);
		} catch (error) {
			if (error instanceof ForgeError) throw error;
			throw new ForgeError('Invalid pull request response');
		}
	}
	/* spec/pull-requests-and-ci#review-modal, spec/pull-requests-and-ci#merge: writes to GitHub happen only on a person's action; each returns the error in GitHub's words. */
	private slug(repository: ForgeRepository) {
		const [owner, name] = repository.name.split('/');
		if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name))
			throw new ForgeError('Invalid repository');
		return `repos/${owner}/${name}`;
	}
	private async get(cwd: string, path: string): Promise<unknown> {
		return json(await this.run(cwd, ['api', path]));
	}
	/* spec/pull-requests-and-ci#ci: GitHub Actions is REST reads only. A repo without workflows or with Actions disabled (404) is an empty list, not an error. */
	async viewer(cwd: string): Promise<string> {
		const value = await this.get(cwd, 'user');
		if (!isRecord(value) || typeof value.login !== 'string')
			throw new ForgeError('Invalid GitHub response');
		return value.login;
	}
	async ciRuns(
		cwd: string,
		repository: ForgeRepository,
		query: CIRunsQuery,
		viewer: string | null
	): Promise<CIRun[]> {
		const params = new URLSearchParams({ per_page: '30' });
		if (query.sha) params.set('head_sha', query.sha);
		if (query.branch) params.set('branch', query.branch);
		let value: unknown;
		try {
			value = await this.get(cwd, `${this.slug(repository)}/actions/runs?${params}`);
		} catch (error) {
			if (error instanceof ForgeError && /\bHTTP 404\b/.test(error.message)) return [];
			throw error;
		}
		const runs = parseRuns(value, viewer);
		return query.workflow ? runs.filter((run) => run.workflow === query.workflow) : runs;
	}
	/** One run with its jobs and steps, the deployment of its job with `environment` and the first failure annotation (spec/pull-requests-and-ci#ci). */
	async ciRun(
		cwd: string,
		repository: ForgeRepository,
		runId: number,
		viewer: string | null
	): Promise<CIRunDetail> {
		if (!Number.isSafeInteger(runId) || runId < 1) throw new ForgeError('Invalid run');
		const slug = this.slug(repository);
		const [value, jobsValue] = await Promise.all([
			this.get(cwd, `${slug}/actions/runs/${runId}`),
			this.get(cwd, `${slug}/actions/runs/${runId}/jobs?per_page=100`),
		]);
		const run = parseRuns({ workflow_runs: [value] }, viewer)[0];
		if (!run) throw new ForgeError('Invalid GitHub response');
		const jobs = parseJobs(jobsValue);
		let deploy: CIDeploy | null = null,
			annotation: CIAnnotation | null = null;
		// Without a deployment, or without access to it, there is no deploy bar: the run shows as passed or failed.
		try {
			const deployments = await this.get(cwd, `${slug}/deployments?sha=${run.sha}&per_page=5`);
			for (const deployment of Array.isArray(deployments) ? deployments.slice(0, 5) : []) {
				const deploymentId =
					isRecord(deployment) && Number.isSafeInteger(deployment.id) ? Number(deployment.id) : 0;
				if (!deploymentId) continue;
				deploy = parseDeploy(
					deployment,
					await this.get(cwd, `${slug}/deployments/${deploymentId}/statuses?per_page=1`),
					jobs
				);
				if (deploy) break;
			}
		} catch {
			deploy = null;
		}
		const failed = jobs.find((job) => job.state === 'fail');
		if (failed)
			try {
				annotation = parseAnnotation(
					await this.get(cwd, `${slug}/check-runs/${failed.id}/annotations`),
					failed.id
				);
			} catch {
				annotation = null;
			}
		return { run, jobs, deploy, annotation };
	}
	private async rest(
		cwd: string,
		method: 'POST' | 'PUT',
		path: string,
		body: object
	): Promise<unknown> {
		return json(
			await this.run(cwd, ['api', '--method', method, path, '--input', '-'], JSON.stringify(body))
		);
	}
	private async mutate(cwd: string, query: string, fields: string[]): Promise<unknown> {
		const value = json(await this.run(cwd, ['api', 'graphql', '-f', `query=${query}`, ...fields]));
		if (isRecord(value) && Array.isArray(value.errors) && value.errors.length)
			throw new ForgeError(
				String(isRecord(value.errors[0]) ? value.errors[0].message : 'GitHub request failed')
			);
		return value;
	}
	async submitReview(
		cwd: string,
		repository: ForgeRepository,
		number: number,
		input: {
			event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
			body: string;
			commitId: string;
			comments: {
				path: string;
				line: number;
				side: 'LEFT' | 'RIGHT';
				startLine: number | null;
				body: string;
			}[];
		}
	) {
		await this.rest(cwd, 'POST', `${this.slug(repository)}/pulls/${number}/reviews`, {
			event: input.event,
			body: input.body,
			commit_id: input.commitId,
			comments: input.comments.map((comment) => ({
				path: comment.path,
				line: comment.line,
				side: comment.side,
				...(comment.startLine !== null && comment.startLine < comment.line
					? { start_line: comment.startLine, start_side: comment.side }
					: {}),
				body: comment.body,
			})),
		});
	}
	async reply(
		cwd: string,
		repository: ForgeRepository,
		number: number,
		commentId: number,
		body: string
	) {
		await this.rest(
			cwd,
			'POST',
			`${this.slug(repository)}/pulls/${number}/comments/${commentId}/replies`,
			{ body }
		);
	}
	async lineComment(
		cwd: string,
		repository: ForgeRepository,
		number: number,
		input: {
			commitId: string;
			path: string;
			line: number;
			side: 'LEFT' | 'RIGHT';
			startLine: number | null;
			body: string;
		}
	) {
		await this.rest(cwd, 'POST', `${this.slug(repository)}/pulls/${number}/comments`, {
			commit_id: input.commitId,
			path: input.path,
			line: input.line,
			side: input.side,
			...(input.startLine !== null && input.startLine < input.line
				? { start_line: input.startLine, start_side: input.side }
				: {}),
			body: input.body,
		});
	}
	async issueComment(cwd: string, repository: ForgeRepository, number: number, body: string) {
		await this.rest(cwd, 'POST', `${this.slug(repository)}/issues/${number}/comments`, { body });
	}
	async resolveThread(cwd: string, threadId: string, resolved: boolean) {
		const name = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
		await this.mutate(
			cwd,
			`mutation($thread:ID!){${name}(input:{threadId:$thread}){thread{id isResolved}}}`,
			['-f', `thread=${threadId}`]
		);
	}
	/** spec/pull-requests-and-ci#merge-card: a draft PR becomes ready for review; GitHub asks its reviewers. */
	async markReady(cwd: string, pullRequestId: string) {
		await this.mutate(
			cwd,
			'mutation($pr:ID!){markPullRequestReadyForReview(input:{pullRequestId:$pr}){pullRequest{id isDraft}}}',
			['-f', `pr=${pullRequestId}`]
		);
	}
	async markViewed(cwd: string, pullRequestId: string, path: string, viewed: boolean) {
		const name = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
		await this.mutate(
			cwd,
			`mutation($pr:ID!,$path:String!){${name}(input:{pullRequestId:$pr,path:$path}){pullRequest{id}}}`,
			['-f', `pr=${pullRequestId}`, '-f', `path=${path}`]
		);
	}
	/** Via REST, not `gh pr merge`: that touches local branches and can switch the person's working tree. */
	async merge(
		cwd: string,
		repository: ForgeRepository,
		number: number,
		input: {
			method: 'squash' | 'merge' | 'rebase';
			deleteBranch: boolean;
			head: string;
			headSha: string;
		}
	) {
		await this.rest(cwd, 'PUT', `${this.slug(repository)}/pulls/${number}/merge`, {
			merge_method: input.method,
			sha: input.headSha,
		});
		if (input.deleteBranch) {
			const result = await this.run(cwd, [
				'api',
				'--method',
				'DELETE',
				`${this.slug(repository)}/git/refs/heads/${input.head.split('/').map(encodeURIComponent).join('/')}`,
			]);
			if (result.code !== 0)
				throw new ForgeError(result.stderr.trim() || 'The branch could not be deleted');
		}
	}
	async create(
		cwd: string,
		repository: ForgeRepository,
		input: { branch: string; base: string; title: string; body: string; web?: boolean }
	): Promise<string | null> {
		if (
			!input.title.trim() ||
			input.title.length > 1000 ||
			input.body.length > 100000 ||
			!input.branch ||
			!input.base
		)
			throw new ForgeError('Invalid pull request draft');
		const result = await this.run(
			cwd,
			[
				'pr',
				'create',
				'--repo',
				repository.url,
				'--head',
				input.branch,
				'--base',
				input.base,
				'--title',
				input.title,
				'--body-file',
				'-',
				...(input.web ? ['--web'] : []),
			],
			input.body
		);
		if (result.code !== 0)
			throw new ForgeError(result.stderr.trim() || 'Pull request creation failed');
		if (input.web) return null;
		const url = result.stdout.trim().split('\n').at(-1);
		if (
			!isWebURL(url) ||
			new URL(url).origin !== new URL(repository.url).origin ||
			!url.startsWith(`${repository.url.replace(/\/$/, '')}/pull/`) ||
			!/^\d+$/.test(url.split('/').at(-1)!)
		)
			throw new ForgeError('GitHub did not return a pull request URL');
		return url;
	}
}
