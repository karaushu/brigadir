import { describe, expect, it } from 'vitest';
import {
	contextOnly,
	inTask,
	isScopeChoice,
	normalizeScopeChoice,
	scopeSelected,
	snapshotted,
	watched,
	writableByAgent,
} from './index';

const id = '0123456789abcdef';

describe('spec/projects-and-board#repo-selection: repo або в задачі, або ні', () => {
	it('виводить три ролі з одного selected і не плутає теку без git із repo', () => {
		expect(inTask({ kind: 'root', selected: true })).toBe(true);
		expect(watched({ kind: 'nested', selected: false })).toBe(true);
		expect(inTask({ kind: 'folder', selected: true })).toBe(false);
		expect(contextOnly({ kind: 'folder', selected: true })).toBe(true);
		expect(contextOnly({ kind: 'folder', selected: false })).toBe(false);
		expect(watched({ kind: 'folder', selected: false })).toBe(false);
	});
	it('пише лише в обране git-repo, яке є на місці', () => {
		expect(writableByAgent({ kind: 'external', selected: true })).toBe(true);
		expect(writableByAgent({ kind: 'external', selected: true, available: false })).toBe(false);
		expect(writableByAgent({ kind: 'folder', selected: true })).toBe(false);
		expect(writableByAgent({ kind: 'root', selected: false })).toBe(false);
	});
	it('знімає снапшот із кожного git-repo, обраного й ні, але не з теки без git', () => {
		expect(snapshotted({ kind: 'root', selected: false })).toBe(true);
		expect(snapshotted({ kind: 'folder', selected: true })).toBe(false);
		expect(snapshotted({ kind: 'nested', selected: true, available: false })).toBe(false);
	});
});

describe('spec/projects-and-board#repo-selection: міграція старої пари прапорців', () => {
	it('читає обидві форми, а запис без жодної відкидає', () => {
		expect(isScopeChoice({ id, name: '.', selected: true })).toBe(true);
		expect(isScopeChoice({ id, name: '.', diffEnabled: true, agentWritable: false })).toBe(true);
		expect(isScopeChoice({ id, name: '.' })).toBe(false);
		expect(isScopeChoice({ id, name: 'x', kind: 'folder', selected: true, path: '/tmp/x' })).toBe(
			true
		);
		expect(isScopeChoice({ id, name: 'x', kind: 'unknown', selected: true })).toBe(false);
	});
	it('вибір дорівнює праву запису: показ без права стає необраним, право без показу — обраним', () => {
		expect(scopeSelected({ agentWritable: false })).toBe(false);
		expect(
			normalizeScopeChoice({ id, name: '.', diffEnabled: true, agentWritable: false } as never)
		).toEqual({ id, name: '.', selected: false });
		expect(
			normalizeScopeChoice({ id, name: '.', diffEnabled: false, agentWritable: true } as never)
		).toEqual({ id, name: '.', selected: true });
		expect(normalizeScopeChoice({ id, name: '.', selected: true })).toEqual({
			id,
			name: '.',
			selected: true,
		});
	});
});
