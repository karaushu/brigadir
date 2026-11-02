import type { CodeChange } from '@brigadir/core';
export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
/** Main-side copy of an open document. Offsets and LSP positions are both UTF-16, as in CodeMirror. */
export class TextMirror {
	private starts: number[] | null = null;
	constructor(
		private value: string,
		public version = 0
	) {}
	get text() {
		return this.value;
	}
	private lines() {
		if (!this.starts) {
			const starts = [0];
			for (let i = 0; i < this.value.length; i++)
				if (this.value.charCodeAt(i) === 10) starts.push(i + 1);
			this.starts = starts;
		}
		return this.starts;
	}
	get lineCount() {
		return this.lines().length;
	}
	position(offset: number): Position {
		const starts = this.lines();
		const clamped = Math.max(0, Math.min(offset, this.value.length));
		let low = 0,
			high = starts.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if (starts[middle]! <= clamped) low = middle;
			else high = middle - 1;
		}
		return { line: low, character: clamped - starts[low]! };
	}
	offset(position: Position): number {
		const starts = this.lines();
		if (position.line >= starts.length) return this.value.length;
		const start = starts[Math.max(0, position.line)]!;
		const end =
			position.line + 1 < starts.length ? starts[position.line + 1]! - 1 : this.value.length;
		return Math.min(start + Math.max(0, position.character), end);
	}
	lineText(line: number) {
		const starts = this.lines();
		if (line < 0 || line >= starts.length) return '';
		const end = line + 1 < starts.length ? starts[line + 1]! - 1 : this.value.length;
		return this.value.slice(starts[line]!, end).replace(/\r$/, '');
	}
	/** Sequential changes, each against the text left by the previous one. Returns LSP content changes. */
	apply(changes: CodeChange[]): { range: Range; text: string }[] {
		const result: { range: Range; text: string }[] = [];
		for (const change of changes) {
			if (change.to > this.value.length) throw new Error('Change is outside the document');
			result.push({
				range: { start: this.position(change.from), end: this.position(change.to) },
				text: change.insert,
			});
			this.value = this.value.slice(0, change.from) + change.insert + this.value.slice(change.to);
			this.starts = null;
		}
		return result;
	}
}
