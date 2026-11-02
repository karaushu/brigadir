export type FilePathText = { text: string; literal: boolean };
export type FilePathCandidate = { from: number; to: number; path: string; line: number | null };
/** `path` is the project-relative target that main found, not the text as written (`Header/index.tsx` → `src/…/Header/index.tsx`).
 *  `folder`: the path is a folder of the task (spec/chat#folder-links), shown in Files; `parents` are the IDs of the folders above it, top first. */
export type FilePathLink = FilePathCandidate & { id: string; folder?: { parents: string[] } };
/** Lexical candidates only. Existence and containment belong to main. */
export function filePathCandidates(text: string, literal = false): FilePathCandidate[] {
	const result: FilePathCandidate[] = [];
	function add(raw: string, from: number, explicit: boolean) {
		const trimmed = raw.trim();
		from += raw.indexOf(trimmed);
		let value = trimmed.replace(/[.,;!?]+$/, '');
		if (value.startsWith('@')) {
			value = value.slice(1);
			from++;
		}
		if (
			!value ||
			value.length > 4096 ||
			/[\0\r\n<>|@]/.test(value) ||
			/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
			(/^[a-z][a-z0-9+.-]*:/i.test(value) && !/:\d+(?::\d+)?$/.test(value))
		)
			return;
		const suffix = /:(\d+)(?::\d+)?$/.exec(value),
			path = suffix ? value.slice(0, suffix.index) : value,
			line = suffix ? Number(suffix[1]) : null;
		if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return;
		if (
			(line !== null && (!Number.isSafeInteger(line) || line < 1)) ||
			path.split('/').includes('..') ||
			!/[\p{L}_]/u.test(path)
		)
			return;
		if (!explicit && !path.includes('/') && !/\.[a-z][a-z0-9_-]{0,15}$/i.test(path)) return;
		result.push({ from, to: from + value.length, path, line });
	}
	if (literal) add(text, 0, true);
	const pattern = /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|([^\s<>"'`()[\]{},;!?]+)/gu;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) && result.length < 64) {
		const quoted = match[1] ?? match[2] ?? match[3];
		add(quoted ?? match[4]!, match.index + (quoted !== undefined ? 1 : 0), quoted !== undefined);
	}
	return result
		.sort((a, b) => a.from - b.from || b.to - a.to)
		.filter(
			(item, index, all) =>
				!all
					.slice(0, index)
					.some((previous) => previous.from === item.from && previous.to === item.to)
		);
}
