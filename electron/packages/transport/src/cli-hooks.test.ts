import { expect, it } from 'vitest';
import { cliHook } from './cli-hooks';
it('normalizes provider lifecycle without copying transcripts, responses or child-agent events', () => {
	const base = { session_id: 'fixture-session', turn_id: 'turn-1' };
	expect(
		cliHook({
			...base,
			hook_event_name: 'UserPromptSubmit',
			prompt: 'First line\nPrivate second line',
		})
	).toEqual({ sessionId: 'fixture-session', turnId: 'turn-1', kind: 'prompt', text: 'First line' });
	expect(
		cliHook({
			...base,
			hook_event_name: 'PostToolUse',
			tool_name: 'Bash',
			tool_use_id: 'tool-1',
			tool_response: { secret: 'never copied' },
		})
	).toEqual({
		sessionId: 'fixture-session',
		turnId: 'turn-1',
		kind: 'tool',
		id: 'tool-1',
		name: 'Bash',
		status: 'completed',
	});
	expect(cliHook({ ...base, hook_event_name: 'Stop', agent_id: 'child' })).toBeNull();
	expect(() => cliHook({ session_id: '../../escape', hook_event_name: 'SessionStart' })).toThrow(
		'Invalid'
	);
});
