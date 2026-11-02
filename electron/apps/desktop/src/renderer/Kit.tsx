import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t, type Locale, type MessageKey } from '@brigadir/core';
import {
	Badge,
	Button,
	Chip,
	Choice,
	Field,
	IconButton,
	Popup,
	PopupMarks,
	Segments,
	SplitButton,
	StatusIcon,
	Stepper,
	Switch,
	Switches,
	Tag,
	type Appearance,
	type ControlSize,
	type Variant,
} from './ui/Controls';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Glyph } from './ui/Glyph';
import { ListCard, ListRow } from './ui/ListCard';
import { ModalDialog } from './ui/ModalDialog';
import { PopupClose } from './ui/PopupClose';
import {
	MenuItem,
	MenuList,
	MenuSection,
	MenuSeparator,
	PopoverFrame,
	PopupHeader,
} from './ui/Popover';
import { SettingsRow, SettingsSection } from './SettingsForm';
import { forceKitStates, type KitState } from './kit-states';
import { useWorkspace } from './store';
import styles from './Kit.module.css';

/**
 * spec/appearance#bundled-fonts: the control kit: each row is its name and note, then the same specimen
 * in the light and the dark palette side by side. The light column is live; the dark one mirrors it (inert, hidden from
 * the accessibility tree). Hover, press and focus are the components' own styles, held by `data-kit-state`.
 */
type Palette = 'light' | 'dark';
const sizes: [ControlSize, string][] = [
	['s', 'S 24'],
	['m', 'M 28'],
	['l', 'L 32'],
	['xl', 'XL 40'],
];
const appearances: Appearance[] = ['primary', 'neutral', 'warning', 'danger'];
const variants: Variant[] = ['solid', 'soft', 'ghost', 'outline'];

/** One row of the kit: the name and its note on the left, then the light and the dark specimen. */
function Spec({
	title,
	note,
	children,
}: {
	title: string;
	note?: string | undefined;
	children(palette: Palette): ReactNode;
}) {
	return (
		<div className={styles.spec}>
			<div className={styles.specLabel}>
				<h3>{title}</h3>
				{note && <p>{note}</p>}
			</div>
			{(['light', 'dark'] as const).map((palette) => (
				<div
					key={palette}
					className={styles.panel}
					data-palette={palette}
					{...(palette === 'dark' ? { inert: true, 'aria-hidden': true } : {})}>
					{children(palette)}
				</div>
			))}
		</div>
	);
}
/** A specimen with its caption under it. */
function Sample({ caption, children }: { caption?: string; children: ReactNode }) {
	return (
		<figure className={styles.sample}>
			<div className={styles.sampleBody}>{children}</div>
			{caption && <figcaption>{caption}</figcaption>}
		</figure>
	);
}
/** Holds a state on the first element inside, or on the elements `pick` finds there. */
function Hold({ state, pick, children }: { state: KitState; pick?: string; children: ReactNode }) {
	const ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const targets = pick
			? [...root.querySelectorAll(pick)]
			: root.firstElementChild
				? [root.firstElementChild]
				: [];
		for (const target of targets) target.setAttribute('data-kit-state', state);
		return () => {
			for (const target of targets) target.removeAttribute('data-kit-state');
		};
	});
	return (
		// A held specimen is a picture of a state: out of the keyboard and the accessibility tree.
		<span ref={ref} className={styles.hold} inert aria-hidden>
			{children}
		</span>
	);
}
/** Each token of the palette as the panel computes it, in a short form (`0 · .60`, `accent · 12 %`). */
function shortValue(value: string) {
	const text = value.trim().replace(/\s+/g, ' ');
	const mix = /^color-mix\(in srgb, (\S+) (\d+(?:\.\d+)?)%, transparent\)$/.exec(text);
	if (mix) return `${mix[1]} · ${mix[2]} %`;
	const rgba = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(text);
	if (rgba) {
		const [, r, g, b, a] = rgba;
		const alpha = a === undefined ? '' : ` · ${a.replace(/^0/, '')}`;
		return `${r === g && g === b ? r : `${r},${g},${b}`}${alpha}`;
	}
	return text.toLowerCase();
}
function useTokens(names: readonly string[]) {
	const ref = useRef<HTMLDivElement>(null);
	const appearance = useWorkspace((state) => state.appearance);
	const [values, setValues] = useState<Record<string, string>>({});
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const style = getComputedStyle(node);
		setValues(Object.fromEntries(names.map((name) => [name, style.getPropertyValue(`--${name}`)])));
	}, [appearance]);
	return [ref, values] as const;
}
function Swatches({ tokens, sample }: { tokens: readonly string[]; sample?: 'text' | 'value' }) {
	const [ref, values] = useTokens(tokens);
	return (
		<div ref={ref} className={styles.swatches}>
			{tokens.map((token) => (
				<div className={styles.swatch} key={token}>
					{sample === 'value' ? null : sample === 'text' ? (
						<span
							className={styles.tile}
							data-text
							style={
								token === 'selfg'
									? { background: 'var(--accent-fill)', color: 'var(--selfg)' }
									: { color: `var(--${token})` }
							}>
							Aa
						</span>
					) : (
						<span className={styles.tile} style={{ background: `var(--${token})` }} />
					)}
					<code>{token}</code>
					<small>{shortValue(values[token] ?? '')}</small>
				</div>
			))}
		</div>
	);
}
/** WCAG contrast of two computed colours (opaque `rgb()`), for the fills' captions. */
function contrast(a: string, b: string) {
	const lum = (value: string) => {
		const [r, g, bl, alpha = '1'] = value.match(/[\d.]+/g) ?? [];
		const mixed = [r, g, bl].map((channel) => {
			const c = (Number(channel) * Number(alpha) + 255 * (1 - Number(alpha))) / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * mixed[0]! + 0.7152 * mixed[1]! + 0.0722 * mixed[2]!;
	};
	const [x, y] = [lum(a), lum(b)];
	return ((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2);
}
function Fill({ fill, on, label }: { fill: string; on: string; label: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const appearance = useWorkspace((state) => state.appearance);
	const [ratio, setRatio] = useState('');
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const style = getComputedStyle(node);
		setRatio(contrast(style.backgroundColor, style.color));
	}, [appearance]);
	return (
		<div className={styles.swatch}>
			<span
				ref={ref}
				className={styles.tile}
				data-text
				style={{ background: `var(--${fill})`, color: `var(--${on})` }}>
				{label}
			</span>
			<code>{fill}</code>
			<small>
				{on} · {ratio}:1
			</small>
		</div>
	);
}

export function Kit({ locale }: { locale: Locale }) {
	const msg = (key: MessageKey) => t(locale, key);
	// While the kit is open, the stylesheets' interaction states also answer `data-kit-state`.
	useEffect(() => forceKitStates(), []);
	const [enabled, setEnabled] = useState(true);
	const [secondary, setSecondary] = useState(false);
	const [mode, setMode] = useState('Automatic');
	const [kind, setKind] = useState('Brigadir');
	const [crew, setCrew] = useState('Developers + Reviewer');
	const [count, setCount] = useState(3);
	const [automaticCount, setAutomaticCount] = useState(0);
	const [checked, setChecked] = useState(false);
	const [checked2, setChecked2] = useState(true);
	const [radio, setRadio] = useState('second');
	const [scope, setScope] = useState(true);
	const [surface, setSurface] = useState('Chat');
	const [tab, setTab] = useState('Appearance');
	const [branch, setBranch] = useState('feature/..bad');
	const [approve, setApprove] = useState('manual');
	const [review, setReview] = useState('quick');
	const [layout, setLayout] = useState({ chat: true, work: true, panel: false });
	const [columns, setColumns] = useState<'two' | 'three'>('three');
	const [notice, setNotice] = useState('');
	const [dialog, setDialog] = useState<'sheet' | 'modal' | 'confirm' | 'failed' | 'busy' | null>(
		null
	);
	const options = (keys: MessageKey[]) =>
		keys.map((key) => ({
			value: key,
			label: msg(key),
			...(key === 'Brigadir'
				? { icon: <Glyph name="helmet" /> }
				: key === 'Agent'
					? { icon: <Glyph name="person" /> }
					: {}),
		}));
	const states: [KitState | 'rest' | 'disabled' | 'selected', string][] = [
		['rest', msg('Rest')],
		['hover', msg('Hover')],
		['press', msg('Pressed')],
		['focus', msg('Focus')],
		['disabled', msg('Disabled')],
		['selected', msg('Selected')],
	];
	/** The six states of one control; `make` gets the props that set `disabled` and `selected`. */
	const stateRow = (
		make: (props: { disabled?: boolean; 'aria-pressed'?: boolean }) => ReactNode,
		pick?: string
	) =>
		states.map(([state, caption]) => (
			<Sample key={state} caption={caption}>
				{state === 'rest' ? (
					make({})
				) : state === 'disabled' ? (
					make({ disabled: true })
				) : state === 'selected' ? (
					make({ 'aria-pressed': true })
				) : (
					<Hold state={state} {...(pick ? { pick } : {})}>
						{make({})}
					</Hold>
				)}
			</Sample>
		));
	const typeSizes: [string, number, number, MessageKey, number?][] = [
		['19 / 700', 19, 700, 'Projects'],
		['14 / 600', 14, 600, 'New task'],
		['13 / 600', 13, 600, 'Brigadir'],
		['13.5 / 22', 13.5, 400, 'Transcript and list text', 22],
		['13 / 400', 13, 400, 'Transcript and list text'],
		['12 / 400', 12, 400, 'Comment text'],
		['11 / 600', 11, 600, 'Group title'],
		['11 / 400', 11, 400, 'The task is saved.'],
		['10 / 400', 10, 400, 'Caption and metadata'],
	];
	const repoMenu = (hover?: 'danger') => (
		<PopoverFrame label={`${msg('Repo actions')} · business`} locale={locale} width={240}>
			<MenuList label={msg('Repo actions')}>
				<MenuSection>{msg('Git')}</MenuSection>
				<MenuItem icon={<Glyph name="board-branch" size={14} />} onSelect={() => {}}>
					{msg('Switch branch…')}
				</MenuItem>
				<MenuItem icon={<Glyph name="plus" size={14} />} onSelect={() => {}}>
					{msg('New branch…')}
				</MenuItem>
				<MenuSeparator />
				<MenuItem icon={<Glyph name="git-pull" size={14} />} tail="↓2" onSelect={() => {}}>
					{msg('Pull')}
				</MenuItem>
				<MenuItem icon={<Glyph name="git-stash" size={14} />} tail="3" onSelect={() => {}}>
					{msg('Stash changes')}
				</MenuItem>
				<MenuItem
					icon={<Glyph name="git-unstash" size={14} />}
					disabled
					reason={msg('No stash entries.')}
					onSelect={() => {}}>
					{msg('Restore from stash…')}
				</MenuItem>
				<MenuItem icon={<Glyph name="undo" size={14} />} onSelect={() => {}}>
					{msg('Undo last commit…')}
				</MenuItem>
				<MenuSeparator />
				<MenuItem
					icon={<Glyph name="trash" size={14} />}
					danger
					onSelect={() => {}}
					{...(hover ? { 'data-kit-state': 'hover' } : {})}>
					{msg('Discard changes…')}
				</MenuItem>
			</MenuList>
		</PopoverFrame>
	);
	const approveMenu = (hover: boolean) => (
		<PopoverFrame label={msg('How to approve · the agent’s options')} locale={locale} width={300}>
			<MenuList label={msg('How to approve')}>
				{(
					[
						['auto', 'Yes, and use auto mode'],
						['manual', 'Yes, manually approve edits'],
						['bypass', 'Yes, and bypass permissions'],
					] as const
				).map(([value, label]) => (
					<MenuItem
						key={value}
						kind="radio"
						checked={approve === value}
						onSelect={() => setApprove(value)}
						{...(hover && value === 'bypass' ? { 'data-kit-state': 'hover' } : {})}>
						{label}
					</MenuItem>
				))}
			</MenuList>
		</PopoverFrame>
	);
	const reviewMenu = (hover: boolean) => (
		<PopoverFrame label={msg('Review with an agent')} locale={locale} width={270}>
			<MenuList label={msg('Review with an agent')}>
				<MenuItem
					kind="radio"
					checked={review === 'quick'}
					description={msg('In the main tree, the branch stays')}
					onSelect={() => setReview('quick')}>
					{msg('Quickly')}
				</MenuItem>
				<MenuItem
					kind="radio"
					checked={review === 'worktree'}
					description={msg('Branch {branch}, dependencies can be installed and run').replace(
						'{branch}',
						'pr-421-review'
					)}
					onSelect={() => setReview('worktree')}
					{...(hover ? { 'data-kit-state': 'hover' } : {})}>
					{msg('In a worktree')}
				</MenuItem>
			</MenuList>
		</PopoverFrame>
	);
	const layoutMenu = (hover: boolean) => (
		<PopoverFrame label={msg('Layout')} locale={locale} width={240}>
			<MenuList label={msg('Layout')}>
				{/* spec/task-window-workspace#two-columns: the view's radios on top, then the switches of three columns. */}
				{(['two', 'three'] as const).map((value) => (
					<MenuItem
						key={value}
						kind="radio"
						checked={columns === value}
						icon={<Glyph name={value === 'two' ? 'layout-two' : 'layout-three'} size={14} />}
						keepOpen
						onSelect={() => setColumns(value)}>
						{msg(value === 'two' ? 'Two columns' : 'Three columns')}
					</MenuItem>
				))}
				<MenuSeparator />
				{(
					[
						['chat', 'Chat', 'layout-chat', '⌘1', undefined],
						['work', 'Work area', 'layout-work', '⌘2', '· 3'],
						['panel', 'Panel', 'layout-panel', '⌘3', undefined],
					] as const
				).map(([key, label, glyph, kbd, tail]) => (
					<MenuItem
						key={key}
						kind="check"
						checked={layout[key]}
						icon={<Glyph name={glyph} size={14} />}
						kbd={kbd}
						{...(tail ? { tail } : {})}
						keepOpen
						onSelect={() => setLayout({ ...layout, [key]: !layout[key] })}
						{...(hover && key === 'work' ? { 'data-kit-state': 'hover' } : {})}>
						{msg(label)}
					</MenuItem>
				))}
				<MenuSeparator />
				<MenuItem onSelect={() => setLayout({ chat: true, work: true, panel: true })}>
					{msg('Show all (layout)')}
				</MenuItem>
				<MenuItem onSelect={() => {}}>{msg('Reset column widths')}</MenuItem>
			</MenuList>
		</PopoverFrame>
	);
	const confirmProps = {
		title: msg('Undo the last commit?'),
		locale,
		action: msg('Undo commit'),
		cancel: () => setDialog(null),
	};
	return (
		<main className={styles.kit} aria-label={msg('Kit')}>
			<header className={styles.header}>
				<h1>{msg('Control kit')}</h1>
				<p>
					{msg(
						'Shared controls in both themes, as on the canvas. The light column answers the pointer and the keyboard; the dark one mirrors it.'
					)}
				</p>
				<div role="status" className={styles.status}>
					{notice}
				</div>
			</header>
			<div className={styles.columns} aria-hidden="true">
				<span />
				<span>{msg('Light')}</span>
				<span>{msg('Dark')}</span>
			</div>

			<section className={styles.board} aria-label={msg('Palette, type and spacing')}>
				<h2>
					<span>18.8</span>
					{msg('Palette, type and spacing')}
				</h2>
				<Spec title={msg('Surfaces')}>
					{() => (
						<Swatches tokens={['win', 'sb', 'card', 'tb', 'field', 'term', 'sep', 'diffGutter']} />
					)}
				</Spec>
				<Spec
					title={msg('Text')}
					note={msg('fg — main, fg2 — second line and glyphs, fg3 — placeholder and off.')}>
					{() => <Swatches tokens={['fg', 'fg2', 'fg3', 'selfg']} sample="text" />}
				</Spec>
				<Spec
					title={msg('Accent')}
					note={msg('A fill under selfg; the soft sel marks the selected row.')}>
					{() => (
						<Swatches tokens={['accent', 'accent-fill', 'sel', 'accent-soft', 'accent-text']} />
					)}
				</Spec>
				<Spec
					title={msg('States')}
					note={msg('amber — waits for you, red — failure, green — done.')}>
					{() => (
						<Swatches
							tokens={[
								'amber',
								'amber-soft',
								'red',
								'red-soft',
								'green',
								'green-soft',
								'purple',
								'purple-soft',
							]}
						/>
					)}
				</Spec>
				<Spec
					title={msg('Warning and danger fills')}
					note={msg('Contrast of 4.5:1 or more in both themes.')}>
					{() => (
						<div className={styles.swatches}>
							<Fill fill="amber-fill" on="on-amber" label={msg('Continue')} />
							<Fill fill="red-fill" on="on-red" label={msg('Delete')} />
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Layers')}
					note={msg('Hover and press lie over a fill, not in place of it.')}>
					{() => <Swatches tokens={['tint', 'tint2', 'hover', 'segment-hover', 'segment-press']} />}
				</Spec>
				<Spec title={msg('Diff')}>
					{() => (
						<div className={styles.swatches}>
							<Swatches tokens={['diffAddedBg', 'diffRemovedBg']} />
							<div className={styles.swatch}>
								<span className={styles.tile} data-text style={{ color: 'var(--diffAddedFg)' }}>
									+142
								</span>
								<code>diffAddedFg</code>
							</div>
							<div className={styles.swatch}>
								<span className={styles.tile} data-text style={{ color: 'var(--diffRemovedFg)' }}>
									−38
								</span>
								<code>diffRemovedFg</code>
							</div>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Syntax')}
					note={msg('The Brigadir code theme; bold keywords, italic comments.')}>
					{() => (
						<div className={styles.swatches}>
							{(
								[
									['keyword', 'const'],
									['string', "'kit'"],
									['function', 'render'],
									['type', 'Props'],
									['number', '24'],
									['property', 'size'],
									['comment', '// ok'],
								] as const
							).map(([kind, text]) => (
								<div className={styles.swatch} key={kind}>
									<span className={`${styles.tile} ${styles.code} syntax-${kind}`} data-text>
										{text}
									</span>
									<code>syntax{kind[0]!.toUpperCase() + kind.slice(1)}</code>
								</div>
							))}
						</div>
					)}
				</Spec>
				<Spec title={msg('Shadow and scrim')}>
					{() => (
						<div className={styles.row}>
							<Sample caption="0 10 30 · shadow-menu">
								<PopoverFrame label={msg('Popover')} locale={locale} width={160}>
									<p className={styles.caption}>10 · 9 px</p>
								</PopoverFrame>
							</Sample>
							{(
								[
									['modal', '0 16 48 · shadow-modal'],
									['float', '0 8 24 · shadow-float'],
								] as const
							).map(([level, caption]) => (
								<Sample key={level} caption={caption}>
									<span className={styles.shadow} style={{ boxShadow: `var(--shadow-${level})` }} />
								</Sample>
							))}
							<Sample caption="modal-scrim">
								<span className={styles.scrim} />
							</Sample>
						</div>
					)}
				</Spec>
				<Spec title={msg('Fonts')} note={msg('Geist and Geist Mono on every OS.')}>
					{() => (
						<div className={styles.type}>
							{[400, 500, 600, 700].map((weight) => (
								<div key={weight}>
									<code>Geist {weight}</code>
									<span style={{ fontWeight: weight }}>Бригадир · Brigadir 0123456789</span>
								</div>
							))}
							{[400, 500].map((weight) => (
								<div key={`mono${weight}`}>
									<code>Geist Mono {weight}</code>
									<span className={styles.mono} style={{ fontWeight: weight }}>
										fix/kit-focus-ring +142 −38
									</span>
								</div>
							))}
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Code ligatures')}
					note={msg('Stylistic Set 11 in the editor, the diff and code blocks, behind a switch.')}>
					{() => (
						<div className={styles.type}>
							{[true, false].map((on) => (
								<div key={String(on)}>
									<code>ss11 · {msg(on ? 'On' : 'Off')}</code>
									<span className={styles.mono} data-ligatures={on}>
										{'a => b !== c && d >= 3 -> ::'}
									</span>
								</div>
							))}
						</div>
					)}
				</Spec>
				<Spec title={msg('Text sizes')} note={msg('--text-N × --ui-scale; the chat is 13.5 / 22.')}>
					{() => (
						<div className={styles.type}>
							{typeSizes.map(([name, size, weight, key, line]) => (
								<div key={name}>
									<code>{name}</code>
									<span
										style={{
											fontSize: `calc(${size}px * var(--ui-scale))`,
											fontWeight: weight,
											...(line ? { lineHeight: `${line}px` } : {}),
										}}>
										{msg(key)}
									</span>
								</div>
							))}
							<div>
								<code>9 / 400</code>
								<Tag>sub</Tag>
							</div>
							<div>
								<code>mono 11 / 18</code>
								<span className={styles.mono}>const ring = tokens.focus.ring;</span>
							</div>
							<div>
								<code>mono 12 / 19</code>
								<span className={styles.mono} data-size="12">
									export &#123; Button &#125; from "./Button";
								</span>
							</div>
						</div>
					)}
				</Spec>
				<Spec title={msg('Spacing')}>
					{() => (
						<div className={styles.spacing}>
							{[1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16].map((step) => (
								<span key={step}>
									<i style={{ width: step, height: step }} />
									{step}
								</span>
							))}
						</div>
					)}
				</Spec>
				<Spec title={msg('Radii')}>
					{() => (
						<div className={styles.radii}>
							{[3, 4, 5, 6, 7, 8, 9, 10, 11].map((radius) => (
								<span key={radius}>
									<i style={{ borderRadius: radius }} />
									{radius}
								</span>
							))}
						</div>
					)}
				</Spec>
				<Spec title={msg('Motion')} note={msg('No motion with Reduce motion on.')}>
					{() => (
						<Swatches
							tokens={['motion-fast', 'motion-enter-time', 'motion-travel', 'motion-ease']}
							sample="value"
						/>
					)}
				</Spec>
			</section>

			<section className={styles.board} aria-label={msg('Controls: sizes and states')}>
				<h2>
					<span>18.9</span>
					{msg('Controls: sizes and states')}
				</h2>
				<Spec
					title={msg('Scale')}
					note={msg('One size sets everything; a control with none takes its group’s, then M.')}>
					{() => (
						<>
							<ScaleTable />
							<div className={styles.row}>
								{sizes.map(([size, name]) => (
									<Sample key={size} caption={name}>
										<Button size={size} appearance="primary">
											{name}
										</Button>
									</Sample>
								))}
							</div>
						</>
					)}
				</Spec>
				<Spec title={msg('Icon button')}>
					{() => (
						<div className={styles.row}>
							{sizes.map(([size, name]) => (
								<Sample key={size} caption={name}>
									<IconButton size={size} variant="soft" label={name}>
										<Glyph name="plus" size={size === 's' ? 14 : size === 'xl' ? 18 : 16} />
									</IconButton>
								</Sample>
							))}
							<Sample caption="ghost S">
								<IconButton size="s" label={msg('More')}>
									<Glyph name="more" size={14} />
								</IconButton>
							</Sample>
							<Sample caption="shape auto">
								<IconButton size="s" shape="auto" label={msg('Layout')}>
									<Glyph name="layout-chat" size={14} />
									<Glyph name="chevron-down" size={10} />
								</IconButton>
							</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title="Appearance × variant"
					note={msg('Neutral is soft by default; primary is solid.')}>
					{() => (
						<div className={styles.grid}>
							<span />
							{variants.map((variant) => (
								<code key={variant}>{variant}</code>
							))}
							{appearances.map((appearance) => (
								<Fragment key={appearance}>
									<code>{appearance}</code>
									{variants.map((variant) => (
										<span key={`${appearance}-${variant}`}>
											<Button
												appearance={appearance}
												variant={variant}
												onClick={() => setNotice(`${appearance} · ${variant}`)}>
												{msg(
													appearance === 'primary'
														? 'Start'
														: appearance === 'neutral'
															? 'Cancel'
															: appearance === 'warning'
																? 'Continue'
																: 'Delete'
												)}
											</Button>
										</span>
									))}
								</Fragment>
							))}
						</div>
					)}
				</Spec>
				{(
					[
						['primary', 'solid', 'Start'],
						['neutral', 'soft', 'Cancel'],
						['neutral', 'ghost', 'Cancel'],
						['danger', 'solid', 'Delete'],
						['danger', 'soft', 'Delete'],
						['warning', 'solid', 'Continue'],
						['warning', 'soft', 'Continue'],
					] as const
				).map(([appearance, variant, label]) => (
					<Spec
						key={`${appearance}-${variant}`}
						title={`${msg('States')} · ${appearance} ${variant}`}>
						{() => (
							<div className={styles.row}>
								{stateRow((props) => (
									<Button {...props} appearance={appearance} variant={variant}>
										{msg(label)}
									</Button>
								))}
							</div>
						)}
					</Spec>
				))}
				<Spec
					title={`${msg('States')} · ${msg('Icon button')}`}
					note={msg('Ghost; selected is aria-pressed; a dot over the glyph.')}>
					{() => (
						<div className={styles.row}>
							{stateRow((props) => (
								<IconButton {...props} label={msg('Filter')}>
									<Glyph name="filter" size={16} />
								</IconButton>
							))}
							<Sample caption={msg('Dot')}>
								<IconButton label={msg('Filter')} dot="var(--accent)">
									<Glyph name="filter" size={16} />
								</IconButton>
							</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Split button')}
					note={msg('One capsule, a 1 px line; hover and focus take the whole capsule.')}>
					{() => {
						const split = (props: { disabled?: boolean; expanded?: boolean } = {}) => (
							<SplitButton
								appearance="primary"
								disabled={props.disabled}
								onClick={() => setNotice(msg('Approve plan'))}
								second={{
									label: msg('More'),
									onClick: () => {},
									...(props.expanded ? { expanded: true } : {}),
								}}>
								{msg('Approve plan')}
							</SplitButton>
						);
						return (
							<div className={styles.row}>
								<Sample caption={msg('Rest')}>{split()}</Sample>
								<Sample caption={msg('Hover')}>
									<Hold state="hover">{split()}</Hold>
								</Sample>
								<Sample caption={msg('Pressed')}>
									<Hold state="press">{split()}</Hold>
								</Sample>
								<Sample caption={msg('Menu open')}>{split({ expanded: true })}</Sample>
								<Sample caption={msg('Focus')}>
									<Hold state="focus" pick="button:first-child">
										{split()}
									</Hold>
								</Sample>
								<Sample caption={msg('Disabled')}>{split({ disabled: true })}</Sample>
								<Sample caption="soft S">
									<SplitButton
										size="s"
										second={{ label: msg('More'), onClick: () => {} }}
										onClick={() => {}}>
										<Glyph name="review" size={12} />
										{msg('Review with an agent')}
									</SplitButton>
								</Sample>
								<Sample caption={msg('Hover')}>
									<Hold state="hover">
										<SplitButton
											size="s"
											second={{ label: msg('More'), onClick: () => {} }}
											onClick={() => {}}>
											<Glyph name="review" size={12} />
											{msg('Review with an agent')}
										</SplitButton>
									</Hold>
								</Sample>
								<Sample caption={msg('A glyph for the second part')}>
									<SplitButton
										appearance="primary"
										onClick={() => {}}
										second={{
											label: msg('Send to chat'),
											onClick: () => {},
											icon: <Glyph name="send-chat-go" size={14} />,
										}}>
										<Glyph name="send-chat" size={14} />
										{msg('Send to chat')}
									</SplitButton>
								</Sample>
								<Sample caption={msg('No second part')}>
									<SplitButton appearance="primary" onClick={() => {}}>
										{msg('Approve plan')}
									</SplitButton>
								</Sample>
							</div>
						);
					}}
				</Spec>
				<Spec
					title={msg('Popup')}
					note={msg('A tint fill without a border; open and focused — a 2 px accent ring inside.')}>
					{() => {
						const popup = (props: { disabled?: boolean } = {}) => (
							<Popup
								label={msg('Crew')}
								options={options(['Crew', 'Developers + Reviewer', 'Create crew…'])}
								value={crew}
								onChange={setCrew}
								disabled={props.disabled ?? false}
							/>
						);
						return (
							<div className={styles.row}>
								<Sample caption={msg('Rest')}>{popup()}</Sample>
								<Sample caption={msg('Hover')}>
									<Hold state="hover" pick="button">
										{popup()}
									</Hold>
								</Sample>
								<Sample caption={msg('Focus')}>
									<Hold state="focus" pick="button">
										{popup()}
									</Hold>
								</Sample>
								<Sample caption={msg('Disabled')}>{popup({ disabled: true })}</Sample>
								<Sample caption={`${msg('Hover')} · ${msg('Settings')}`}>
									<PopupMarks.Provider value>
										<Hold state="hover" pick="button">
											<Popup
												label={msg('Theme')}
												options={[{ value: 'system', label: msg('System') }]}
												value="system"
												onChange={() => {}}
											/>
										</Hold>
									</PopupMarks.Provider>
								</Sample>
								<Sample caption="chip S">
									<Popup
										chip
										size="s"
										label={msg('Model')}
										icon={<Glyph name="claude" size={11} />}
										options={[{ value: 'opus', label: 'Opus 5.5' }]}
										value="opus"
										onChange={() => {}}
									/>
								</Sample>
								<Sample caption={`chip · ${msg('Hover')}`}>
									<Hold state="hover" pick="button">
										<Popup
											chip
											size="s"
											label={msg('Model')}
											icon={<Glyph name="claude" size={11} />}
											options={[{ value: 'opus', label: 'Opus 5.5' }]}
											value="opus"
											onChange={() => {}}
										/>
									</Hold>
								</Sample>
							</div>
						);
					}}
				</Spec>
				<Spec
					title={msg('Popup list')}
					note={msg('The row under the pointer is accent-fill under selfg.')}>
					{() => (
						<div className={styles.row}>
							<Sample caption={msg('List under the field')}>
								{/* spec/appearance#component-details: the Popup's list is the ui/Popover menu — one look. */}
								<PopoverFrame label={msg('Popup and menu')} locale={locale} width={200}>
									<MenuList label={msg('Popup and menu')}>
										{options(['Crew', 'Developers + Reviewer', 'Create crew…']).map((option) => (
											<MenuItem
												key={option.value}
												kind="radio"
												checked={crew === option.value}
												keepOpen
												onSelect={() => setCrew(option.value)}>
												{option.label}
											</MenuItem>
										))}
									</MenuList>
								</PopoverFrame>
							</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Fields')}
					note={msg('A 10 px fg2 label; a branch is mono; invalid — a 1 px red frame.')}>
					{() => (
						<div className={styles.fields}>
							<Sample caption={msg('Placeholder')}>
								<Field label={msg('Name')} placeholder={msg('Optional')} />
							</Sample>
							<Sample caption={msg('Value')}>
								<Field
									label={msg('Branch')}
									defaultValue="brigadir/split-kit-exports"
									spellCheck={false}
								/>
							</Sample>
							<Sample caption={msg('Focus')}>
								<Hold state="focus">
									<Field
										label={msg('Branch')}
										defaultValue="brigadir/split-kit-exports"
										spellCheck={false}
									/>
								</Hold>
							</Sample>
							<Sample caption={msg('Error')}>
								<Field
									label={msg('Branch')}
									value={branch}
									onChange={(event) => setBranch(event.target.value)}
									{...(branch.includes('..') ? { error: msg('Invalid name') } : {})}
									spellCheck={false}
								/>
							</Sample>
							<Sample caption={msg('Disabled')}>
								<Field label={msg('Disabled')} placeholder={msg('Optional')} disabled />
							</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Stepper')}
					note={msg('The buttons take the full height; typed digits are a draft until Return.')}>
					{() => (
						<div className={styles.row}>
							<Sample caption={msg('Rest')}>
								<Stepper
									label={msg('Stepper')}
									value={count}
									onChange={setCount}
									increaseLabel={msg('Increase')}
									decreaseLabel={msg('Decrease')}
								/>
							</Sample>
							<Sample caption={`+ ${msg('Hover')}`}>
								<Hold state="hover" pick="span > button:last-child">
									<Stepper
										label={msg('Stepper')}
										value={3}
										onChange={() => {}}
										increaseLabel={msg('Increase')}
										decreaseLabel={msg('Decrease')}
									/>
								</Hold>
							</Sample>
							<Sample caption={`+ ${msg('Pressed')}`}>
								<Hold state="press" pick="span > button:last-child">
									<Stepper
										label={msg('Stepper')}
										value={3}
										onChange={() => {}}
										increaseLabel={msg('Increase')}
										decreaseLabel={msg('Decrease')}
									/>
								</Hold>
							</Sample>
							<Sample caption={msg('Focus')}>
								<Hold state="focus" pick="input">
									<Stepper
										label={msg('Stepper')}
										value={3}
										onChange={() => {}}
										increaseLabel={msg('Increase')}
										decreaseLabel={msg('Decrease')}
									/>
								</Hold>
							</Sample>
							<Sample caption={msg('Minimum')}>
								<Stepper
									label={msg('Minimum')}
									value={1}
									onChange={() => {}}
									increaseLabel={`${msg('Minimum')} · ${msg('Increase')}`}
									decreaseLabel={`${msg('Minimum')} · ${msg('Decrease')}`}
								/>
							</Sample>
							<Sample caption={msg('Automatic')}>
								<Stepper
									label={msg('Automatic')}
									automaticLabel={msg('Automatic')}
									min={0}
									value={automaticCount}
									onChange={setAutomaticCount}
									increaseLabel={`${msg('Automatic')} · ${msg('Increase')}`}
									decreaseLabel={`${msg('Automatic')} · ${msg('Decrease')}`}
								/>
							</Sample>
							<Sample caption={msg('Disabled')}>
								<Stepper
									label={msg('Disabled')}
									value={3}
									disabled
									onChange={() => {}}
									increaseLabel={`${msg('Disabled')} · ${msg('Increase')}`}
									decreaseLabel={`${msg('Disabled')} · ${msg('Decrease')}`}
								/>
							</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Segments')}
					note={msg(
						'A tint track with 2 px inside; the chosen one is the card with a shadow. Arrows, Home and End move it.'
					)}>
					{() => (
						<div className={styles.row}>
							<Sample caption={msg('Rest')}>
								<Segments
									label={msg('Segments')}
									options={options(['Automatic', 'Manual'])}
									value={mode}
									onChange={setMode}
								/>
							</Sample>
							<Sample caption={msg('Hover')}>
								<Hold state="hover" pick="button:not([aria-checked=true])">
									<Segments
										label={`${msg('Segments')} · ${msg('Hover')}`}
										options={options(['Automatic', 'Manual'])}
										value="Automatic"
										onChange={() => {}}
									/>
								</Hold>
							</Sample>
							<Sample caption={msg('Pressed')}>
								<Hold state="press" pick="button:not([aria-checked=true])">
									<Segments
										label={`${msg('Segments')} · ${msg('Pressed')}`}
										options={options(['Automatic', 'Manual'])}
										value="Automatic"
										onChange={() => {}}
									/>
								</Hold>
							</Sample>
							<Sample caption={msg('Focus')}>
								<Hold state="focus" pick="button[aria-checked=true]">
									<Segments
										label={`${msg('Segments')} · ${msg('Focus')}`}
										options={options(['Automatic', 'Manual'])}
										value="Automatic"
										onChange={() => {}}
									/>
								</Hold>
							</Sample>
							<Sample caption={msg('With glyphs')}>
								<Segments
									label={msg('Task type')}
									options={options(['Agent', 'Brigadir'])}
									value={kind}
									onChange={setKind}
								/>
							</Sample>
							<Sample caption={msg('Tabs')}>
								<Segments
									tabs
									label={msg('View')}
									options={options(['Appearance', 'Language'])}
									value={tab}
									onChange={setTab}
								/>
							</Sample>
							<Sample caption={msg('Glyphs only')}>
								<Switches
									label={msg('Layout')}
									options={(['chat', 'work', 'panel'] as const).map((key) => ({
										value: key,
										label: msg(key === 'chat' ? 'Chat' : key === 'work' ? 'Work area' : 'Panel'),
										checked: layout[key],
										icon: (
											<Glyph
												name={
													layout[key] ? (`layout-${key}` as const) : (`layout-${key}-off` as const)
												}
												size={16}
											/>
										),
									}))}
									onToggle={(key) =>
										setLayout({ ...layout, [key]: !layout[key as keyof typeof layout] })
									}
								/>
							</Sample>
							<Sample caption={msg('Disabled')}>
								<Segments
									disabled
									label={msg('Preview')}
									options={[
										{ value: 'preview', label: msg('Preview') },
										{ value: 'code', label: msg('Code') },
									]}
									value="preview"
									onChange={() => {}}
								/>
							</Sample>
							{sizes.map(([size, name]) => (
								<Sample key={size} caption={name}>
									<Segments
										size={size}
										label={`${msg('Workspace')} ${name}`}
										options={options(['Chat', 'Editor'])}
										value={surface}
										onChange={setSurface}
									/>
								</Sample>
							))}
						</div>
					)}
				</Spec>
				<Spec title={msg('Toggle')} note={msg('In a Settings row the hover covers the whole row.')}>
					{() => (
						<div className={styles.row}>
							{sizes.map(([size, name]) => (
								<Sample key={size} caption={name}>
									<Switch
										size={size}
										label={`${msg('Toggle')} ${name}`}
										checked
										onChange={() => {}}
									/>
								</Sample>
							))}
							<Sample caption={msg('Off')}>
								<Switch label={msg('Off')} checked={secondary} onChange={setSecondary} />
							</Sample>
							<Sample caption={msg('Notifications')}>
								<Switch label={msg('Notifications')} checked={enabled} onChange={setEnabled} />
							</Sample>
							<Sample caption={msg('Hover')}>
								<Hold state="hover">
									<Switch label={msg('Hover')} checked onChange={() => {}} />
								</Hold>
							</Sample>
							<Sample caption={msg('Focus')}>
								<Hold state="focus">
									<Switch label={msg('Focus')} checked onChange={() => {}} />
								</Hold>
							</Sample>
							<Sample caption={msg('Disabled')}>
								<Switch label={msg('Disabled')} checked disabled onChange={() => {}} />
							</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Checkbox and radio')}
					note={msg('The mark grows with the size; the target is the row with its label.')}>
					{(palette) => (
						<div className={styles.row}>
							{sizes.map(([size, name]) => (
								<Sample key={size} caption={name}>
									<span className={styles.pair}>
										<Choice type="checkbox" size={size} label={`${name} ☑`} checked readOnly />
										<Choice
											type="radio"
											size={size}
											name={`kit-size-${palette}-${size}`}
											label={`${name} ◉`}
											checked
											readOnly
										/>
									</span>
								</Sample>
							))}
							<Sample caption={msg('Unchecked')}>
								<Choice
									type="checkbox"
									label={msg('Unchecked')}
									checked={checked}
									onChange={(event) => setChecked(event.target.checked)}
								/>
							</Sample>
							<Sample caption={msg('Checked')}>
								<Choice
									type="checkbox"
									label={msg('Checked')}
									checked={checked2}
									onChange={(event) => setChecked2(event.target.checked)}
								/>
							</Sample>
							<Sample caption={msg('First option')}>
								<Choice
									type="radio"
									name={`kit-radio-${palette}`}
									label={msg('First option')}
									checked={radio === 'first'}
									onChange={() => setRadio('first')}
								/>
							</Sample>
							<Sample caption={msg('Second option')}>
								<Choice
									type="radio"
									name={`kit-radio-${palette}`}
									label={msg('Second option')}
									checked={radio === 'second'}
									onChange={() => setRadio('second')}
								/>
							</Sample>
							<Sample caption={msg('Focus')}>
								<Hold state="focus">
									<Choice type="checkbox" label={`${msg('Focus')} ☑`} checked readOnly />
								</Hold>
							</Sample>
							<Sample caption={msg('Disabled')}>
								<span className={styles.pair}>
									<Choice
										type="checkbox"
										label={`${msg('Disabled')} ☑`}
										checked
										disabled
										readOnly
									/>
									<Choice type="radio" label={`${msg('Disabled')} ◉`} disabled readOnly />
								</span>
							</Sample>
						</div>
					)}
				</Spec>
				<Spec title={msg('Chips')} note={msg('A chip is always S 24.')}>
					{() => (
						<div className={styles.row}>
							<Sample caption={msg('Rest')}>
								<Chip onClick={() => setNotice('claude-opus-5')}>
									<Glyph name="claude" size={11} />
									claude-opus-5
								</Chip>
							</Sample>
							<Sample caption={msg('Hover')}>
								<Hold state="hover">
									<Chip>
										<Glyph name="effort" size={11} />
										high
									</Chip>
								</Hold>
							</Sample>
							<Sample caption={msg('Selected')}>
								<Chip
									tone={scope ? 'selected' : 'normal'}
									aria-pressed={scope}
									onClick={() => setScope(!scope)}>
									kit
								</Chip>
							</Sample>
							<Sample caption={msg('Disabled')}>
								<Chip disabled>{msg('Off')}</Chip>
							</Sample>
							<Sample caption={msg('Warning')}>
								<Chip tone="warning" onClick={() => setNotice(msg('Contended'))}>
									{msg('Contended')}
								</Chip>
							</Sample>
							<Sample caption={msg('Focus')}>
								<Hold state="focus">
									<Chip>kit</Chip>
								</Hold>
							</Sample>
						</div>
					)}
				</Spec>
				<Spec title={msg('States and badges')} note="StatusIcon 16 · Badge 16 · Tag 9">
					{() => (
						<div className={styles.row}>
							<Sample
								caption={`${msg('Working')} · ${msg('Done')} · ${msg('Needs you')} · ${msg('Error')} · ${msg('Completed')}`}>
								<span className={styles.pair}>
									<StatusIcon status="working" label={msg('Working')} />
									<StatusIcon status="done" label={msg('Done')} />
									<StatusIcon status="needs-you" label={msg('Needs you')} />
									<StatusIcon status="failed" label={msg('Error')} />
									<StatusIcon status="completed" label={msg('Completed')} />
								</span>
							</Sample>
							<Sample caption={msg('Unread')}>
								<span className={styles.unread} role="img" aria-label={msg('Unread')} />
							</Sample>
							<Sample caption={msg('Warning')}>
								<Badge warning>2</Badge>
							</Sample>
							<Sample caption="Badge">
								<Badge>{msg('Needs you')}</Badge>
							</Sample>
							<Sample caption="Tag">
								<Tag>sub</Tag>
							</Sample>
						</div>
					)}
				</Spec>
			</section>

			<section className={styles.board} aria-label={msg('Menus, popovers, containers and rows')}>
				<h2>
					<span>18.10</span>
					{msg('Menus, popovers, containers and rows')}
				</h2>
				<Spec
					title={msg('Popover shell')}
					note={msg(
						'One shell for every popover on a button; Esc first, focus goes back to the anchor.'
					)}>
					{() => (
						<Sample caption="card · 1 px sep · 9 · 5 · 0 10 30">
							<PopoverFrame label={`${msg('Repo actions')} · business`} locale={locale} width={220}>
								<MenuList label={msg('Repo actions')}>
									<MenuItem
										icon={<Glyph name="git-pull" size={14} />}
										tail="↓2"
										onSelect={() => {}}>
										{msg('Pull')}
									</MenuItem>
									<MenuItem
										icon={<Glyph name="git-stash" size={14} />}
										tail="3"
										onSelect={() => {}}>
										{msg('Stash changes')}
									</MenuItem>
								</MenuList>
							</PopoverFrame>
						</Sample>
					)}
				</Spec>
				<Spec
					title={msg('Choice menu')}
					note={msg('Focus opens on the chosen row; hover is accent-fill under selfg.')}>
					{() => (
						<div className={styles.row}>
							<Sample caption={msg('Rest')}>{approveMenu(false)}</Sample>
							<Sample caption={msg('Hover')}>{approveMenu(true)}</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Choice with a second line')}
					note={msg('An XL row; the second line is 11 fg2, selfg under the pointer.')}>
					{() => (
						<div className={styles.row}>
							<Sample caption={msg('Rest')}>{reviewMenu(false)}</Sample>
							<Sample caption={msg('Hover')}>{reviewMenu(true)}</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Actions: section, count, unavailable, dangerous')}
					note={msg('The reason under an unavailable row; a dangerous one is red.')}>
					{() => (
						<div className={styles.row}>
							<Sample caption={msg('Rest')}>{repoMenu()}</Sample>
							<Sample caption={msg('Hover')}>{repoMenu('danger')}</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Checks and shortcuts')}
					note={msg('A 14 fg2 glyph, a count, an 11 fg2 shortcut.')}>
					{() => (
						<div className={styles.row}>
							<Sample caption={msg('Rest')}>{layoutMenu(false)}</Sample>
							<Sample caption={msg('Hover')}>{layoutMenu(true)}</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Esc in the header')}
					note={msg('No frame; in the header with the name; S 24; title «Close (Esc)».')}>
					{() => (
						<div className={styles.row}>
							{(['rest', 'hover', 'press', 'focus'] as const).map((state) => (
								<Sample
									key={state}
									caption={msg(
										state === 'rest'
											? 'Rest'
											: state === 'hover'
												? 'Hover'
												: state === 'press'
													? 'Pressed'
													: 'Focus'
									)}>
									<div className={styles.header200}>
										{state === 'rest' ? (
											<PopupHeader title={msg('Layout')} locale={locale} close={() => {}} />
										) : (
											<Hold state={state} pick="button">
												<PopupHeader title={msg('Layout')} locale={locale} close={() => {}} />
											</Hold>
										)}
									</div>
								</Sample>
							))}
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Esc takes the row size')}
					note={msg(
						'A header of M controls declares M, and Esc is M 28 (spec/appearance#one-row-one-height).'
					)}>
					{() => (
						<div className={styles.row}>
							<Sample caption={msg('Menu')}>
								<PopoverFrame
									label={`${msg('Repo actions')} · business`}
									locale={locale}
									width={210}>
									<MenuList label={msg('Repo actions')}>
										<MenuItem
											icon={<Glyph name="git-pull" size={14} />}
											tail="↓2"
											onSelect={() => {}}>
											{msg('Pull')}
										</MenuItem>
									</MenuList>
								</PopoverFrame>
							</Sample>
							<Sample caption={msg('Agent options')}>
								<PopoverFrame
									label={msg('Agent options')}
									locale={locale}
									width={240}
									headerSize="m"
									heading={
										<Segments
											label={msg('Agent options')}
											options={[
												{ value: 'compact', label: msg('Compact') },
												{ value: 'full', label: msg('Full') },
											]}
											value="full"
											onChange={() => {}}
										/>
									}>
									{null}
								</PopoverFrame>
							</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('One row, one height')}
					note={msg(
						'The row declares data-size and its controls set none; the composer row too, Send M 28.'
					)}>
					{() => (
						<div className={styles.stack}>
							<div className={styles.sizedRow} data-size="l">
								<Field
									label=""
									placeholder={msg('Task name (optional)')}
									aria-label={msg('Task name (optional)')}
								/>
								<Segments
									label={msg('Task type')}
									options={options(['Agent', 'Brigadir'])}
									value={kind}
									onChange={setKind}
								/>
								<PopupClose locale={locale} close={() => {}} />
							</div>
							<div className={styles.sizedRow} data-size="m">
								<Button>{msg('Cancel')}</Button>
								<Button appearance="danger" variant="solid">
									{msg('Discard')}
								</Button>
							</div>
							{/* spec/composer#agent-capsule: the composer's row is M as well — Send takes no size of its own. */}
							<div className={styles.sizedRow} data-size="m">
								<IconButton label={msg('Attach files')}>
									<Glyph name="plus" />
								</IconButton>
								<span className={styles.grow} />
								<Button appearance="primary" aria-label={msg('Send')} title={msg('Send')}>
									<Glyph name="send" size={13} />
								</Button>
							</div>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Hover covers the whole target')}
					note={msg('The fill reaches the divider: name, second line and empty space.')}>
					{() => (
						<div className={styles.stack}>
							<SettingsSection>
								<SettingsRow label={msg('Ligatures')}>
									<Switch label={msg('Ligatures')} checked onChange={() => {}} />
								</SettingsRow>
							</SettingsSection>
							<Hold state="hover" pick="[data-settings-row]">
								<SettingsSection>
									<SettingsRow label={msg('Ligatures')}>
										<Switch label={msg('Ligatures')} checked onChange={() => {}} />
									</SettingsRow>
								</SettingsSection>
							</Hold>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Target at least 24 × 24')}
					note={msg('A 14–16 glyph, the button around it with its hover, never smaller than S.')}>
					{() => (
						<div className={styles.row}>
							<Sample caption="24 × 24 · 14">
								<span className={styles.target}>
									<IconButton size="s" label={msg('More')}>
										<Glyph name="more" size={14} />
									</IconButton>
								</span>
							</Sample>
							<Sample caption="24 × 24 · 10">
								<span className={styles.target}>
									<IconButton size="s" label={msg('Close')}>
										<Glyph name="close" size={10} />
									</IconButton>
								</span>
							</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Popover with a nub')}
					note={msg('Hover popovers (context, limits): the nub on the edge facing the anchor.')}>
					{() => (
						<div className={styles.row}>
							<Sample caption={msg('Below the anchor')}>
								<PopoverFrame label={msg('Popover')} locale={locale} width={200} arrow="top">
									<p className={styles.caption}>10 · 9 px</p>
								</PopoverFrame>
							</Sample>
							<Sample caption={msg('Above the anchor')}>
								<PopoverFrame label={msg('Popover')} locale={locale} width={200} arrow="bottom">
									<p className={styles.caption}>10 · 9 px</p>
								</PopoverFrame>
							</Sample>
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Confirmation')}
					note={msg(
						'The popover shell as a modal, 320 wide; focus on Cancel; an M footer. A failed action shows a red line; a running one turns both buttons off.'
					)}>
					{(palette) => (
						<div className={styles.row}>
							{(
								[
									['confirm', 'Open'],
									['failed', 'Open with an error'],
									['busy', 'Open while it runs'],
								] as const
							).map(([kind, label]) => (
								<Button key={kind} onClick={() => palette === 'light' && setDialog(kind)}>
									{msg(label)}
								</Button>
							))}
						</div>
					)}
				</Spec>
				<Spec
					title={msg('Modal')}
					note={msg('Radius 11, a 14 / 600 header with Esc, a 12 / 1.45 body, a tint footer.')}>
					{(palette) => (
						<Button onClick={() => palette === 'light' && setDialog('modal')}>{msg('Open')}</Button>
					)}
				</Spec>
				<Spec
					title={msg('Sheet and container card')}
					note={msg(
						'The real ModalDialog (radius 11, a tint footer) and ListCard (radius 9, rows under a hairline).'
					)}>
					{(palette) => (
						<div className={styles.row}>
							<Sample caption="ModalDialog · 0 16 48">
								<Button data-kit-sheet onClick={() => palette === 'light' && setDialog('sheet')}>
									{msg('Open')}
								</Button>
							</Sample>
							<Sample caption="ListCard">
								<div className={styles.listDemo}>
									<ListCard>
										<ListRow
											lead={<StatusIcon status="working" label={msg('Working')} />}
											title={msg('Container card')}
											detail={msg('Child row')}
										/>
										<ListRow title={msg('Child row')} />
									</ListCard>
								</div>
							</Sample>
						</div>
					)}
				</Spec>
			</section>

			{(dialog === 'sheet' || dialog === 'modal') && (
				<ModalDialog
					title={dialog === 'modal' ? msg('Leave this page?') : msg('Sheet')}
					locale={locale}
					width={dialog === 'modal' ? 380 : 360}
					close={() => setDialog(null)}
					footer={
						dialog === 'modal' ? (
							<>
								<Button onClick={() => setDialog(null)}>{msg('Stay')}</Button>
								<Button appearance="primary" onClick={() => setDialog(null)}>
									{msg('Leave')}
								</Button>
							</>
						) : (
							<Button appearance="primary" onClick={() => setDialog(null)}>
								{msg('Done')}
							</Button>
						)
					}>
					<p className={styles.dialogCopy}>
						{dialog === 'modal'
							? msg('Changes you made may not be saved.')
							: msg('Controls only; no workspace data is changed.')}
					</p>
				</ModalDialog>
			)}
			{(dialog === 'confirm' || dialog === 'failed' || dialog === 'busy') && (
				<ConfirmDialog
					{...confirmProps}
					confirm={() =>
						dialog === 'failed'
							? Promise.reject(new Error('kit'))
							: dialog === 'busy'
								? // Esc cannot close it while the action runs: it ends by itself.
									new Promise<void>((resolve) => setTimeout(resolve, 2500)).then(() =>
										setDialog(null)
									)
								: Promise.resolve(setDialog(null))
					}>
					<p className={styles.dialogCopy}>
						<code>a1b2c3d</code> Split kit exports —{' '}
						{msg('It leaves the branch, and its changes stay in the tree uncommitted.')}
					</p>
				</ConfirmDialog>
			)}
		</main>
	);
}

/** spec/appearance#control-scale's scale as tokens.css publishes it, read back from the page. */
function ScaleTable() {
	const names = ['h', 'px', 'r', 'fs', 'icon', 'gap', 'box', 'sw-w', 'sw-h'] as const;
	const ref = useRef<HTMLTableElement>(null);
	const [rows, setRows] = useState<string[][]>([]);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const style = getComputedStyle(node);
		// Lengths may be `calc()` of the UI scale: a probe resolves them to pixels.
		const read = (name: string) => {
			const probe = document.createElement('span');
			probe.style.cssText = `position:absolute;display:block;width:${style.getPropertyValue(name).trim()}`;
			node.append(probe);
			const px = Math.round(probe.getBoundingClientRect().width * 10) / 10;
			probe.remove();
			return String(px);
		};
		setRows(
			sizes.map(([size]) => [
				size.toUpperCase(),
				...names
					.filter((name) => name !== 'sw-h')
					.map((name) =>
						name === 'sw-w'
							? `${read(`--control-sw-w-${size}`)}×${read(`--control-sw-h-${size}`)}`
							: name === 'fs'
								? read(`--control-fs-${size}`)
								: read(`--control-${name}-${size}`)
					),
			])
		);
	}, []);
	return (
		<table ref={ref} className={styles.scale}>
			<thead>
				<tr>
					{['', 'h', 'px', 'r', 'font', 'icon', 'gap', 'box', 'switch'].map((head) => (
						<th key={head}>{head}</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr key={row[0]}>
						{row.map((cell, i) => (
							<td key={i}>{cell}</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}
