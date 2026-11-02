import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
	agentOptionKind,
	capsuleShows,
	fastOptionOn,
	formatAccelerator,
	modelDisplayName,
	onOffOption,
	orderAgentOptions,
	t,
	type AgentOption,
	type AgentOptionKind,
	type AgentMode,
	type AgentProvider,
	type Locale,
	type SessionCommand,
} from '@brigadir/core';
import { Segments } from './ui/Controls';
import { RememberCheck } from './ui/RememberCheck';
import { Glyph } from './ui/Glyph';
import { SkeletonRows, Spinner } from './ui/Loading';
import { NoticeLabel } from './ui/NoticeChip';
import { OptionIcon } from './ui/OptionIcon';
import { Popover } from './ui/Popover';
import { useSurfaceLayout } from './surface-layout';
import styles from './ComposerOptions.module.css';

type Entry = {
	key: string;
	option: AgentOption;
	kind: AgentOptionKind;
	legacy: boolean;
	label: string;
	/** spec/composer#agent-capsule: a segment in the capsule; every option stays in the menu. */ shown: boolean;
};
/** spec/composer#capsule-squeeze: the last squeeze level — the compact capsule. Levels 1–3 hide the labels of fast (and the rest), mode, effort. */
const COMPACT = 4;
/** spec/composer#capsule-squeeze: a select reads as segments when it is short, otherwise as a list with the choices' pictures. */
const segmentable = (option: AgentOption) =>
	option.kind === 'select' &&
	option.choices.length > 1 &&
	option.choices.length <= 4 &&
	option.choices.every((choice) => choice.name.length <= 10);
const ModelGlyph = ({ provider, size }: { provider: AgentProvider | undefined; size: number }) => (
	<span className={styles.provider} data-provider={provider}>
		<Glyph
			name={provider === 'codex' ? 'openai' : provider === 'claude' ? 'claude' : 'person'}
			size={size}
		/>
	</span>
);

/** One provider in the model-only capsule's menu (spec/composer-steering-queue-and-ghost#quick-question). */
export type CapsuleModelGroup = {
	provider: AgentProvider;
	name: string;
	/** Null while the provider's catalog loads: the group says «Loading…». */ choices:
		{ value: string; name: string; description: string | null }[] | null;
	/** The model the task runs, marked `task`. */ task: string | null;
	/** A used-up subscription limit, «Limit · 48 min»: the group reads dimmed. */ limit:
		string | null;
};
/** The capsule with the model only: no effort, mode or Fast; the menu lists the models of every provider (spec/composer-steering-queue-and-ghost#quick-question). */
export type CapsuleModels = {
	groups: CapsuleModelGroup[];
	provider: AgentProvider;
	value: string;
	label: string;
	/** The line under the list; empty — none. */ note: string;
	/** spec/appearance#loading: the model is still read — a ring in the segment, no label. */ loading?:
		boolean | undefined;
	onChoose(provider: AgentProvider, value: string): void;
	/** spec/appearance#evolution-redesign: the Helper agent's capsule — model · effort; the effort levels of the chosen model. */ effort?:
		| { choices: { value: string; name: string }[]; value: string; onChoose(value: string): void }
		| undefined;
	/** The menu's name in its header (`Summary agent`); `Model` when absent. */ title?:
		string | undefined;
	/** Where the menu opens: above the composer, below a header. */ side?:
		'top' | 'bottom' | undefined;
	/** spec/appearance#evolution-redesign: a narrow window — the provider glyph only, the model in the tooltip. */ narrow?:
		boolean | undefined;
	/** A dim word at the end of one model row (`Default agent`). */ marker?:
		{ provider: AgentProvider; value: string; label: string } | undefined;
	/** spec/appearance#evolution-redesign: `Remember for <action>` above the note — checked, a choice goes into Settings ▸ Agents. */ remember?:
		{ label: string; checked: boolean; onChange(checked: boolean): void } | undefined;
	/** spec/appearance#evolution-redesign: a row of Customize per action — `Same as Default agent` on top of the list returns the action to
	 *  inheriting; while it is chosen the capsule reads it in --fg2, without a glyph or effort. */ inherit?:
		{ label: string; detail: string; active: boolean; onChoose(): void } | undefined;
};

/** spec/composer#island capsule, spec/composer#capsule-squeeze: segments in the order model · effort · mode · fast · the rest, labels squeezed from the end when the row
 *  is short, the compact capsule last or by choice; one agent menu for the whole capsule, opened on the clicked segment's section. */
export function ComposerOptions({
	options = [],
	modes = [],
	modeId = null,
	provider: taskProvider,
	locale,
	disabled,
	locked = disabled,
	modeShortcut,
	models,
	onCommand,
}: {
	options?: AgentOption[];
	modes?: AgentMode[];
	modeId?: string | null;
	provider: AgentProvider | undefined;
	locale: Locale;
	/** The triggers are off, e.g. while a command is being sent. */ disabled: boolean;
	/** The agent works or is gone: the menu closes (spec/composer#capsule-segments). A pending command alone keeps it open. */ locked?: boolean;
	modeShortcut?: string | null | undefined;
	/** The quick question's capsule (spec/composer-steering-queue-and-ghost#quick-question): the model only, chosen among every provider's models. */ models?:
		CapsuleModels | undefined;
	onCommand?(command: SessionCommand): void;
}) {
	const provider = models?.provider ?? taskProvider;
	const compactChosen = useSurfaceLayout((state) => state.layout.composerCapsuleCompact),
		toggle = useSurfaceLayout((state) => state.toggle);
	const [level, setLevel] = useState(0),
		[open, setOpen] = useState<string | null>(null),
		id = useId();
	const root = useRef<HTMLDivElement>(null),
		opener = useRef<HTMLButtonElement | null>(null);
	const legacy: AgentOption | null =
		!models && modes.length && !options.some((option) => agentOptionKind(option) === 'mode')
			? {
					id: 'legacy-mode',
					category: 'mode',
					name: t(locale, 'Mode'),
					description: null,
					kind: 'select',
					value: modeId ?? '',
					choices: modes.map((mode) => ({
						value: mode.id,
						name: mode.name,
						description: mode.description,
						group: null,
					})),
				}
			: null;
	const source: AgentOption[] = models
		? [
				{
					id: 'model',
					category: 'model',
					name: t(locale, 'Model'),
					description: null,
					kind: 'select',
					value: models.value,
					choices: [{ value: models.value, name: models.label, description: null, group: null }],
				},
				...(models.effort?.choices.length ? [helperEffortOption(models.effort, locale)] : []),
			]
		: [...options, ...(legacy ? [legacy] : [])];
	const entries: Entry[] = orderAgentOptions(source).map((option) => {
		const kind = agentOptionKind(option),
			chosen =
				option.kind === 'select'
					? (option.choices.find((choice) => choice.value === option.value)?.name ??
						String(option.value))
					: '';
		const label =
			kind === 'fast'
				? t(locale, fastOptionOn(option) ? 'Fast on' : 'Fast off')
				: option.kind === 'select' && !onOffOption(option)
					? kind === 'model'
						? modelDisplayName(chosen, provider)
						: chosen
					: `${option.name}: ${t(locale, fastOptionOn(option) ? 'on' : 'off')}`;
		return {
			key: option === legacy ? 'legacy-mode' : `option-${option.id}`,
			option,
			kind,
			legacy: option === legacy,
			label,
			shown: capsuleShows(option),
		};
	});
	const signature = entries.map((entry) => `${entry.key}=${entry.label}`).join('|');
	const summary = entries
		.map((entry) =>
			entry.kind === 'model'
				? entry.option.kind === 'select'
					? (entry.option.choices.find((choice) => choice.value === entry.option.value)?.name ??
						entry.label)
					: entry.label
				: entry.label
		)
		.join(' · ');
	const inherit = Boolean(models?.inherit?.active);
	const compact = models ? Boolean(models.narrow) && !inherit : compactChosen || level >= COMPACT;
	// spec/composer#agent-capsule: a mode that changes while the capsule is on screen flashes the accent once (⇧Tab, the menu).
	const modeEntry = entries.find((entry) => entry.kind === 'mode'),
		modeValue = modeEntry ? `${modeEntry.key}=${String(modeEntry.option.value)}` : null,
		lastMode = useRef(modeValue),
		[flash, setFlash] = useState<string | null>(null);
	useEffect(() => {
		const was = lastMode.current;
		lastMode.current = modeValue;
		if (was === null || modeValue === null || was === modeValue || !modeEntry?.shown) return;
		setFlash(modeEntry.key);
		const timer = setTimeout(() => setFlash(null), 1200);
		return () => clearTimeout(timer);
	}, [modeValue]);
	const command = (entry: Entry, value: string | boolean): SessionCommand =>
		entry.legacy
			? { kind: 'setMode', modeId: String(value) }
			: { kind: 'setOption', id: entry.option.id, value };

	// spec/composer#capsule-squeeze: the first level at which the row fits. Probed on the row itself, so the side panels, not the window, decide.
	useLayoutEffect(() => {
		const fieldset = root.current,
			bar = fieldset?.closest<HTMLElement>('[data-composer-bar]');
		if (!fieldset || !bar) return;
		// Fits = the last item ends inside the row's content box; scrollWidth would let it run into the end padding unnoticed.
		const fits = () => {
			const last = bar.lastElementChild;
			if (!last) return true;
			const box = bar.getBoundingClientRect();
			return (
				last.getBoundingClientRect().right <=
				box.right -
					parseFloat(getComputedStyle(bar).paddingRight) -
					(box.width - bar.clientWidth) / 2 +
					0.5
			);
		};
		const fit = () => {
			let next = COMPACT;
			if (!compactChosen)
				for (let probe = 0; probe < COMPACT; probe++) {
					bar.dataset.squeeze = String(probe);
					if (fits()) {
						next = probe;
						break;
					}
				}
			bar.dataset.squeeze = String(next);
			setLevel(next);
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(bar);
		return () => {
			observer.disconnect();
			delete bar.dataset.squeeze;
		};
	}, [signature, compactChosen]);

	function show(section: string, trigger: HTMLButtonElement) {
		if (disabled || locked) return;
		opener.current = trigger;
		setOpen((value) => (value === section ? null : section));
	}
	// Focus goes back to the segment that opened the menu, else the compact capsule or the first visible segment.
	function closed() {
		setOpen(null);
		const fieldset = root.current,
			visible = (node: HTMLElement | null | undefined) =>
				!!node && node.isConnected && node.offsetParent !== null;
		opener.current =
			[
				opener.current,
				fieldset?.querySelector<HTMLButtonElement>('[data-agent-compact]'),
				fieldset?.querySelector<HTMLButtonElement>('[data-option-kind] > button'),
				fieldset?.querySelector<HTMLButtonElement>('[data-agent-more]'),
			].find(visible) ?? null;
	}
	useEffect(() => {
		if (locked) setOpen(null);
	}, [locked]);
	// A click on another segment while the menu is open moves focus to that segment's section.
	const shown = useRef<string | null>(null);
	useEffect(() => {
		const was = shown.current;
		shown.current = open;
		if (open === null || was === null || was === open) return;
		const section = document
			.getElementById(id)
			?.querySelector<HTMLElement>(`[data-section="${CSS.escape(open)}"]`);
		section?.scrollIntoView({ block: 'nearest' });
		(
			section?.querySelector<HTMLElement>('[aria-checked=true]') ??
			section?.querySelector<HTMLElement>('button')
		)?.focus({ preventScroll: true });
	}, [open]);
	if (!entries.length) return null;

	// spec/composer#agent-capsule glyphs: the provider 11, the effort disk 14, a mode or option 12; Fast's arrows in amber.
	const icon = (entry: Entry, small = false) =>
		entry.kind === 'model' ? (
			<ModelGlyph provider={provider} size={11} />
		) : (
			<OptionIcon
				kind={entry.kind}
				choice={{
					value:
						entry.kind === 'fast'
							? fastOptionOn(entry.option)
								? 'on'
								: 'off'
							: String(entry.option.value),
					name: entry.label,
				}}
				choices={entry.option.kind === 'select' ? entry.option.choices : []}
				size={entry.kind === 'effort' ? (small ? 13 : 14) : small ? 11 : 12}
			/>
		);
	const visible = entries.filter((entry) => entry.shown),
		model = entries.find((entry) => entry.kind === 'model'),
		first = model ?? entries[0]!;
	const chevron = (
		<svg
			aria-hidden="true"
			width="9"
			height="9"
			viewBox="0 0 10 10"
			fill="none"
			className={styles.chevron}>
			<path
				d="M2 3.6 5 6.6 8 3.6"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
	return (
		<div
			ref={root}
			role="group"
			className={styles.options}
			aria-label={t(locale, 'Agent options')}
			aria-disabled={disabled || undefined}
			data-disabled={disabled || undefined}
			data-compact={compact}
			data-models-narrow={(models && compact) || undefined}
			data-inherit={inherit || undefined}
			data-level={level}>
			<span className={styles.capsule} data-open={open !== null} data-agent-segments>
				{visible.map((entry, index) => (
					<span
						key={entry.key}
						className={styles.entry}
						data-option-kind={entry.kind}
						data-flash={flash === entry.key || undefined}>
						{index > 0 && (
							<span className={styles.dot} aria-hidden="true">
								·
							</span>
						)}
						<button
							type="button"
							disabled={disabled}
							aria-label={entry.option.name}
							title={`${entry.option.name}: ${entry.label}`}
							aria-haspopup="dialog"
							aria-expanded={open === entry.key}
							aria-controls={open !== null ? id : undefined}
							data-on={(entry.kind === 'other' && entry.option.kind === 'boolean') || undefined}
							onClick={(event) => show(entry.key, event.currentTarget)}>
							<span className={styles.icon} data-kind={entry.kind}>
								{icon(entry)}
							</span>
							<span className={styles.label}>
								{entry.kind === 'fast' ? (
									t(locale, 'Fast')
								) : entry.kind === 'model' && models?.loading ? (
									<Spinner size={10} />
								) : (
									entry.label
								)}
							</span>
						</button>
					</span>
				))}
				<button
					type="button"
					disabled={disabled}
					className={styles.more}
					data-agent-more
					aria-label={t(locale, 'Agent options')}
					title={summary}
					aria-haspopup="dialog"
					aria-expanded={open !== null && !visible.some((entry) => entry.key === open)}
					aria-controls={open !== null ? id : undefined}
					onClick={(event) => show(first.key, event.currentTarget)}>
					{chevron}
				</button>
			</span>
			<button
				type="button"
				disabled={disabled}
				className={styles.compact}
				data-agent-compact
				data-open={open !== null}
				aria-label={`${t(locale, 'Agent options')}: ${summary}`}
				title={summary}
				aria-haspopup="dialog"
				aria-expanded={open !== null}
				aria-controls={open !== null ? id : undefined}
				onClick={(event) => show(first.key, event.currentTarget)}>
				{model && <ModelGlyph provider={provider} size={11} />}
				{model && <span className={styles.label}>{model.label}</span>}
				{visible
					.filter((entry) => entry.kind !== 'model')
					.map((entry) => (
						<span key={entry.key} className={styles.icon} data-kind={entry.kind}>
							{icon(entry, true)}
						</span>
					))}
				{chevron}
			</button>
			<Popover
				id={id}
				open={open !== null}
				onClose={closed}
				anchor={root}
				returnFocus={opener}
				side={models?.side ?? 'top'}
				align={models ? 'start' : 'end'}
				width={models ? (models.effort || models.inherit ? 260 : 240) : 300}
				label={models?.title ?? t(locale, models ? 'Model' : 'Agent options')}
				locale={locale}
				className={styles.menu}
				headerSize={models ? 's' : 'm'}
				heading={
					models ? undefined : (
						<Segments
							label={t(locale, 'Capsule view')}
							value={compactChosen ? 'compact' : 'full'}
							onChange={(value) => {
								if ((value === 'compact') !== compactChosen) toggle('composerCapsuleCompact');
							}}
							options={[
								{ value: 'compact', label: t(locale, 'Compact'), icon: <DensityIcon compact /> },
								{ value: 'full', label: t(locale, 'Full'), icon: <DensityIcon compact={false} /> },
							]}
						/>
					)
				}
				initialFocus={(panel) => {
					const section =
						open === null
							? null
							: panel.querySelector<HTMLElement>(`[data-section="${CSS.escape(open)}"]`);
					return (
						section?.querySelector<HTMLElement>('[aria-checked=true]') ??
						section?.querySelector<HTMLElement>('button')
					);
				}}>
				{models ? (
					<ModelGroups
						models={models}
						section={(model ?? first).key}
						effortSection={entries.find((entry) => entry.kind === 'effort')?.key}
						locale={locale}
					/>
				) : (
					entries.map((entry) => (
						<section key={entry.key} data-section={entry.key} aria-label={entry.option.name}>
							<h3>
								{entry.option.name}
								{entry.kind === 'mode' && modeShortcut && (
									<kbd className={styles.kbd}>{formatAccelerator(modeShortcut)}</kbd>
								)}
							</h3>
							<Choices
								entry={entry}
								locale={locale}
								onChange={(value) => onCommand?.(command(entry, value))}
							/>
						</section>
					))
				)}
			</Popover>
		</div>
	);
}

/** One section of the agent menu: the model and long selects as a list, short selects and booleans as segments.
 *  Text only — the pictures of the choices live in the capsule; the chosen row of a list is `--sel` with an accent ✓. */
function Choices({
	entry,
	locale,
	marker,
	onChange,
}: {
	entry: Pick<Entry, 'option' | 'kind'>;
	locale: Locale;
	/** A dim word at the end of one row: `task` beside the task's model. */ marker?:
		{ value: string; label: string } | null | undefined;
	onChange(value: string | boolean): void;
}) {
	const { option, kind } = entry;
	if (option.kind !== 'select')
		return (
			<Segments
				label={option.name}
				value={option.value ? 'on' : 'off'}
				onChange={(value) => onChange(value === 'on')}
				options={[
					{ value: 'off', label: t(locale, 'Off') },
					{ value: 'on', label: t(locale, 'On') },
				]}
			/>
		);
	const choices = option.choices.map((choice) => ({
		value: choice.value,
		label: choice.group ? `${choice.group} · ${choice.name}` : choice.name,
		description: choice.description,
	}));
	if (kind !== 'model' && segmentable(option))
		return (
			<Segments
				label={option.name}
				value={option.value}
				onChange={onChange}
				options={choices.map(({ value, label }) => ({ value, label }))}
			/>
		);
	return (
		<div role="radiogroup" aria-label={option.name} className={styles.list}>
			{choices.map((item, index) => {
				const checked = item.value === option.value;
				return (
					<button
						type="button"
						role="radio"
						key={item.value}
						aria-checked={checked}
						tabIndex={
							checked || (index === 0 && !choices.some((other) => other.value === option.value))
								? 0
								: -1
						}
						title={item.description ?? undefined}
						onClick={() => {
							if (!checked) onChange(item.value);
						}}
						onKeyDown={(event) => {
							const step =
								event.key === 'ArrowDown' || event.key === 'ArrowRight'
									? 1
									: event.key === 'ArrowUp' || event.key === 'ArrowLeft'
										? -1
										: 0;
							if (!step && event.key !== 'Home' && event.key !== 'End') return;
							event.preventDefault();
							const next =
								event.key === 'Home'
									? 0
									: event.key === 'End'
										? choices.length - 1
										: (index + step + choices.length) % choices.length;
							event.currentTarget.parentElement
								?.querySelectorAll<HTMLButtonElement>('button')
								[next]?.focus();
						}}>
						<span className={styles.check} aria-hidden="true">
							{checked && <Glyph name="check-pass" size={11} />}
						</span>
						<span className={styles.choice}>{item.label}</span>
						{marker?.value === item.value && <span className={styles.marker}>{marker.label}</span>}
					</button>
				);
			})}
		</div>
	);
}
/** spec/composer-steering-queue-and-ghost#quick-question: one `Model` section, the models grouped by provider with its glyph,
 *  `task` beside the task's model, a used-up limit as the amber chip on a dimmed group, «Loading…» while a catalog loads. */
export function ModelGroups({
	models,
	section,
	effortSection = 'option-effort',
	locale,
}: {
	models: CapsuleModels;
	section: string;
	effortSection?: string | undefined;
	locale: Locale;
}) {
	const effort = models.effort?.choices.length ? helperEffortOption(models.effort, locale) : null;
	const inherit = models.inherit;
	return (
		<section data-section={section} aria-label={t(locale, 'Model')} className={styles.models}>
			{inherit && (
				<div
					role="radiogroup"
					aria-label={inherit.label}
					className={`${styles.list} ${styles.inherit}`}>
					<button
						type="button"
						role="radio"
						aria-checked={inherit.active}
						tabIndex={0}
						onClick={() => {
							if (!inherit.active) inherit.onChoose();
						}}>
						<span className={styles.check} aria-hidden="true">
							{inherit.active && <Glyph name="check-pass" size={11} />}
						</span>
						<span className={styles.choice}>{inherit.label}</span>
						{inherit.detail && <span className={styles.marker}>{inherit.detail}</span>}
					</button>
				</div>
			)}
			{models.groups.map((group) => (
				<div
					key={group.provider}
					className={styles.group}
					data-limited={!!group.limit || undefined}>
					<h4>
						<ModelGlyph provider={group.provider} size={11} />
						{group.name}
						{group.limit && <NoticeLabel label={group.limit} icon="agent-hourglass" />}
					</h4>
					{group.choices ? (
						<Choices
							entry={{
								kind: 'model',
								option: {
									id: `model-${group.provider}`,
									category: 'model',
									name: `${t(locale, 'Model')} · ${group.name}`,
									description: null,
									kind: 'select',
									value: group.provider === models.provider ? models.value : '',
									choices: group.choices.map((choice) => ({ ...choice, group: null })),
								},
							}}
							locale={locale}
							marker={
								models.marker?.provider === group.provider
									? models.marker
									: group.task === null
										? null
										: { value: group.task, label: t(locale, 'task') }
							}
							onChange={(value) => models.onChoose(group.provider, String(value))}
						/>
					) : (
						<SkeletonRows count={3} height={28} single />
					)}
				</div>
			))}
			{effort && (
				<section data-section={effortSection} aria-label={effort.name} className={styles.effort}>
					<h3>{effort.name}</h3>
					<Choices
						entry={{ kind: 'effort', option: effort }}
						locale={locale}
						onChange={(value) => models.effort!.onChoose(String(value))}
					/>
				</section>
			)}
			{models.remember && (
				<RememberCheck
					label={models.remember.label}
					checked={models.remember.checked}
					onChange={models.remember.onChange}
				/>
			)}
			{models.note && <p className={styles.note}>{models.note}</p>}
		</section>
	);
}
/** spec/appearance#evolution-redesign: the effort of the Helper agent's capsule as an agent option, so the capsule and the menu draw it as usual. */
function helperEffortOption(
	effort: NonNullable<CapsuleModels['effort']>,
	locale: Locale
): AgentOption {
	return {
		id: 'effort',
		category: 'thought_level',
		name: t(locale, 'Effort'),
		description: null,
		kind: 'select',
		value: effort.value,
		choices: effort.choices.map((choice) => ({ ...choice, description: null, group: null })),
	};
}
/** ›‹ compact and ‹› full, in the kit's stroke geometry. */
function DensityIcon({ compact }: { compact: boolean }): ReactNode {
	return (
		<svg
			aria-hidden="true"
			width="12"
			height="12"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.4"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{ flex: 'none' }}
			data-density-icon={compact ? 'compact' : 'full'}>
			<path
				d={
					compact
						? 'M2.4 4.6 5.8 8l-3.4 3.4M13.6 4.6 10.2 8l3.4 3.4'
						: 'M5.4 4.6 2 8l3.4 3.4M10.6 4.6 14 8l-3.4 3.4'
				}
			/>
		</svg>
	);
}
