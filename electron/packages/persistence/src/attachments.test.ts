import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Attachments, SessionStore } from './index';
it('keeps task attachments bounded, checks integrity and refuses cross-task IDs and links', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-attachments-'));
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(join(root, 'data'));
		const project = await store.addProject(repo);
		const task = await store.createTask(project.id, 'fixture', 'claude');
		const other = await store.createTask(project.id, 'other', 'claude');
		const assets = new Attachments(store);
		const item = await assets.create(task, { kind: 'text', name: 'Build output', text: 'error' });
		expect((await assets.read(task, item.id)).input).toEqual({
			kind: 'text',
			name: 'Build output',
			text: 'error',
		});
		await expect(assets.read(other, item.id)).rejects.toThrow();
		await expect(assets.read(task, '../../outside')).rejects.toThrow('Invalid');
		await expect(
			assets.create(task, { kind: 'text', name: 'large', text: 'я'.repeat(256 * 1024) })
		).rejects.toThrow('large');
		await expect(
			assets.create(task, { kind: 'image', name: 'invalid', mimeType: 'image/png', data: 'AAAA' })
		).rejects.toThrow('PNG');
		await expect(assets.resolve(task, Array(11).fill(item.id))).rejects.toThrow();
		const path = (await assets.read(task, item.id)).path;
		await writeFile(path, 'other');
		await expect(assets.read(task, item.id)).rejects.toThrow('changed');
		await rm(path);
		await symlink(join(repo, 'secret'), path);
		await expect(assets.read(task, item.id)).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
// spec/chat#images: tiles read a cached thumbnail; a gone or changed image fails as the full read does; a file reference keeps its file size.
it('caches a thumbnail beside a verified image and refuses it once the image is gone or changed', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-thumbnails-'));
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(join(root, 'data'));
		const project = await store.addProject(repo);
		const task = await store.createTask(project.id, 'fixture', 'claude');
		const assets = new Attachments(store);
		const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'),
			thumb = Buffer.concat([png.subarray(0, 8), Buffer.from('thumb')]);
		const image = await assets.create(task, {
			kind: 'image',
			name: 'Pasted image',
			mimeType: 'image/png',
			data: png.toString('base64'),
		});
		let calls = 0;
		const make = (bytes: Buffer) => {
			calls++;
			expect(bytes.equals(png)).toBe(true);
			return thumb;
		};
		expect((await assets.thumbnail(task, image.id, make)).equals(thumb)).toBe(true);
		expect((await assets.thumbnail(task, image.id, make)).equals(thumb)).toBe(true);
		expect(calls).toBe(1);
		const text = await assets.create(task, {
			kind: 'text',
			name: 'notes.txt',
			text: 'File reference',
			fileBytes: 12345,
		});
		expect(text.fileBytes).toBe(12345);
		await expect(assets.thumbnail(task, text.id, make)).rejects.toThrow('Invalid');
		const path = (await assets.read(task, image.id)).path;
		await writeFile(path, Buffer.concat([png, Buffer.from('x')]));
		await expect(assets.thumbnail(task, image.id, make)).rejects.toThrow('changed');
		await rm(path);
		await expect(assets.thumbnail(task, image.id, make)).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('keeps a chat’s attachments in its own folder, only while the chat exists (spec/composer#chat-composer)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-chat-attachments-'));
	try {
		const store = await SessionStore.at(join(root, 'data'));
		const assets = new Attachments(store);
		const chat = { chat: 'brigadir' as const, id: '0b1c2d3e-0000-4000-8000-000000000001' },
			note = { chat: 'note' as const, id: 'note-abc' };
		await expect(assets.create(chat, { kind: 'text', name: 'a', text: 'b' })).rejects.toThrow(
			'gone'
		);
		await expect(assets.create(note, { kind: 'text', name: 'a', text: 'b' })).rejects.toThrow(
			'gone'
		);
		await mkdir(join(store.root, 'assistant', 'chats', chat.id), { recursive: true });
		await writeFile(join(store.root, 'assistant', 'chats', chat.id, 'chat.json'), '{}');
		await mkdir(join(store.root, 'notes'), { recursive: true });
		await writeFile(join(store.root, 'notes', 'note-abc.md'), '# A');
		const one = await assets.create(chat, { kind: 'text', name: 'a.ts', text: 'ref' }),
			two = await assets.create(note, { kind: 'text', name: 'b.ts', text: 'ref' });
		expect((await assets.read(chat, one.id)).path).toContain(
			join('assistant', 'chats', chat.id, 'attachments', one.id)
		);
		expect((await assets.read(note, two.id)).path).toContain(
			join('notes', 'note-abc', 'attachments', two.id)
		);
		await expect(assets.read(note, one.id)).rejects.toThrow();
		await expect(
			assets.create({ chat: 'brigadir', id: '../x' } as never, {
				kind: 'text',
				name: 'a',
				text: 'b',
			})
		).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
