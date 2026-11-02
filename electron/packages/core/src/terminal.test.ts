import { expect, it } from 'vitest';
import { closeAsks } from './terminal';
it('asks before closing only while something would stop (spec/task-window-workspace#terminal-close)', () => {
	expect(closeAsks({ exited: false, busy: false })).toBe(false);
	expect(closeAsks({ exited: false, busy: true })).toBe(true);
	// A host that does not say keeps the question.
	expect(closeAsks({ exited: false })).toBe(true);
	expect(closeAsks({ exited: true, busy: true })).toBe(false);
	const run = { commandId: 'dev', name: 'dev', line: 'pnpm dev', port: null };
	expect(closeAsks({ exited: false, run } as Parameters<typeof closeAsks>[0])).toBe(true);
});
