import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxPlayer, Sounds, soundDirectories } from './sounds';
it('lists only installed .aiff sounds, lets user folders override system ones and plays by name only', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-sounds-'));
	try {
		const system = join(root, 'system'),
			user = join(root, 'user');
		await mkdir(system);
		await mkdir(user);
		await writeFile(join(system, 'Ping.aiff'), '');
		await writeFile(join(system, 'Basso.AIFF'), '');
		await writeFile(join(system, 'Readme.txt'), '');
		await writeFile(join(system, 'bad name;.aiff'), '');
		await writeFile(join(user, 'Ping.aiff'), '');
		await writeFile(join(user, 'Custom.aiff'), '');
		const played: string[] = [];
		const sounds = new Sounds(
			() => [system, join(root, 'missing'), user],
			(path) => {
				played.push(path);
			},
			'darwin'
		);
		expect(await sounds.names()).toEqual(['Basso', 'Custom', 'Ping']);
		expect(await sounds.playNamed('Ping')).toBe(true);
		expect(played).toEqual([join(user, 'Ping.aiff')]);
		expect(await sounds.playNamed('Unknown')).toBe(false);
		expect(await sounds.playNamed('../Ping')).toBe(false);
		expect(await sounds.playNamed(join(system, 'Ping.aiff'))).toBe(false);
		expect(played).toHaveLength(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
// spec/architecture-and-platform#linux-package: the freedesktop sound theme on Linux; the macOS defaults sound as the theme's sounds of the same meaning.
it('lists the freedesktop theme on Linux and plays the defaults by their Linux names', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-sounds-linux-'));
	try {
		const theme = join(root, 'stereo'),
			user = join(root, 'user');
		await mkdir(theme);
		await mkdir(user);
		for (const name of [
			'message-new-instant.oga',
			'complete.oga',
			'dialog-warning.oga',
			'bell.ogg',
		])
			await writeFile(join(theme, name), '');
		await writeFile(join(theme, 'Ping.aiff'), '');
		await writeFile(join(user, 'complete.wav'), '');
		const played: string[] = [];
		const sounds = new Sounds(
			() => [theme, user],
			(path) => played.push(path),
			'linux'
		);
		expect(await sounds.names()).toEqual([
			'bell',
			'complete',
			'dialog-warning',
			'message-new-instant',
		]);
		expect(await sounds.playNamed('Ping')).toBe(true);
		expect(await sounds.playNamed('Tink')).toBe(true);
		expect(await sounds.playNamed('Basso')).toBe(true);
		expect(await sounds.playNamed('bell')).toBe(true);
		expect(await sounds.playNamed('Glass')).toBe(false);
		expect(played).toEqual([
			join(theme, 'message-new-instant.oga'),
			join(user, 'complete.wav'),
			join(theme, 'dialog-warning.oga'),
			join(theme, 'bell.ogg'),
		]);
		expect(soundDirectories('linux')[0]).toBe('/usr/share/sounds/freedesktop/stereo');
		expect(soundDirectories('win32')).toEqual([]);
		// Without any player the sound stays silent and the preview says it could not play.
		const silent = new Sounds(
			() => [theme],
			undefined,
			'linux',
			async () => null
		);
		expect(await silent.playNamed('Ping')).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('takes the first Linux player found: PipeWire, then PulseAudio, then libcanberra', async () => {
	const having =
		(...names: string[]) =>
		async (name: string) =>
			names.includes(name) ? `/usr/bin/${name}` : null;
	expect(await linuxPlayer(having('paplay', 'pw-play'))).toEqual({
		command: '/usr/bin/pw-play',
		args: [],
	});
	expect(await linuxPlayer(having('canberra-gtk-play'))).toEqual({
		command: '/usr/bin/canberra-gtk-play',
		args: ['-f'],
	});
	expect(await linuxPlayer(having())).toBeNull();
});
