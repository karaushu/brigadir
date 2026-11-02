import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextReport } from '@brigadir/core';
import { ContextState, type ContextDeps } from './context-state';

const key = { projectId: 'p', id: 't' };
const report: ContextReport = {
	visible: true,
	documentsShown: true,
	tabs: [{ kind: 'file', path: 'a.ts', active: true, dirty: false }],
	editor: {
		path: 'a.ts',
		view: 'editor',
		lineCount: 3,
		dirty: false,
		readOnly: false,
		cursor: { line: 2, column: 3 },
		selections: [],
		visibleLines: { start: 1, end: 3 },
	},
	diff: null,
	panel: { shown: false, tab: 'changes', changesView: 'diff' },
	pr: { scopeId: 's', number: 4, tab: 'comments' },
};
async function state(patch: Partial<ContextDeps>) {
	const dataDir = await mkdtemp(join(tmpdir(), 'brigadir-context-'));
	let asked: { id: string; key: typeof key } | null = null;
	const value = new ContextState({
		dataDir,
		send: (request) => {
			asked = request;
			return true;
		},
		visible: () => true,
		diffBase: () => 'task',
		pullRequest: async () => {
			throw new Error('GitHub is unavailable');
		},
		...patch,
	});
	return { value, asked: () => asked!, done: () => rm(dataDir, { recursive: true, force: true }) };
}
it('asks the window and answers editor_state from its report (spec/agents-and-providers#context-tools)', async () => {
	const { value, asked, done } = await state({});
	try {
		const answer = value.answer(key, 'editor');
		await Promise.resolve();
		expect(asked().key).toEqual(key);
		expect(value.settle(asked().id, report)).toBe(true);
		expect(await answer).toMatchObject({
			window: 'open',
			visible: true,
			active: { kind: 'file', path: 'a.ts', cursor: { line: 2, column: 3 } },
		});
		// A late or unknown answer is dropped.
		expect(value.settle(asked().id, report)).toBe(false);
	} finally {
		await done();
	}
});
it('answers a closed window, a closed-meanwhile window and a silent window (spec/agents-and-providers#context-tools)', async () => {
	const closed = await state({ send: () => false });
	try {
		expect(await closed.value.answer(key, 'pr')).toMatchObject({ window: 'closed', open: false });
	} finally {
		await closed.done();
	}
	const gone = await state({});
	try {
		const answer = gone.value.answer(key, 'editor');
		await Promise.resolve();
		gone.value.closeAll();
		expect(await answer).toMatchObject({ window: 'closed' });
	} finally {
		await gone.done();
	}
	const silent = await state({ timeoutMs: 20 });
	try {
		await expect(silent.value.answer(key, 'editor')).rejects.toThrow('did not answer');
	} finally {
		await silent.done();
	}
});
it('keeps the open PR when GitHub fails and says why (spec/agents-and-providers#context-tools)', async () => {
	const { value, asked, done } = await state({});
	try {
		const answer = value.answer(key, 'pr');
		await Promise.resolve();
		value.settle(asked().id, report);
		expect(await answer).toMatchObject({ open: true, number: 4, error: 'GitHub is unavailable' });
	} finally {
		await done();
	}
});
it("marks the person's own PR comments with the GitHub login main knows (spec/agents-and-providers#editor-state)", async () => {
	const { value, asked, done } = await state({
		pullRequest: async () => ({
			detail: {
				summary: { number: 4, title: 'T', head: 'f', base: 'main' },
				threads: [],
				comments: [
					{ id: 'i1', author: 'ann', body: 'Mine', createdAt: 't', url: 'u' },
					{ id: 'i2', author: 'bob', body: 'Theirs', createdAt: 't', url: 'u' },
				],
				reviews: [],
				files: [],
			} as never,
			review: { body: '', event: 'COMMENT', sendComments: true, last: null, drafts: [] },
			viewer: 'ann',
		}),
	});
	try {
		const answer = value.answer(key, 'pr');
		await Promise.resolve();
		value.settle(asked().id, report);
		expect(await answer).toMatchObject({
			viewer: 'ann',
			comments: [{ author: 'ann', mine: true }, { author: 'bob' }],
		});
		expect(((await answer) as { comments: object[] }).comments[1]).not.toHaveProperty('mine');
	} finally {
		await done();
	}
});
