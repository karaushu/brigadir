import { describe, expect, it } from 'vitest';
import { allTab, mentionView, nextTab, type MentionGroup } from './mention-tabs';

const groups: MentionGroup[] = [
	{
		id: 'files',
		label: 'Files',
		items: [
			{ key: 'f1', label: 'Button.tsx' },
			{ key: 'f2', label: 'ButtonGroup.tsx' },
		],
	},
	{ id: 'tasks', label: 'Tasks', items: [{ key: 't1', label: 'Split kit exports' }] },
	{
		id: 'models',
		label: 'Models',
		items: [
			{ key: 'm1', label: 'claude-opus-5', section: 'Claude' },
			{ key: 'm2', label: 'gpt-5.5', section: 'Codex' },
		],
	},
];
describe('spec/composer#mentions: вкладки меню @', () => {
	it('«Усі» першою з сумою, далі групи зі своїми лічильниками', () => {
		const view = mentionView(groups, allTab, 'All');
		expect(view.tabs).toEqual([
			{ id: 'all', label: 'All', count: 5 },
			{ id: 'files', label: 'Files', count: 2 },
			{ id: 'tasks', label: 'Tasks', count: 1 },
			{ id: 'models', label: 'Models', count: 2 },
		]);
		expect(view.items.map((item) => `${item.group}/${item.label}`)).toEqual([
			'Files/Button.tsx',
			'Files/ButtonGroup.tsx',
			'Tasks/Split kit exports',
			'Models · Claude/claude-opus-5',
			'Models · Codex/gpt-5.5',
		]);
	});
	it('у вкладці групи лишаються лише підзаголовки', () => {
		expect(mentionView(groups, 'tasks', 'All').items.map((item) => item.group)).toEqual(['']);
		expect(mentionView(groups, 'models', 'All').items.map((item) => item.group)).toEqual([
			'Claude',
			'Codex',
		]);
	});
	it('одна група — без вкладок, з підписом групи', () => {
		const view = mentionView(
			[{ id: 'commands', label: 'Slash commands', items: [{ key: 'c', label: '/compact' }] }],
			allTab,
			'All'
		);
		expect(view.tabs).toBeNull();
		expect(view.items[0]!.group).toBe('Slash commands');
	});
	it('порожня вкладка показує статус групи, що вантажиться', () => {
		const loading = [
			{ id: 'files', label: 'Files', items: [], status: 'Searching…' },
			{ id: 'tasks', label: 'Tasks', items: [] },
		];
		expect(mentionView(loading, 'files', 'All').status).toBe('Searching…');
		expect(mentionView(loading, allTab, 'All').status).toBe('Searching…');
		expect(mentionView(loading, 'tasks', 'All').status).toBeNull();
	});
	it('Tab і ⇧Tab ідуть по колу', () => {
		const tabs = mentionView(groups, allTab, 'All').tabs;
		expect(nextTab(tabs, 'all', 1)).toBe('files');
		expect(nextTab(tabs, 'models', 1)).toBe('all');
		expect(nextTab(tabs, 'all', -1)).toBe('models');
	});
});
