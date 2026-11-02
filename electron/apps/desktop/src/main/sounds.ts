import { execFile } from 'node:child_process';
import { access, constants, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, parse } from 'node:path';
import { isSoundName } from '@brigadir/core';
import type { SoundPlayer } from './notifications';
/**
 * spec/sidebar#layout: only sounds already installed on this computer; nothing bundled, nothing hardcoded. macOS: the system sounds
 * (`.aiff`). Linux (spec/architecture-and-platform#linux-package): the freedesktop sound theme every desktop ships (`.oga`, `.ogg`, `.wav`).
 */
export const soundDirectories = (platform: NodeJS.Platform = process.platform) =>
	platform === 'darwin'
		? ['/System/Library/Sounds', '/Library/Sounds', join(homedir(), 'Library/Sounds')]
		: platform === 'linux'
			? [
					'/usr/share/sounds/freedesktop/stereo',
					'/usr/local/share/sounds/freedesktop/stereo',
					join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'sounds'),
				]
			: [];
const extensions = (platform: NodeJS.Platform) =>
	platform === 'darwin' ? ['.aiff'] : ['.oga', '.ogg', '.wav'];
/**
 * The defaults are macOS names (`Ping`, `Tink`, `Basso`, core/notifications.ts); on Linux they sound as the freedesktop
 * sounds of the same meaning when the theme has no file of that name.
 */
export const linuxSoundAliases: Readonly<Record<string, string>> = {
	Ping: 'message-new-instant',
	Tink: 'complete',
	Basso: 'dialog-warning',
};
/** Linux players in the order tried: PipeWire, PulseAudio, libcanberra. Each plays a file given as its last argument. */
export const linuxPlayers: readonly { command: string; args: string[] }[] = [
	{ command: 'pw-play', args: [] },
	{ command: 'paplay', args: [] },
	{ command: 'canberra-gtk-play', args: ['-f'] },
];
async function onPath(name: string, path = process.env.PATH ?? '') {
	for (const directory of path.split(delimiter).filter(Boolean))
		try {
			await access(join(directory, name), constants.X_OK);
			return join(directory, name);
		} catch {
			/* next */
		}
	return null;
}
/** The first Linux player on PATH, as the command and its arguments before the file; null without one. */
export async function linuxPlayer(
	find: (name: string) => Promise<string | null> = onPath
): Promise<{ command: string; args: string[] } | null> {
	for (const player of linuxPlayers) {
		const command = await find(player.command);
		if (command) return { command, args: player.args };
	}
	return null;
}
export class Sounds implements SoundPlayer {
	private player: Promise<{ command: string; args: string[] } | null> | null = null;
	constructor(
		private directories: () => string[] = soundDirectories,
		private launch?: (path: string) => void,
		private platform: NodeJS.Platform = process.platform,
		private findPlayer: () => Promise<{ command: string; args: string[] } | null> = linuxPlayer
	) {}
	/** Later directories win, matching NSSound(named:) lookup order for user overrides. */
	async catalog(): Promise<Map<string, string>> {
		const sounds = new Map<string, string>();
		const wanted = extensions(this.platform);
		for (const directory of this.directories()) {
			let entries: string[] = [];
			try {
				entries = await readdir(directory);
			} catch {
				continue;
			}
			for (const entry of entries) {
				const { name, ext } = parse(entry);
				if (wanted.includes(ext.toLowerCase()) && isSoundName(name))
					sounds.set(name, join(directory, entry));
			}
		}
		return sounds;
	}
	async names() {
		return [...(await this.catalog()).keys()].sort((a, b) => a.localeCompare(b));
	}
	/** Missing sounds stay silent; playback never depends on notification authorization. */
	async playNamed(name: string) {
		if ((this.platform !== 'darwin' && this.platform !== 'linux') || !isSoundName(name))
			return false;
		const catalog = await this.catalog();
		const path =
			catalog.get(name) ??
			(this.platform === 'linux' && linuxSoundAliases[name]
				? catalog.get(linuxSoundAliases[name])
				: undefined);
		if (!path) return false;
		if (this.launch) {
			this.launch(path);
			return true;
		}
		if (this.platform === 'darwin') {
			execFile('/usr/bin/afplay', [path], { timeout: 15000 }, () => {}).unref();
			return true;
		}
		const player = await (this.player ??= this.findPlayer());
		if (!player) return false;
		execFile(player.command, [...player.args, path], { timeout: 15000 }, () => {}).unref();
		return true;
	}
	play(name: string) {
		void this.playNamed(name).catch(() => {});
	}
}
