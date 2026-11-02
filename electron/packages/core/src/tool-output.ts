import type { ToolPatch } from './agent';
export const toolOutputLimit = 128 * 1024;
export function toolOutput(tool: ToolPatch): {
	text: string;
	truncated: boolean;
	unavailable: boolean;
} {
	const raw =
		tool.output ??
		tool.content
			?.flatMap((content) =>
				content.kind === 'text'
					? [
							content.text.replace(
								/^```(?:console|bash|sh|shell|text)?\r?\n([\s\S]*?)\r?\n```\s*$/,
								'$1'
							),
						]
					: []
			)
			.join('\n') ??
		'';
	let from = raw.length,
		bytes = 0;
	while (from > 0) {
		const code = raw.charCodeAt(from - 1),
			previous = raw.charCodeAt(from - 2),
			pair = code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff,
			cost = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
		if (bytes + cost > toolOutputLimit) break;
		bytes += cost;
		from -= pair ? 2 : 1;
	}
	return {
		text: raw.slice(from),
		truncated: from > 0,
		unavailable: !raw && Boolean(tool.content?.some((content) => content.kind === 'terminal')),
	};
}
/** One-line row header (spec/agents-and-providers#mapper-rules, spec/chat#tool-headline): the tool's own name, then the target — the first non-empty title line without the name — and how many lines follow. */
export function toolHeadline(tool: ToolPatch): {
	name: string | null;
	target: string;
	extraLines: number;
} {
	const lines = (tool.title ?? tool.id).split(/\r?\n/),
		first = lines.findIndex((line) => line.trim()),
		headline = first < 0 ? '' : lines[first]!.trim();
	let last = lines.length;
	while (last > first + 1 && !lines[last - 1]!.trim()) last--;
	const name = tool.name ?? null,
		target =
			name && headline === name
				? ''
				: name && headline.startsWith(`${name} `)
					? headline.slice(name.length + 1).trimStart()
					: headline;
	return {
		name,
		target: target.replace(/^`([^`]+)`$/, '$1'),
		extraLines: first < 0 ? 0 : last - first - 1,
	};
}
