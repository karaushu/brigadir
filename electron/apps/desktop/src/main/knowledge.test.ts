import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { SessionStore } from '@brigadir/persistence';
import { Knowledge } from './knowledge';
test('mines across tasks without a model, requires an explicit preview and preserves concurrent file edits', async () => {
	const root = await mkdtemp(join(tmpdir(), 'knowledge-main-'));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(data),
			project = await store.addProject(repo);
		for (const title of ['First task', 'Second task']) {
			const task = await store.createTask(project.id, title, 'claude'),
				writer = await store.writer(task);
			await writer.append({ kind: 'turn.started', text: title });
			await writer.append({
				kind: 'question.requested',
				question: {
					id: 'q',
					question: 'How do we run the tests?',
					header: 'Tests',
					options: [],
					allowsFreeText: true,
					allowsMultiple: false,
				},
			});
			await writer.append({
				kind: 'question.resolved',
				id: 'q',
				answer: { labels: [], text: 'pnpm test' },
			});
			await writer.close();
		}
		let calls = 0;
		const service = new Knowledge(data, async () => {
				calls++;
				return '## Tests\nRun `pnpm test`.';
			}),
			snapshot = await service.read(project.id),
			proposal = snapshot.proposals[0]!;
		expect(snapshot.proposals).toHaveLength(1);
		expect(calls).toBe(0);
		const target = { scopeId: snapshot.scopes[0]!.id, path: 'CLAUDE.md' };
		await expect(service.add(project.id, proposal.signature, 'not-reviewed', 'x')).rejects.toThrow(
			'Review'
		);
		const preview = await service.prepare(project.id, proposal.signature, target),
			text = await service.generate(project.id, proposal.signature, preview.id);
		expect(calls).toBe(1);
		expect(preview.exists).toBe(false);
		const receipt = await service.add(project.id, proposal.signature, preview.id, text);
		expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe(text + '\n');
		expect((await new Knowledge(data).read(project.id)).receipts[0]?.id).toBe(receipt.id);
		await writeFile(join(repo, 'CLAUDE.md'), 'A foreign change\n' + text + '\n');
		await expect(service.undo(project.id, receipt.id)).rejects.toThrow('changed');
		await writeFile(join(repo, 'CLAUDE.md'), text + '\n');
		await service.undo(project.id, receipt.id);
		await expect(readFile(join(repo, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
		await service.reject(project.id, proposal.signature);
		expect((await service.read(project.id)).proposals[0]?.state).toBe('rejected');
		await service.restore(project.id, proposal.signature);
		expect((await service.read(project.id)).proposals[0]?.state).toBe('proposed');
		const stale = await service.prepare(project.id, proposal.signature, target);
		await writeFile(join(repo, 'CLAUDE.md'), 'new instruction');
		await expect(service.add(project.id, proposal.signature, stale.id, 'addition')).rejects.toThrow(
			'changed'
		);
		expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe('new instruction');
		expect((await service.read(project.id)).proposals[0]?.state).toBe('proposed');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('recovers prepared append/undo receipts and leaves unknown storage schemas unchanged', async () => {
	const root = await mkdtemp(join(tmpdir(), 'knowledge-recovery-'));
	try {
		const repo = join(root, 'repo'),
			data = join(root, 'data');
		await mkdir(repo);
		const store = await SessionStore.at(data),
			project = await store.addProject(repo),
			path = join(data, 'projects', project.id, 'knowledge.json'),
			service = new Knowledge(data);
		await service.read(project.id);
		const doc = JSON.parse(await readFile(path, 'utf8'));
		doc.proposals = [
			{
				signature: 'run test',
				tokens: ['run', 'test'],
				sources: [],
				state: 'proposed',
				createdAt: '2026-09-21',
			},
		];
		doc.receipts = [
			{
				id: 'receipt',
				signature: 'run test',
				target: { scopeId: 'root', path: 'CLAUDE.md' },
				root: project.path,
				before: null,
				after: 'Tests\n',
				added: 'Tests\n',
				phase: 'prepared',
			},
		];
		await writeFile(join(repo, 'CLAUDE.md'), 'Tests\n');
		await writeFile(path, JSON.stringify(doc));
		expect((await service.read(project.id)).proposals[0]?.state).toBe('added');
		const saved = JSON.parse(await readFile(path, 'utf8'));
		saved.receipts[0].phase = 'undoing';
		await writeFile(path, JSON.stringify(saved));
		await rm(join(repo, 'CLAUDE.md'));
		expect((await service.read(project.id)).proposals[0]?.state).toBe('proposed');
		const future = JSON.stringify({ schemaVersion: 2, secret: 'keep' });
		await writeFile(path, future);
		await expect(service.read(project.id)).rejects.toThrow('unsupported_schema');
		expect(await readFile(path, 'utf8')).toBe(future);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
import { git } from '@brigadir/git';
test('retains the project root and resolves an explicitly selected nested repository', async () => {
	const root = await mkdtemp(join(tmpdir(), 'knowledge-scopes-'));
	try {
		const repo = join(root, 'repo'),
			nested = join(repo, 'nested'),
			data = join(root, 'data');
		await mkdir(nested, { recursive: true });
		await git(nested, ['init', '-b', 'main']);
		const store = await SessionStore.at(data),
			project = await store.addProject(repo),
			service = new Knowledge(data),
			first = await service.read(project.id);
		expect(first.scopes.map((scope) => scope.name)).toEqual(['.', 'nested']);
		const path = join(data, 'projects', project.id, 'knowledge.json'),
			doc = JSON.parse(await readFile(path, 'utf8'));
		doc.proposals = [
			{
				signature: 'run test',
				tokens: ['run', 'test'],
				sources: [],
				state: 'proposed',
				createdAt: '2026-09-21',
			},
		];
		await writeFile(path, JSON.stringify(doc));
		const preview = await service.prepare(project.id, 'run test', {
				scopeId: first.scopes[1]!.id,
				path: 'CLAUDE.md',
			}),
			receipt = await service.add(project.id, 'run test', preview.id, 'Nested instruction');
		expect(await readFile(join(nested, 'CLAUDE.md'), 'utf8')).toBe('Nested instruction\n');
		await expect(readFile(join(repo, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
		await service.undo(project.id, receipt.id);
		await expect(readFile(join(nested, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
