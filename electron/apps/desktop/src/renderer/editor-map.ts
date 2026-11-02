import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { t, type GutterHunk, type Locale } from '@brigadir/core';
import { changePlaces, goToChange, type Placed } from './editor-gutter';
import { findMatches, findStatus } from './editor-find';

/**
 * spec/editor#editor-chrome (spec/appearance#evolution-redesign): the change map — a 12 px strip right of the code over the whole file: added, changed
 * and deleted ranges against the diff base, the visible part as a grey band, the find matches beside them.
 */
export type MapKind = 'add' | 'mod' | 'del';
export type MapMark = { index: number; kind: MapKind; top: number; height: number; label: string };

const lines = (start: number, end: number) => (start === end ? String(start) : `${start}–${end}`);
/** The hover name of a change: what, which lines, how many. */
export function mapLabel(
	locale: Locale,
	kind: MapKind,
	start: number,
	end: number,
	hunk: GutterHunk
) {
	if (kind === 'add')
		return t(locale, 'Added · {lines} · +{count}')
			.replace('{lines}', lines(start, end))
			.replace('{count}', String(end - start + 1));
	if (kind === 'mod') return t(locale, 'Changed · {lines}').replace('{lines}', lines(start, end));
	return t(
		locale,
		hunk.start === 0 ? 'Deleted · before {line} · −{count}' : 'Deleted · after {line} · −{count}'
	)
		.replace('{line}', String(hunk.start === 0 ? 1 : start))
		.replace('{count}', String(hunk.removedCount));
}
export const kindOf = (hunk: GutterHunk): MapKind =>
	hunk.count === 0 ? 'del' : hunk.removedCount ? 'mod' : 'add';

/**
 * The marks as fractions of the map's height. `top(pos)` / `bottom(pos)` give the line's edges in document pixels and
 * `height` the whole document, so a short file keeps its lines level with the code and a long one fits the strip.
 */
export function mapMarks(
	state: EditorState,
	placed: readonly Placed[],
	geometry: { top(pos: number): number; bottom(pos: number): number; height: number },
	locale: Locale
): MapMark[] {
	const doc = state.doc;
	return placed.map((item, index) => {
		const kind = kindOf(item.hunk),
			start = doc.lineAt(Math.min(item.from, doc.length)).number,
			end = doc.lineAt(Math.min(item.to, doc.length)).number;
		// A deletion sits on the boundary: under the line above it, or over line 1.
		const y =
			kind === 'del'
				? item.hunk.start === 0
					? geometry.top(item.from)
					: geometry.bottom(item.from)
				: geometry.top(item.from);
		const span = kind === 'del' ? 0 : geometry.bottom(item.to) - geometry.top(item.from);
		return {
			index,
			kind,
			top: y / geometry.height,
			height: span / geometry.height,
			label: mapLabel(locale, kind, start, end, item.hunk),
		};
	});
}

const tickLimit = 2000;
class ChangeMap {
	readonly dom: HTMLElement;
	private readonly band: HTMLElement;
	private readonly marks: HTMLElement;
	private shown = false;
	private readonly scroll = () => this.placeBand();
	constructor(
		readonly view: EditorView,
		readonly locale: Locale
	) {
		this.dom = document.createElement('div');
		this.dom.className = 'cm-change-map';
		this.dom.setAttribute('aria-hidden', 'true');
		this.band = document.createElement('span');
		this.band.className = 'cm-map-band';
		this.marks = document.createElement('div');
		this.marks.className = 'cm-map-marks';
		this.dom.append(this.band, this.marks);
		this.dom.addEventListener('mousedown', (event) => this.click(event));
		view.scrollDOM.addEventListener('scroll', this.scroll, { passive: true });
		view.dom.append(this.dom);
		this.schedule();
	}
	update(update: ViewUpdate) {
		const searchChanged =
			searchPanelOpen(update.state) !== searchPanelOpen(update.startState) ||
			!getSearchQuery(update.state).eq(getSearchQuery(update.startState));
		if (
			update.docChanged ||
			update.geometryChanged ||
			update.heightChanged ||
			searchChanged ||
			(update.selectionSet && searchPanelOpen(update.state)) ||
			changePlaces(update.state) !== changePlaces(update.startState)
		)
			this.schedule();
	}
	private schedule() {
		this.view.requestMeasure({
			key: this,
			read: (view) => {
				const state = view.state,
					placed = changePlaces(state),
					find = searchPanelOpen(state) ? findMatches(state) : null,
					padding = view.documentPadding.top,
					height = Math.max(view.contentHeight, view.scrollDOM.clientHeight) || 1,
					geometry = {
						top: (pos: number) => view.lineBlockAt(pos).top + padding,
						bottom: (pos: number) => view.lineBlockAt(pos).bottom + padding,
						height,
					};
				const marks = mapMarks(state, placed, geometry, this.locale);
				const status = find ? findStatus(state) : null;
				const ticks = find
					? find.ranges.slice(0, tickLimit).map((range, index) => ({
							top: geometry.top(range.from) / height,
							current: status?.kind === 'found' && status.current === index + 1,
						}))
					: [];
				return { marks, ticks, find: Boolean(find?.ranges.length) };
			},
			write: ({ marks, ticks, find }) => this.draw(marks, ticks, find),
		});
	}
	private draw(marks: MapMark[], ticks: { top: number; current: boolean }[], find: boolean) {
		const shown = marks.length > 0 || find;
		if (shown !== this.shown) {
			this.shown = shown;
			this.dom.hidden = !shown;
			if (shown) this.view.dom.dataset.changeMap = find ? 'find' : '';
			else delete this.view.dom.dataset.changeMap;
			this.view.requestMeasure();
		} else if (shown) this.view.dom.dataset.changeMap = find ? 'find' : '';
		const fragment = document.createDocumentFragment();
		for (const mark of marks) {
			const element = document.createElement('span');
			element.className = `cm-map-mark cm-map-${mark.kind}`;
			element.dataset.index = String(mark.index);
			element.title = mark.label;
			element.style.top = `${(mark.top * 100).toFixed(3)}%`;
			if (mark.kind !== 'del')
				element.style.height = `max(${(mark.height * 100).toFixed(3)}%, 3px)`;
			fragment.append(element);
		}
		for (const tick of ticks) {
			const element = document.createElement('span');
			element.className = tick.current ? 'cm-map-tick cm-map-tick-current' : 'cm-map-tick';
			element.style.top = `${(tick.top * 100).toFixed(3)}%`;
			fragment.append(element);
		}
		this.marks.replaceChildren(fragment);
		this.placeBand();
	}
	/** The visible part; a file that fits on the screen has none. */
	private placeBand() {
		if (!this.shown) return;
		const scroller = this.view.scrollDOM,
			height = Math.max(this.view.contentHeight, scroller.clientHeight) || 1;
		const fits = this.view.contentHeight <= scroller.clientHeight + 1;
		this.band.hidden = fits;
		if (fits) return;
		this.band.style.top = `${((scroller.scrollTop / height) * 100).toFixed(3)}%`;
		this.band.style.height = `${((scroller.clientHeight / height) * 100).toFixed(3)}%`;
	}
	private click(event: MouseEvent) {
		if (event.button !== 0) return;
		event.preventDefault();
		const mark = (event.target as HTMLElement).closest<HTMLElement>('.cm-map-mark');
		if (mark?.dataset.index) {
			goToChange(this.view, Number(mark.dataset.index));
			return;
		}
		// Beside the marks: the code at that height comes to the middle of the screen.
		const box = this.dom.getBoundingClientRect(),
			scroller = this.view.scrollDOM,
			height = Math.max(this.view.contentHeight, scroller.clientHeight);
		const y = ((event.clientY - box.top) / Math.max(1, box.height)) * height;
		scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 2);
	}
	destroy() {
		this.view.scrollDOM.removeEventListener('scroll', this.scroll);
		this.dom.remove();
		delete this.view.dom.dataset.changeMap;
	}
}

export function changeMap(locale: Locale) {
	return ViewPlugin.define((view) => new ChangeMap(view, locale));
}
