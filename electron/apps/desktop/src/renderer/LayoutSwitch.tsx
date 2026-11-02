import { useRef, useState } from 'react';
import {
	t,
	type LayoutColumn,
	type Locale,
	type TaskColumns,
	type TaskLayout,
} from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import { Switches } from './ui/Controls';
import { MenuItem, MenuPopover, MenuSeparator } from './ui/Popover';
const names = {
	chat: ['Chat', 'Hide the chat', 'Show the chat', 'layout-chat'],
	work: ['Work area', 'Hide the work area', 'Show the work area', 'layout-work'],
	panel: ['Panel', 'Hide panel', 'Show panel', 'layout-panel'],
} as const;
const columnNames = { two: 'Two columns', three: 'Three columns' } as const;
/**
 * spec/task-window-workspace#layout-switch: Layout, last in the task toolbar — the chat, the work area and the panel, each its own switch (a flat
 * capsule, the state is the glyph's fill), and ▾ with the same three, Show all and Reset column widths. Every switch
 * turns off, all three too (the task then shows its empty state); a hidden work area carries its tab count
 * (amber with an unsaved tab, as spec/task-window#layout-overview). spec/task-window-workspace#empty-work-area: a task's empty work area is off, and turning it on opens Tools.
 * spec/task-window-workspace#two-columns: in two columns it is one glyph of the current layout (the panel's column filled while the panel shows) and
 * ▾; both open the menu — Two / Three columns, Panel ⌘3, Reset column widths. Three columns' ▾ gets the same radios.
 */
export function LayoutSwitch({
	locale,
	layout,
	columns,
	taskColumns,
	tabs,
	unsaved,
	kbd,
	onToggle,
	onShowAll,
	onReset,
	onColumns,
}: {
	locale: Locale;
	layout: TaskLayout;
	/** The switches this view has: the main tree has no chat. */ columns: readonly LayoutColumn[];
	/** spec/task-window-workspace#two-columns: the app's two / three columns; null — the main tree, which has no chat and no choice. */
	taskColumns: TaskColumns | null;
	tabs: number;
	unsaved: boolean;
	kbd(command: string): string | undefined;
	onToggle(column: LayoutColumn): void;
	onShowAll(): void;
	onReset(): void;
	onColumns(value: TaskColumns): void;
}) {
	const [open, setOpen] = useState(false),
		menu = useRef<HTMLButtonElement>(null),
		capsule = useRef<HTMLDivElement>(null);
	const two = taskColumns === 'two';
	const hint = (column: LayoutColumn) => {
		const [, hide, show] = names[column],
			key = kbd(`layout-${column}`);
		return `${t(locale, layout[column] ? hide : show)}${key ? ` · ${key}` : ''}`;
	};
	const count = !layout.work && tabs > 0 ? `${tabs}` : undefined;
	const twoGlyph = (size: number) => (
		<Glyph name={layout.panel ? 'layout-two-panel' : 'layout-two'} size={size} />
	);
	const toggleMenu = () => setOpen((value) => !value);
	return (
		<>
			<Switches
				label={t(locale, 'Layout')}
				rootRef={capsule}
				onToggle={(value) => onToggle(value as LayoutColumn)}
				options={
					two
						? [
								{
									value: 'layout',
									label: `${t(locale, 'Layout')} · ${t(locale, columnNames.two)}`,
									checked: true,
									opensMenu: true,
									icon: twoGlyph(16),
								},
							]
						: columns.map((column) => ({
								value: column,
								label: t(locale, names[column][0]),
								hint: hint(column),
								checked: layout[column],
								icon: (
									<Glyph
										name={layout[column] ? names[column][3] : `${names[column][3]}-off`}
										size={16}
									/>
								),
								...(column === 'work' && count
									? {
											tail: (
												<span data-unsaved={unsaved || undefined} data-layout-count>
													{count}
												</span>
											),
										}
									: {}),
							}))
				}
				menu={{
					label: t(locale, 'Layout'),
					expanded: open,
					ref: menu,
					onClick: toggleMenu,
				}}
			/>
			<MenuPopover
				open={open}
				onClose={() => setOpen(false)}
				// Two columns: the glyph opens the menu too, so a press anywhere on the capsule toggles it.
				anchor={two ? capsule : menu}
				align="end"
				width={248}
				label={t(locale, 'Layout')}
				locale={locale}>
				{taskColumns && (
					<>
						{(['two', 'three'] as const).map((value) => (
							<MenuItem
								key={value}
								kind="radio"
								checked={taskColumns === value}
								data-layout-columns={value}
								icon={<Glyph name={value === 'two' ? 'layout-two' : 'layout-three'} size={14} />}
								onSelect={() => {
									if (value !== taskColumns) onColumns(value);
								}}>
								{t(locale, columnNames[value])}
							</MenuItem>
						))}
						<MenuSeparator />
					</>
				)}
				{two ? (
					<MenuItem
						kind="check"
						checked={layout.panel}
						data-layout-item="panel"
						icon={twoGlyph(14)}
						kbd={kbd('layout-panel')}
						onSelect={() => onToggle('panel')}>
						{t(locale, names.panel[0])}
					</MenuItem>
				) : (
					columns.map((column) => (
						<MenuItem
							key={column}
							kind="check"
							checked={layout[column]}
							data-layout-item={column}
							// spec/task-window-workspace#empty-work-area: a task's empty work area turned on opens Tools, which takes the focus; the main tree's shows.
							hands={column === 'work' && !layout.work && tabs === 0 && columns.includes('chat')}
							icon={
								<Glyph
									name={layout[column] ? names[column][3] : `${names[column][3]}-off`}
									size={14}
								/>
							}
							tail={column === 'work' && count ? `· ${count}` : undefined}
							kbd={kbd(`layout-${column}`)}
							onSelect={() => onToggle(column)}>
							{t(locale, names[column][0])}
						</MenuItem>
					))
				)}
				<MenuSeparator />
				{!two && <MenuItem onSelect={onShowAll}>{t(locale, 'Show all (layout)')}</MenuItem>}
				<MenuItem onSelect={onReset}>{t(locale, 'Reset column widths')}</MenuItem>
			</MenuPopover>
		</>
	);
}
