import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceMoveEvent } from '@brigadir/core';
import { WorkspaceMoveRow } from './Crew';

/** spec/crew#auto-move: the `workspace` row names what the move's restart stopped and what started again. */
const event = (state: 'moved' | 'failed'): WorkspaceMoveEvent => ({
	kind: 'workspace.move',
	id: 'm1',
	hireId: 'h1',
	state,
	repos: ['shop'],
	...(state === 'moved' ? { branch: 'brigadir/client-details', base: 'main', stayed: [] } : {}),
	...(state === 'failed' ? { message: 'Setup command failed' } : {}),
	stopped: [
		{ kind: 'command', name: 'Metro', restarted: true },
		{ kind: 'console', name: 'zsh' },
		{ kind: 'background', name: 'tsc --watch' },
	],
});
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

it('names what stopped with the move and the saved command that started again', () => {
	for (const state of ['moved', 'failed'] as const) {
		const html = renderToStaticMarkup(
			<WorkspaceMoveRow event={event(state)} owner={undefined} locale="en" />
		);
		expect(text(html)).toContain('Metro · command · started again');
		expect(text(html)).toContain('zsh · console · stopped');
		expect(text(html)).toContain('tsc --watch · in the background · stopped');
	}
	const uk = renderToStaticMarkup(
		<WorkspaceMoveRow event={event('moved')} owner={undefined} locale="uk" />
	);
	expect(text(uk)).toContain('Metro · команда · запущено знову');
	expect(text(uk)).toContain('zsh · консоль · зупинено');
	expect(
		renderToStaticMarkup(
			<WorkspaceMoveRow event={{ ...event('moved'), stopped: [] }} owner={undefined} locale="en" />
		)
	).not.toContain('data-move-stopped');
});
