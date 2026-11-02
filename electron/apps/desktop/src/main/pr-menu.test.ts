import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('electron', () => ({ app: { getLocale: () => 'en' } }));
import {
	emptyReviewDraft,
	type NativeMenuItem,
	type PRMenuRow,
	type PullRequestDetail,
} from '@brigadir/core';
import { PRMenus, prMenuTemplate, type PRMenuSource, type PRMenuState } from './pr-menu';
import type { ClientUi } from './client-ui';
import type { Client } from './clients';

const open: PRMenuRow = {
	state: 'OPEN',
	head: 'feat/couriers-map',
	url: 'https://github.com/acme/mobile/pull/91',
};
const base: PRMenuState = { pr: open, drafts: 0, conflicts: false, reviewsThis: false };
/** Labels as the menu shows them: a submenu's items after `▸`, a separator as `-`. */
const labels = (items: readonly NativeMenuItem[]): string[] =>
	items.flatMap((item) =>
		!item
			? ['-']
			: item.submenu
				? [`${item.label} ▸ ${item.submenu.map((child) => child?.label).join(' / ')}`]
				: [item.label]
	);

describe('the menu of a PR list row (spec/appearance#evolution-redesign)', () => {
	it('gives an open PR its review, the agent in a submenu, then GitHub and the copies', () => {
		expect(labels(prMenuTemplate('en', base))).toEqual([
			'Start review…',
			'Review with an agent ▸ Quickly / In a worktree',
			'-',
			'Open on GitHub',
			'Copy link',
			'Copy branch name',
		]);
		const items = prMenuTemplate('en', base);
		expect(items.find((item) => item?.id === 'copy-link')?.copy).toBe(open.url);
		expect(items.find((item) => item?.id === 'copy-branch')?.copy).toBe(open.head);
		expect(
			items.find((item) => item?.id === 'agent-review')?.submenu?.map((item) => item?.id)
		).toEqual(['agent-quick', 'agent-worktree']);
		// Every top-level item has its glyph (spec/search-menus-and-commands#menu-glyphs); the submenu's ways are values, as a picker's are.
		expect(items.filter((item) => item && !item.icon)).toEqual([]);
	});
	it('continues a review with drafts, hides the agent on the PR this task reviews, offers a conflict', () => {
		expect(
			labels(prMenuTemplate('en', { ...base, drafts: 2, conflicts: true, reviewsThis: true }))
		).toEqual([
			'Continue review…',
			'Resolve conflicts…',
			'-',
			'Open on GitHub',
			'Copy link',
			'Copy branch name',
		]);
		expect(labels(prMenuTemplate('en', { ...base, pr: { ...open, state: 'DRAFT' } }))[0]).toBe(
			'Start review…'
		);
	});
	it('gives a merged or closed PR only GitHub and the copies', () => {
		for (const state of ['MERGED', 'CLOSED'] as const)
			expect(
				labels(
					prMenuTemplate('en', { ...base, pr: { ...open, state }, drafts: 3, conflicts: true })
				)
			).toEqual(['Open on GitHub', 'Copy link', 'Copy branch name']);
	});
	it('speaks Ukrainian', () => {
		expect(labels(prMenuTemplate('uk', { ...base, drafts: 1 }))).toEqual([
			'Продовжити ревʼю…',
			'Ревʼю з агентом ▸ Швидко / У worktree',
			'-',
			'Відкрити на GitHub',
			'Копіювати посилання',
			'Копіювати назву branch',
		]);
	});
});

describe('PRMenus.show', () => {
	const roots: string[] = [];
	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});
	const client = { id: 'local', local: true } as unknown as Client;
	const key = { projectId: 'p1', id: 't1' },
		ref = { scopeId: 's1', number: 91 };
	const conflicting = {
		mergeable: 'CONFLICTING',
		mergeState: 'DIRTY',
		canPush: true,
		crossRepository: false,
	} as PullRequestDetail;
	async function setup(source: Partial<PRMenuSource>, wait = 500) {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-pr-menu-'));
		roots.push(root);
		const shown: NativeMenuItem[][] = [];
		const ui = {
			menu: async (_client: Client, items: NativeMenuItem[]) => {
				shown.push(items);
				return 'agent-worktree';
			},
		} as unknown as ClientUi;
		const menus = new PRMenus(
			root,
			ui,
			{
				lastDetail: async () => null,
				detail: async () => ({ ...conflicting, mergeable: 'MERGEABLE', mergeState: 'CLEAN' }),
				readDraft: async () => emptyReviewDraft(),
				...source,
			},
			() => 'en',
			wait
		);
		return { menus, shown };
	}
	it('reads drafts and the last known conflict, and answers with the chosen item', async () => {
		const { menus, shown } = await setup({
			lastDetail: async () => conflicting,
			readDraft: async () => ({
				...emptyReviewDraft(),
				drafts: [{ id: 'd1' } as never],
			}),
		});
		expect(await menus.show(client, key, ref, open)).toBe('agent-worktree');
		expect(labels(shown[0]!).slice(0, 3)).toEqual([
			'Continue review…',
			'Review with an agent ▸ Quickly / In a worktree',
			'Resolve conflicts…',
		]);
	});
	it('does not wait for a PR nobody opened past its limit, and offers no conflict it cannot push', async () => {
		const slow = await setup({ detail: () => new Promise<PullRequestDetail>(() => {}) }, 20);
		await slow.menus.show(client, key, ref, open);
		expect(labels(slow.shown[0]!)).not.toContain('Resolve conflicts…');
		const fork = await setup({
			lastDetail: async () => ({ ...conflicting, crossRepository: true }),
		});
		await fork.menus.show(client, key, ref, open);
		expect(labels(fork.shown[0]!)).not.toContain('Resolve conflicts…');
		const fresh = await setup({ detail: async () => conflicting });
		await fresh.menus.show(client, key, ref, open);
		expect(labels(fresh.shown[0]!)).toContain('Resolve conflicts…');
	});
	it('reads nothing for a closed PR', async () => {
		const read = vi.fn(async () => conflicting);
		const { menus, shown } = await setup({ lastDetail: read, detail: read });
		await menus.show(client, key, ref, { ...open, state: 'MERGED' });
		expect(read).not.toHaveBeenCalled();
		expect(labels(shown[0]!)).toEqual(['Open on GitHub', 'Copy link', 'Copy branch name']);
	});
});
