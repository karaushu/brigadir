import { useRef, useState, type ComponentProps, type RefObject } from 'react';
import { t, type DocumentTab, type Locale, type TaskKey, type ToolTabKind } from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import { IconButton, Chevron } from './ui/Controls';
import { MenuItem, MenuPopover, MenuSection, MenuSeparator } from './ui/Popover';
import { agentMark, browserTabName, useAgentMark, useTaskBrowserTabs } from './browser-tabs';
import { useSecondTick } from './ui/second-tick';
import styles from './ToolsMenu.module.css';
type GlyphName = ComponentProps<typeof Glyph>['name'];
export const toolGlyph: Record<ToolTabKind, GlyphName> = {
	terminal: 'console',
	browser: 'browser',
	simulator: 'simulator',
};
/** A tool tab's name: the page's host, the terminal's command, the device. */
export function toolTabName(
	locale: Locale,
	tab: DocumentTab,
	info: ReturnType<typeof useTaskBrowserTabs>
): string {
	if (tab.kind === 'browser')
		return browserTabName(info?.[tab.target], tab.path || t(locale, 'New page'));
	if (tab.kind === 'simulator') return tab.path || t(locale, 'Simulator');
	return tab.path || t(locale, 'Terminal');
}
export type ToolsMenuProps = {
	task: TaskKey;
	locale: Locale;
	open: boolean;
	anchor: RefObject<HTMLElement | null>;
	onClose(): void;
	/** Every tool tab of the task's work area, in group order. */ tabs: DocumentTab[];
	place: 'focused' | 'bottom';
	onPlace(place: 'focused' | 'bottom'): void;
	onNew(kind: ToolTabKind): void;
	/** spec/editor#new-file: «New file…», its popover placed at the button this menu opened from. */
	onNewFile(anchor: RefObject<HTMLElement | null>): void;
	onReveal(tab: DocumentTab): void;
	modules: { browser: boolean; simulator: boolean };
	kbd(command: string): string | undefined;
};
/** spec/task-window-workspace#work-area: Tools — new file (spec/editor#new-file), new terminal, browser, simulator; the open tools of the task; where a new one opens. */
export function ToolsMenu(props: ToolsMenuProps) {
	const { locale, tabs, place } = props;
	const info = useTaskBrowserTabs(props.task);
	const now = useSecondTick(props.open);
	return (
		<MenuPopover
			open={props.open}
			onClose={props.onClose}
			anchor={props.anchor}
			align="end"
			width={264}
			label={t(locale, 'Task tools')}
			locale={locale}>
			<MenuItem
				icon={<Glyph name="file-new" size={14} />}
				kbd={props.kbd('new-file')}
				hands
				data-tools-new-file
				onSelect={() => props.onNewFile(props.anchor)}>
				{t(locale, 'New file…')}
			</MenuItem>
			<MenuItem
				icon={<Glyph name="console" size={14} />}
				kbd={props.kbd('terminal-new')}
				onSelect={() => props.onNew('terminal')}>
				{t(locale, 'New terminal')}
			</MenuItem>
			{props.modules.browser && (
				<MenuItem
					icon={<Glyph name="browser" size={14} />}
					kbd={props.kbd('browser')}
					onSelect={() => props.onNew('browser')}>
					{t(locale, 'New browser')}
				</MenuItem>
			)}
			{props.modules.simulator && (
				<MenuItem
					icon={<Glyph name="simulator" size={14} />}
					kbd={props.kbd('simulator')}
					onSelect={() => props.onNew('simulator')}>
					{t(locale, 'Simulator')}
				</MenuItem>
			)}
			{tabs.length > 0 && (
				<>
					<MenuSeparator />
					<MenuSection>
						{t(locale, 'Open · {count}').replace('{count}', String(tabs.length))}
					</MenuSection>
					{tabs.map((tab) => {
						const mark =
							tab.kind === 'browser'
								? agentMark(info?.[tab.target]?.agent, now || Date.now())
								: null;
						return (
							<MenuItem
								key={tab.id}
								data-tool-tab={tab.id}
								icon={<Glyph name={toolGlyph[tab.kind as ToolTabKind]} size={14} />}
								tail={
									mark ? (
										<span
											className={styles.agentDot}
											role="img"
											aria-label={t(locale, 'Agent in the browser')}
										/>
									) : undefined
								}
								onSelect={() => props.onReveal(tab)}>
								{toolTabName(locale, tab, info)}
							</MenuItem>
						);
					})}
				</>
			)}
			<MenuSeparator />
			<MenuSection>{t(locale, 'Where to open')}</MenuSection>
			<MenuItem
				kind="radio"
				checked={place === 'focused'}
				onSelect={() => props.onPlace('focused')}>
				{t(locale, 'In the focused group')}
			</MenuItem>
			<MenuItem kind="radio" checked={place === 'bottom'} onSelect={() => props.onPlace('bottom')}>
				{t(locale, 'In the bottom group')}
			</MenuItem>
		</MenuPopover>
	);
}
/** spec/task-window-workspace#work-area: the toolbar's Tools — glyph, the count of open tools, the agent's dot, ▾; one button, not a split. */
export function ToolsButton({
	locale,
	count,
	agent,
	hint,
	menu,
	open: shown,
	onOpen,
}: {
	locale: Locale;
	count: number;
	agent: boolean;
	hint: string;
	menu: Omit<ToolsMenuProps, 'open' | 'anchor' | 'onClose' | 'locale'>;
	/** The view opens it too (spec/task-window-workspace#empty-work-area: the work area turned on with no tab; ⇧⌘I); otherwise it holds its own state. */
	open?: boolean;
	onOpen?(open: boolean): void;
}) {
	const [own, setOwn] = useState(false),
		open = shown ?? own,
		setOpen = (value: boolean | ((open: boolean) => boolean)) => {
			const next = typeof value === 'function' ? value(open) : value;
			if (onOpen) onOpen(next);
			else setOwn(next);
		},
		button = useRef<HTMLButtonElement>(null);
	return (
		<>
			<IconButton
				ref={button}
				data-tools-button
				shape="auto"
				className={styles.tools}
				label={t(locale, 'Task tools')}
				hint={hint}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}>
				<Glyph name="tools" size={16} />
				{count > 0 && <span className={styles.count}>{count}</span>}
				{agent && (
					<span
						className={styles.agentMark}
						role="img"
						aria-label={t(locale, 'Agent in the browser')}
					/>
				)}
				<Chevron />
			</IconButton>
			<ToolsMenu
				{...menu}
				locale={locale}
				open={open}
				anchor={button}
				onClose={() => setOpen(false)}
			/>
		</>
	);
}
/** The agent's dot on the Tools button: the agent acts on or just acted on a browser tab of the task. */
export function useAgentOnTools(task: TaskKey, tabs: DocumentTab[]) {
	const info = useTaskBrowserTabs(task);
	const agents = tabs
		.filter((tab) => tab.kind === 'browser')
		.map((tab) => info?.[tab.target]?.agent)
		.filter((agent) => !!agent);
	// A tab the agent acts on now wins; otherwise the one it left last decides how long the dot stays.
	const latest =
		agents.find((agent) => agent!.acting || agent!.waiting) ??
		agents.sort((a, b) => b!.last - a!.last)[0];
	return useAgentMark(latest) !== null;
}
