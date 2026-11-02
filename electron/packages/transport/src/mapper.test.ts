import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { NewSessionResponse, SessionUpdate } from '@agentclientprotocol/sdk';
import { mapOptions, mapSession, mapTool, mapUpdate } from './mapper';
for (const provider of ['claude', 'codex']) {
	const fixture = JSON.parse(
		readFileSync(new URL(`../fixtures/${provider}.json`, import.meta.url), 'utf8')
	) as { session: NewSessionResponse; updates: SessionUpdate[] };
	it(`maps captured ${provider} session, catalog, text and tool events without leaking protocol envelopes`, () => {
		const session = mapSession(fixture.session);
		expect(session.kind).toBe('session.started');
		if (session.kind !== 'session.started') throw new Error('Expected session');
		expect(session.options.some((option) => option.category === 'model')).toBe(true);
		expect(session.options.length).toBeGreaterThan(1);
		const events = fixture.updates.map(mapUpdate);
		expect(
			events.some(
				(event) =>
					event.kind === 'message.delta' &&
					event.content.kind === 'text' &&
					event.content.text.length > 0
			)
		).toBe(true);
		expect(events.some((event) => event.kind === 'tool.changed')).toBe(true);
		expect(events.some((event) => event.kind === 'usage.changed')).toBe(true);
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain('sessionUpdate');
		expect(serialized).not.toContain('rawInput');
		expect(serialized).not.toContain('_meta');
	});
}
it('preserves omitted fields and distinguishes them from empty tool content', () => {
	const initial = mapTool({
		toolCallId: '1',
		title: 'Write',
		status: 'pending',
		content: [{ type: 'diff', path: '/fixture/a', oldText: null, newText: 'hello' }],
		locations: [{ path: '/fixture/a', line: 1 }],
	});
	const partial = mapTool({ toolCallId: '1', status: 'completed' });
	expect(Object.keys(partial).sort()).toEqual(['id', 'status']);
	const combined = { ...initial, ...partial };
	expect(combined.title).toBe('Write');
	expect(combined.content).toEqual([
		{ kind: 'diff', path: '/fixture/a', before: null, after: 'hello' },
	]);
	expect({ ...combined, ...mapTool({ toolCallId: '1', content: [] }) }.content).toEqual([]);
});
it('keeps boolean options and select groups as provider-supplied data', () => {
	expect(
		mapOptions([
			{ id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
			{
				id: 'custom',
				name: 'Custom',
				category: 'unknown-category',
				type: 'select',
				currentValue: 'a',
				options: [{ group: 'g', name: 'Group', options: [{ value: 'a', name: 'A' }] }],
			},
		])
	).toEqual([
		{ id: 'fast', name: 'Fast', description: null, category: null, kind: 'boolean', value: false },
		{
			id: 'custom',
			name: 'Custom',
			description: null,
			category: 'unknown-category',
			kind: 'select',
			value: 'a',
			choices: [{ value: 'a', name: 'A', description: null, group: 'Group' }],
		},
	]);
});
it('keeps message boundaries, tool references and unknown update names visible', () => {
	expect(
		mapUpdate({
			sessionUpdate: 'agent_thought_chunk',
			messageId: 'message-2',
			content: { type: 'text', text: 'thinking' },
		})
	).toEqual({
		kind: 'message.delta',
		role: 'thought',
		messageId: 'message-2',
		content: { kind: 'text', text: 'thinking' },
	});
	expect(
		mapTool({ toolCallId: 't', content: [{ type: 'terminal', terminalId: 'terminal-1' }] }).content
	).toEqual([{ kind: 'terminal', id: 'terminal-1' }]);
	expect(mapUpdate({ sessionUpdate: 'future_feature' } as unknown as SessionUpdate)).toEqual({
		kind: 'unhandled',
		name: 'future_feature',
	});
});
it('preserves raw terminal strings and does not serialize polymorphic tool references', () => {
	expect(mapTool({ toolCallId: 't', rawOutput: 'one\n\u001b[31mfailed\u001b[0m' }).output).toBe(
		'one\n\u001b[31mfailed\u001b[0m'
	);
	expect(
		mapTool({ toolCallId: 't', rawOutput: [{ type: 'tool_reference', tool_name: 'Read' }] })
	).toEqual({ id: 't' });
});

import { mapRateLimit } from './mapper';
it('reads Claude quota metadata without converting context usage into subscription limits', () => {
	expect(mapRateLimit({ sessionUpdate: 'usage_update', used: 99, size: 100 })).toBeNull();
	expect(
		mapRateLimit({
			sessionUpdate: 'usage_update',
			used: 1,
			size: 100,
			_meta: {
				'_claude/rateLimit': {
					status: 'allowed_warning',
					rateLimitType: 'five_hour',
					resetsAt: 200,
				},
			},
		})
	).toEqual({
		kind: 'rate-limit.changed',
		status: 'allowed_warning',
		window: 'five_hour',
		resetsAt: 200,
	});
	expect(
		mapRateLimit({
			sessionUpdate: 'usage_update',
			used: 1,
			size: 100,
			_meta: { '_claude/rateLimit': { status: 'invented' } },
		})
	).toBeNull();
});
it('keeps the provider tool name and exit code for the one-line tool row (spec/agents-and-providers#mapper-rules, spec/chat#tool-headline)', () => {
	expect(
		mapTool({
			toolCallId: 'c',
			title: 'pnpm test',
			kind: 'execute',
			_meta: { claudeCode: { toolName: 'Bash' } },
		})
	).toMatchObject({ name: 'Bash', title: 'pnpm test' });
	expect(
		mapTool({ toolCallId: 'c', status: 'failed', rawOutput: 'Exit code 1\nFAIL src/a.test.ts' })
	).toMatchObject({ status: 'failed', exitCode: 1, output: 'Exit code 1\nFAIL src/a.test.ts' });
	expect(
		mapTool({
			toolCallId: 'x',
			status: 'completed',
			rawOutput: { formatted_output: '', exit_code: 2 },
			_meta: { terminal_exit: { exit_code: 2, signal: null } },
		})
	).toMatchObject({ status: 'failed', exitCode: 2, output: '' });
	expect(
		mapTool({
			toolCallId: 'x',
			status: 'completed',
			rawOutput: { formatted_output: '0\n', exit_code: 0 },
		})
	).toMatchObject({ status: 'completed', exitCode: 0, output: '0\n' });
	expect(mapTool({ toolCallId: 'r', status: 'completed', rawOutput: 'plain' })).not.toHaveProperty(
		'exitCode'
	);
});
it('maps a markdown plan document and its removal; other plan forms stay unhandled (spec/chat-turns-plans-and-questions#plan-approval)', () => {
	expect(
		mapUpdate({
			sessionUpdate: 'plan_update',
			plan: { type: 'markdown', planId: 'p1', content: '# Plan\n\n1. Do it' },
		} as SessionUpdate)
	).toEqual({ kind: 'plan.document', planId: 'p1', text: '# Plan\n\n1. Do it' });
	expect(mapUpdate({ sessionUpdate: 'plan_removed', planId: 'p1' } as SessionUpdate)).toEqual({
		kind: 'plan.removed',
		planId: 'p1',
	});
	expect(
		mapUpdate({
			sessionUpdate: 'plan_update',
			plan: { type: 'file', planId: 'p2', uri: 'file:///tmp/plan.md' },
		} as SessionUpdate)
	).toEqual({ kind: 'unhandled', name: 'plan_update:file' });
});
it('marks a subagent tool with the parent tool call (spec/composer-steering-queue-and-ghost#steering-hold)', () => {
	expect(
		mapTool({
			toolCallId: 'child',
			title: 'Read',
			_meta: { claudeCode: { toolName: 'Read', parentToolUseId: 'top' } },
		})
	).toMatchObject({ id: 'child', name: 'Read', parentId: 'top' });
	expect(
		mapTool({ toolCallId: 'top', title: 'Agent', _meta: { claudeCode: { toolName: 'Agent' } } })
	).not.toHaveProperty('parentId');
});
