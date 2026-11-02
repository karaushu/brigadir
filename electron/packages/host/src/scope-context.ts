import { isGitScope, visibleToAgent, writableByAgent, type Scope } from '@brigadir/core';
/** App context stays English and outside the user's prompt and repository files. */
export function scopeContext(scopes: readonly Scope[]): string {
	if (!scopes.length) return '';
	return (
		'Workspace repositories\nEach entry is a separate Git repository unless `git` is false. Use the most specific entry for a path. Only modify entries marked writable. Everything else is context; do not edit it, including through terminal commands.\n' +
		JSON.stringify(
			/* The manifest stays FULL: repos outside the task are context the agent sees but does not write (spec/projects-and-board#repo-selection). */
			scopes
				.filter((scope) => scope.available !== false)
				.map((scope) => ({
					path: scope.path,
					name: scope.name,
					kind: scope.kind,
					git: isGitScope(scope),
					branch: scope.branch,
					remote: scope.remote ?? null,
					writable: writableByAgent(scope),
				})),
			null,
			2
		)
	);
}

/** ACP additional roots only expand access; they are not a read-only boundary for cwd. */
export function scopeDirectories(scopes: readonly Scope[]): string[] {
	return [
		...new Set(
			scopes
				.filter(
					(scope) => scope.kind !== 'root' && visibleToAgent(scope) && scope.available !== false
				)
				.map((scope) => scope.path)
		),
	];
}
