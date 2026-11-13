import {
	findElement,
	formatElement,
	type SimulatorElement,
	type SimulatorUi,
	type SimulatorWaitRequest,
} from './simulator-agent';
/**
 * spec/browser-and-simulator#sim-act-settle: what an action changed in the accessibility tree. Elements are matched by `testID`, else by role
 * and label, in screen order; an element with neither label, value nor `testID` cannot be named by the agent and is left out. A pair left over
 * with the same role and frame is one element whose label changed.
 */
export type SimulatorUiDiff = {
	added: SimulatorElement[];
	removed: SimulatorElement[];
	changed: { before: SimulatorElement; after: SimulatorElement }[];
	moved: number;
};
const named = (element: SimulatorElement) => !!(element.label || element.value || element.id);
const key = (element: SimulatorElement) =>
	element.id ? `#${element.id}` : `${element.role}\n${element.label}`;
const place = (element: SimulatorElement) => element.frame.map(Math.round).join(',');
export function diffUi(before: SimulatorUi, after: SimulatorUi): SimulatorUiDiff {
	const waiting = new Map<string, SimulatorElement[]>();
	for (const element of before.elements.filter(named)) {
		const list = waiting.get(key(element));
		if (list) list.push(element);
		else waiting.set(key(element), [element]);
	}
	const diff: SimulatorUiDiff = { added: [], removed: [], changed: [], moved: 0 };
	for (const element of after.elements.filter(named)) {
		const old = waiting.get(key(element))?.shift();
		if (!old) diff.added.push(element);
		else if (
			old.role !== element.role ||
			old.label !== element.label ||
			(old.value ?? '') !== (element.value ?? '')
		)
			diff.changed.push({ before: old, after: element });
		else if (place(old) !== place(element)) diff.moved++;
	}
	const removed = [...waiting.values()].flat();
	diff.removed = removed.filter((element) => {
		const index = diff.added.findIndex(
			(item) => item.role === element.role && place(item) === place(element)
		);
		if (index < 0) return true;
		diff.changed.push({ before: element, after: diff.added[index]! });
		diff.added.splice(index, 1);
		return false;
	});
	// Screen order, as simulator_ui prints it.
	const order = new Map(after.elements.map((element, index) => [element, index]));
	diff.changed.sort((a, b) => order.get(a.after)! - order.get(b.after)!);
	return diff;
}
function was({ before, after }: SimulatorUiDiff['changed'][number]) {
	const parts: string[] = [];
	if (before.role !== after.role) parts.push(before.role || 'Element');
	if (before.label !== after.label)
		parts.push(before.label ? JSON.stringify(before.label) : 'no label');
	if ((before.value ?? '') !== (after.value ?? ''))
		parts.push(before.value ? `= ${JSON.stringify(before.value)}` : 'no value');
	return `(was ${parts.join(' ')})`;
}
/** One change a line in the `simulator_ui` format, 32 KiB at most (spec/architecture-and-platform#perf-agent-responses). */
export function formatUiDiff(diff: SimulatorUiDiff, max = 32 * 1024) {
	const lines = [
		...diff.changed.map((change) => `~ ${formatElement(change.after)} ${was(change)}`),
		...diff.added.map((element) => `+ ${formatElement(element)}`),
		...diff.removed.map((element) => `- ${formatElement(element)}`),
	];
	if (diff.moved) lines.push(`${diff.moved} ${diff.moved === 1 ? 'element' : 'elements'} moved`);
	if (!lines.length) return 'No changes in the accessibility tree.';
	const head = `Changes: ${diff.added.length} appeared, ${diff.removed.length} disappeared, ${diff.changed.length} changed.`;
	const out = [head];
	let size = head.length;
	// Room for the truncation line, so the answer never passes `max`.
	const room = max - 100;
	for (const [index, line] of lines.entries()) {
		if (size + line.length + 1 > room) {
			out.push(
				`… truncated: ${lines.length - index} more changes. Call simulator_ui for the whole screen.`
			);
			break;
		}
		out.push(line);
		size += line.length + 1;
	}
	return out.join('\n');
}
/** spec/browser-and-simulator#sim-wait: `text` is in a label or a value, ignoring case; `id` and `label` find as `simulator_act` does. */
export function findWaitTarget(ui: SimulatorUi, query: SimulatorWaitRequest) {
	if (query.id || query.label) return findElement(ui, query);
	if (!query.text) return null;
	const wanted = query.text.toLocaleLowerCase();
	return (
		ui.elements.find(
			(element) =>
				element.label.toLocaleLowerCase().includes(wanted) ||
				!!element.value?.toLocaleLowerCase().includes(wanted)
		) ?? null
	);
}
/** `#spinner`, `label "Save"`, `text "Saved"`. */
export function describeWaitTarget(query: SimulatorWaitRequest) {
	if (query.id) return `#${query.id}`;
	if (query.label) return `label ${JSON.stringify(query.label)}`;
	return `text ${JSON.stringify(query.text ?? '')}`;
}
