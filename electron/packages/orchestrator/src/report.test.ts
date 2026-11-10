import { expect, it } from 'vitest';
import { buildReport, type ReportInput } from './report';
const input: ReportInput = {
	taskId: 't1',
	nodeId: 'api',
	name: 'API',
	title: 'Export',
	status: 'completed',
	zone: [],
	projectPath: '/p',
	scopes: [],
	files: [],
	lastMessage: '',
	question: null,
	newNotes: 0,
	verdict: null,
	round: null,
	reviews: [],
};
// spec/crew#reports
it('adds the usage line only when the provider reported tokens', () => {
	expect(buildReport(input).text).not.toContain('Usage:');
	expect(
		buildReport({ ...input, usage: { turns: 3, input: 48_200, output: 950, cached: 1_240_000 } })
			.text
	).toContain('Usage: 3 turns, 48.2k in, 950 out, 1.2M cached.');
});
