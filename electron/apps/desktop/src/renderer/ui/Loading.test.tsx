import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Delayed, LoadingPlaceholder, SkeletonBoard, SkeletonRows, SkeletonText } from './Loading';

it('shows no skeleton before the 150 ms threshold (spec/appearance#loading)', () => {
	expect(renderToStaticMarkup(<SkeletonRows count={3} />)).toBe('');
	expect(renderToStaticMarkup(<SkeletonBoard columns={['A', 'B']} label="Tasks" />)).toBe('');
	expect(renderToStaticMarkup(<LoadingPlaceholder label="Reading" />)).toBe('');
	expect(renderToStaticMarkup(<Delayed>late</Delayed>)).toBe('');
	expect(renderToStaticMarkup(<SkeletonText />)).toBe('');
});

it('draws rows of the given height and a board of headed columns with cards at once when asked', () => {
	const rows = renderToStaticMarkup(<SkeletonRows count={2} height={46} delay={0} />);
	expect(rows.match(/height:46px/g)).toHaveLength(2);
	const board = renderToStaticMarkup(
		<SkeletonBoard columns={['Backlog', 'In progress', 'Completed']} label="Tasks" delay={0} />
	);
	expect(board).toContain('role="status"');
	expect(board).toContain('aria-label="Tasks"');
	expect(board).toContain('aria-busy="true"');
	for (const heading of ['Backlog', 'In progress', 'Completed'])
		expect(board).toContain(`>${heading}<`);
	expect(renderToStaticMarkup(<Delayed delay={0}>now</Delayed>)).toBe('now');
});

it('draws a panel as text bars, named for assistive tech only when it is the only sign of the wait', () => {
	const named = renderToStaticMarkup(<SkeletonText lines={4} label="Diff" delay={0} />);
	expect(named.match(/<i /g)).toHaveLength(4);
	expect(named).toContain('role="status"');
	expect(named).toContain('aria-label="Diff"');
	expect(renderToStaticMarkup(<SkeletonText lines={2} delay={0} />)).toContain(
		'aria-hidden="true"'
	);
});
