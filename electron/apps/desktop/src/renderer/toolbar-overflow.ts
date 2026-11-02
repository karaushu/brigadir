/** spec/task-window#narrow-toolbar, spec/task-window-workspace#work-area: the task toolbar is title · Commands · Agents · Search · Tools · Layout. Search, Tools and
 *  Layout always stay; when the toolbar is narrow, Commands fold and then Agents and Commands leave for «…». */
export type OverflowKey = 'agents' | 'commands';
export type CommandsSize = 'full' | 'compact' | 'minimal';
/** The toolbar's order, which the «…» menu keeps too. */
export const toolbarOrder: readonly OverflowKey[] = ['commands', 'agents'];
export type ToolbarStep = { commands: CommandsSize; out: readonly OverflowKey[] };
/** The steps from the widest to the narrowest: Commands lose their name, Agents leave (right to left), Commands keep
 *  only their glyph, then they leave too. Absent buttons take no step. */
export function toolbarSteps(present: readonly OverflowKey[]): ToolbarStep[] {
	const steps: ToolbarStep[] = [
		{ commands: 'full', out: [] },
		{ commands: 'compact', out: [] },
	];
	if (present.includes('agents')) steps.push({ commands: 'compact', out: ['agents'] });
	const agentsOut: OverflowKey[] = present.includes('agents') ? ['agents'] : [];
	if (present.includes('commands')) {
		steps.push({ commands: 'minimal', out: agentsOut });
		steps.push({ commands: 'minimal', out: [...agentsOut, 'commands'] });
	}
	return steps;
}
export type ToolbarWidths = {
	padding: number;
	gap: number;
	title: number;
	more: number;
	/** Search, Tools and Layout: always in the toolbar. */ fixed: number;
	commands: Record<CommandsSize, number> | null;
	items: Record<'agents', number>;
};
/** How the toolbar is drawn beside the step: the title's minimum (180 with labels, spec/task-window#narrow-toolbar) and the Commands
 *  size the width rule already folds them to (spec/search-menus-and-commands#project-commands), so the fit measures what is drawn. */
export type ToolbarFitOptions = { title?: number; commands?: CommandsSize };
/** The width the toolbar needs at a step. */
export function toolbarWidth(
	step: ToolbarStep,
	present: readonly OverflowKey[],
	widths: ToolbarWidths,
	options: ToolbarFitOptions = {}
): number {
	const shown = (key: OverflowKey) => present.includes(key) && !step.out.includes(key);
	const parts = [
		options.title ?? widths.title,
		...(widths.commands && shown('commands')
			? [widths.commands[narrower(step.commands, options.commands ?? 'full')]]
			: []),
		...(shown('agents') ? [widths.items.agents] : []),
		...(step.out.some((key) => present.includes(key)) ? [widths.more] : []),
		widths.fixed,
	];
	return (
		widths.padding + parts.reduce((sum, width) => sum + width, 0) + widths.gap * (parts.length - 1)
	);
}
/** The first step that fits `available`, else the last; `floor` is the last step's width. */
export function fitToolbar(
	available: number,
	present: readonly OverflowKey[],
	widths: ToolbarWidths,
	options: ToolbarFitOptions = {}
): { step: ToolbarStep; floor: number } {
	const steps = toolbarSteps(present),
		last = steps.at(-1)!;
	return {
		step:
			steps.find((step) => toolbarWidth(step, present, widths, options) <= available + 0.5) ?? last,
		floor: Math.ceil(toolbarWidth(last, present, widths)),
	};
}
/** Typical widths until a button has been measured once: M (28) buttons (spec/appearance#control-scale). `fixed` is the two 1 px rules round
 *  Search 28, Tools ~56 and the Layout capsule 104 with the gaps between them. */
export const defaultToolbarWidths: ToolbarWidths = {
	padding: 28,
	gap: 8,
	title: 70,
	more: 28,
	fixed: 1 + 28 + 1 + 56 + 104 + 4 * 8,
	commands: { full: 141, compact: 65, minimal: 41 },
	items: { agents: 55 },
};
const order: CommandsSize[] = ['full', 'compact', 'minimal'];
/** The narrower of two sizes: the fit and the older width rule of spec/search-menus-and-commands#project-commands both may fold Commands. */
export function narrower(a: CommandsSize, b: CommandsSize): CommandsSize {
	return order[Math.max(order.indexOf(a), order.indexOf(b))]!;
}
