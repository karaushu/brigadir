import { clipboard, ClipboardItem } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `Copy as file` (spec/notifications-slack-notes-and-schedules#note-file): the text goes to `<name>` in a temporary
 * folder of its own, and the file itself onto the clipboard — a file URL macOS pastes as a file, the URI list other
 * systems read, the path as plain text.
 */
export async function copyNoteFile(id: string, name: string, text: string) {
	const dir = join(tmpdir(), 'brigadir-notes', id);
	await mkdir(dir, { recursive: true });
	const path = join(dir, name);
	await writeFile(path, text, 'utf8');
	const url = pathToFileURL(path).href;
	await clipboard.write([
		new ClipboardItem({
			...(process.platform === 'darwin'
				? { 'electron application/osclipboard;format="public.file-url"': url }
				: { 'text/uri-list': url }),
			'text/plain': path,
		}),
	]);
}
