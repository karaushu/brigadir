import { it, expect } from 'vitest';
import { toolHeadline, toolOutput, toolOutputLimit } from './tool-output';
import { formatDuration } from './duration';
it('keeps one terminal output source and bounds the UTF-8 tail without splitting characters', () => {
	expect(
		toolOutput({
			id: 't',
			output: 'one\n',
			content: [{ kind: 'text', text: '```console\none\n```' }],
		})
	).toEqual({ text: 'one\n', truncated: false, unavailable: false });
	expect(
		toolOutput({ id: 't', content: [{ kind: 'text', text: '```console\nfirst\nlast\n```' }] }).text
	).toBe('first\nlast');
	const text = 'prefix' + '🙂'.repeat(40000) + 'Кінець',
		output = toolOutput({ id: 't', output: text });
	expect(output.truncated).toBe(true);
	expect(output.text.endsWith('Кінець')).toBe(true);
	expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(toolOutputLimit);
	expect(output.text).not.toContain('�');
	expect(output.text.charCodeAt(0)).toBe(0xd83d);
	expect(
		toolOutput({ id: 't', content: [{ kind: 'terminal', id: 'unadvertised' }] })
	).toMatchObject({ text: '', unavailable: true });
});
it('formats durations in their compact English and localized Ukrainian registers', () => {
	expect([600, 8400, 12000, 124000, 3600000].map((value) => formatDuration('en', value))).toEqual([
		'600ms',
		'8.4s',
		'12s',
		'2m 4s',
		'1h',
	]);
	expect(formatDuration('uk', 8400)).toBe('8,4\u202fс');
	expect(formatDuration('uk', 124000)).toBe('2\u202fхв 4\u202fс');
	expect(formatDuration('en', -1)).toBe('0ms');
});
it('builds a one-line tool header from the name and the first title line (spec/agents-and-providers#mapper-rules, spec/chat#tool-headline)', () => {
	expect(toolHeadline({ id: 't', name: 'Bash', title: 'pnpm --filter kit test' })).toEqual({
		name: 'Bash',
		target: 'pnpm --filter kit test',
		extraLines: 0,
	});
	expect(toolHeadline({ id: 't', name: 'Edit', title: 'Edit `kit/src/Button.css`' })).toEqual({
		name: 'Edit',
		target: 'kit/src/Button.css',
		extraLines: 0,
	});
	expect(toolHeadline({ id: 't', name: 'Read', title: 'Read' })).toMatchObject({ target: '' });
	expect(
		toolHeadline({
			id: 't',
			title:
				"\ncat <<'EOF' > kit/src/tokens/focus.ts\nexport const ring = 2;\nexport const offset = 2;\nEOF\n\n",
		})
	).toEqual({ name: null, target: "cat <<'EOF' > kit/src/tokens/focus.ts", extraLines: 3 });
	expect(toolHeadline({ id: 't' })).toEqual({ name: null, target: 't', extraLines: 0 });
});
