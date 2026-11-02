import { zoneOwns, type ChangedFile, type CrewReportSummary, type Scope } from '@brigadir/core';
export type ReportInput = {
	taskId: string;
	nodeId: string;
	name: string;
	title: string;
	status: string;
	zone: readonly string[];
	projectPath: string;
	scopes: readonly Scope[];
	files: readonly ChangedFile[];
	lastMessage: string;
	question: string | null;
	newNotes: number;
	verdict: CrewReportSummary['verdict'];
	round: number | null;
	reviews: { reviewer: string; comments: number; approved: boolean }[];
	/** spec/crew#parts: the member's part; the header names it from the second on. */ part?: number;
};
/** Project-relative path of a changed file: its repo prefix plus the path inside that repo. */
export function projectRelative(
	scope: Scope | undefined,
	projectPath: string,
	path: string
): string {
	if (!scope || scope.path === projectPath) return path;
	const prefix = scope.path.startsWith(`${projectPath}/`)
		? scope.path.slice(projectPath.length + 1)
		: scope.name;
	return `${prefix}/${path}`;
}
/** spec/crew#task-type, foreman context: the report is built by code from the journal and the diff, never written by the worker as prose. */
export function buildReport(input: ReportInput): { summary: CrewReportSummary; text: string } {
	const rows = input.files.map((file) => {
		const path = projectRelative(
			input.scopes.find((scope) => scope.id === file.scopeId),
			input.projectPath,
			file.path
		);
		return { path, file, outside: input.zone.length > 0 && !zoneOwns(input.zone, path) };
	});
	const additions = rows.reduce((sum, row) => sum + row.file.additions, 0),
		deletions = rows.reduce((sum, row) => sum + row.file.deletions, 0),
		outside = rows.filter((row) => row.outside);
	const summary: CrewReportSummary = {
		taskId: input.taskId,
		nodeId: input.nodeId,
		name: input.name,
		title: input.title,
		additions,
		deletions,
		files: rows.length,
		outside: outside.length,
		verdict: input.verdict,
		round: input.round,
		newNotes: input.newNotes,
	};
	const lines = [
		`Report from \`${input.name}\` · ${input.title} (task ${input.taskId}${input.part && input.part > 1 ? `, part ${input.part}` : ''})`,
		`Status: ${input.status}. Changed files: ${rows.length}, +${additions} −${deletions}.`,
	];
	if (rows.length) {
		lines.push('Files:');
		for (const row of rows.slice(0, 200))
			lines.push(
				`- ${row.path} ${row.file.status} +${row.file.additions} −${row.file.deletions}${row.file.binary ? ' binary' : ''}`
			);
		if (rows.length > 200) lines.push(`- … ${rows.length - 200} more`);
	}
	if (outside.length)
		lines.push(
			`Changes outside the assigned files (${outside.length}): ${outside
				.slice(0, 20)
				.map((row) => row.path)
				.join(', ')}${outside.length > 20 ? '…' : ''}.`
		);
	if (input.reviews.length)
		lines.push(
			`Checks: ${input.reviews.map((review) => `${review.reviewer} ${review.approved ? 'approved' : `${review.comments} comment${review.comments === 1 ? '' : 's'}`}`).join('; ')}${input.round !== null ? ` (round ${input.round})` : ''}.${input.verdict === 'disputed' ? ' The reviewer did not agree after two rounds; both sides are in the review thread. You decide.' : ''}`
		);
	if (input.newNotes) lines.push(`Notes: ${input.newNotes} new. Call read_notes to read them.`);
	if (input.question) lines.push(`The worker ended with a question: ${input.question}`);
	if (input.lastMessage.trim())
		lines.push('', `Worker's last message:`, input.lastMessage.trim().slice(0, 4000));
	lines.push(
		'',
		`Use read_diff(taskId, path) for a file, prompt_task(taskId, text) to return work, accept_task(taskId) to accept.`
	);
	return { summary, text: lines.join('\n') };
}
