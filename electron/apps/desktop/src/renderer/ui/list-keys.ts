/**
 * The keyboard step of a row list: ↑/↓ by one row, Home/End to the ends, no wrap at the ends. One rule for the Files
 * tree (spec/task-window#files-tree), the review list and the PR tabs (spec/pull-requests-and-ci#pr-keyboard). Null for any other key, so the caller leaves it alone.
 */
export function listStep(key: string, index: number, length: number): number | null {
	if (length <= 0) return null;
	if (key === 'Home') return 0;
	if (key === 'End') return length - 1;
	if (key === 'ArrowDown') return Math.max(0, Math.min(length - 1, index + 1));
	if (key === 'ArrowUp') return Math.max(0, Math.min(length - 1, index - 1));
	return null;
}
