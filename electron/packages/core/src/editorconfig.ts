import { isIndentWidth, type ProjectIndent } from './indent';
/** spec/editor#indentation: the indentation keys of `.editorconfig`; pure, the caller reads the files. Other keys are not our business. */
export type EditorConfigSection = { glob: string; props: Record<string, string> };
export type EditorConfig = { root: boolean; sections: EditorConfigSection[] };
export function parseEditorConfig(text: string): EditorConfig {
	const config: EditorConfig = { root: false, sections: [] };
	let section: EditorConfigSection | null = null;
	for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const header = /^\[(.+)\]$/.exec(line);
		if (header) {
			section = { glob: header[1]!, props: {} };
			config.sections.push(section);
			continue;
		}
		const pair = /^([^=:]+?)\s*[=:]\s*(.*?)\s*$/.exec(line);
		if (!pair) continue;
		const key = pair[1]!.toLowerCase(),
			value = pair[2]!.replace(/\s+[#;].*$/, '').toLowerCase();
		if (section) section.props[key] = value;
		else if (key === 'root') config.root = value === 'true';
	}
	return config;
}
/** The glob dialect of the spec: `*`, `**`, `?`, `[set]`, `[!set]`, `{a,b}`, `{1..3}`; without `/` it matches at any depth. */
export function editorConfigGlob(glob: string): RegExp {
	const anchored = glob.includes('/');
	const body = anchored ? glob.replace(/^\//, '') : glob;
	const convert = (text: string): string => {
		let out = '',
			depth = 0;
		for (let i = 0; i < text.length; i++) {
			const c = text[i]!;
			if (c === '\\' && i + 1 < text.length) {
				out += text[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
				continue;
			}
			if (c === '*') {
				if (text[i + 1] === '*') {
					out += '.*';
					i++;
				} else out += '[^/]*';
				continue;
			}
			if (c === '?') {
				out += '[^/]';
				continue;
			}
			if (c === '[') {
				const end = text.indexOf(']', i + 2);
				if (end > 0) {
					const set = text.slice(i + 1, end);
					out += `[${set.startsWith('!') ? '^' + set.slice(1) : set}]`;
					i = end;
					continue;
				}
				out += '\\[';
				continue;
			}
			if (c === '{') {
				const end = text.indexOf('}', i);
				const inner = end > 0 ? text.slice(i + 1, end) : '';
				const range = /^(-?\d+)\.\.(-?\d+)$/.exec(inner);
				if (range) {
					out +=
						'(?:' +
						Array.from({ length: Math.min(1000, Math.abs(+range[2]! - +range[1]!) + 1) }, (_, n) =>
							String(Math.min(+range[1]!, +range[2]!) + n)
						).join('|') +
						')';
					i = end;
					continue;
				}
				if (end > 0 && /,/.test(inner) && !inner.includes('{')) {
					out += '(?:' + inner.split(',').map(convert).join('|') + ')';
					i = end;
					continue;
				}
				out += '\\{';
				depth++;
				continue;
			}
			if (c === '}' && depth > 0) {
				out += '\\}';
				depth--;
				continue;
			}
			out += c.replace(/[.+^${}()|\\/]/g, '\\$&');
		}
		return out;
	};
	return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${convert(body)}$`);
}
const width = (value: string | undefined) => {
	const n = value && /^\d+$/.test(value) ? Number(value) : NaN;
	return isIndentWidth(n) ? n : undefined;
};
/**
 * The indentation `.editorconfig` files give `relative`; `files` are the config files from the file's own directory
 * up, each with the path of the file relative to the config's directory. A `root = true` file ends the climb.
 */
export function editorConfigIndent(
	files: { text: string; relative: string }[]
): ProjectIndent | null {
	const chain: { config: EditorConfig; relative: string }[] = [];
	for (const file of files) {
		const config = parseEditorConfig(file.text);
		chain.push({ config, relative: file.relative });
		if (config.root) break;
	}
	const props: Record<string, string> = {};
	for (const { config, relative } of chain.reverse())
		for (const section of config.sections)
			if (editorConfigGlob(section.glob).test(relative)) Object.assign(props, section.props);
	const style = props.indent_style,
		size = props.indent_size,
		tab = width(props.tab_width);
	const useTabs = style === 'tab' ? true : style === 'space' ? false : undefined;
	const indentSize = size === 'tab' ? tab : width(size);
	const tabWidth = tab ?? (size === 'tab' ? undefined : width(size));
	if (useTabs === undefined && indentSize === undefined && tabWidth === undefined) return null;
	return {
		source: 'editorconfig',
		...(useTabs === undefined ? {} : { useTabs }),
		...(tabWidth === undefined ? {} : { tabWidth }),
		...(indentSize === undefined ? {} : { indentSize }),
	};
}
