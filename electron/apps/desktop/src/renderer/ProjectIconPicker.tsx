import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
	projectIconColors,
	projectImageSide,
	searchProjectIcons,
	t,
	type Locale,
	type MessageKey,
	type Project,
	type ProjectIcon as Icon,
	type ProjectIconColor,
	type RepoIconCandidate,
} from '@brigadir/core';
import { Popover } from './ui/Popover';
import { Button, Segments } from './ui/Controls';
import { GenerateButton } from './ui/GenerateButton';
import { TextInput } from './ui/Input';
import { Glyph } from './ui/Glyph';
import { SearchField } from './ui/PanelSearch';
import { SwatchPicker } from './ui/AccentPicker';
import { LucideIcon, ProjectIcon, projectIconColor } from './ui/ProjectIcon';
import { toastError } from './ui/Toast';
import { useLucide } from './project-icons';
import s from './ProjectIconPicker.module.css';

const colorNames: Record<ProjectIconColor, MessageKey> = {
	red: 'Red',
	orange: 'Orange',
	yellow: 'Yellow',
	green: 'Green',
	teal: 'Teal',
	blue: 'Blue',
	purple: 'Purple',
	pink: 'Pink',
	gray: 'Gray',
};
const repoNames: Record<RepoIconCandidate['kind'], MessageKey> = {
	app: 'App icon',
	adaptive: 'Adaptive icon',
	favicon: 'Favicon',
	logo: 'Logo',
};
type Tab = 'icon' | 'monogram' | 'image';
const columns = 8,
	rowHeight = 36,
	visibleRows = 3;
/**
 * spec/appearance#evolution-redesign: «Project icon» — the manual change of the agent's pick. `Icon`: the agent's pick with its
 * reason and «Pick again», the search over names and Lucide tags, the suggested and all icons; `Monogram`: the letters of the
 * name; `Image` (spec/projects-and-board#project-icon): the person's own image, one Codex draws, and the app icons found in the repo. The colour applies to any kind; «Reset to monogram» at the bottom.
 * Each choice is saved at once.
 */
export function ProjectIconPicker({
	project,
	slot,
	anchor,
	open,
	locale,
	onClose,
}: {
	project: Project;
	slot: number;
	anchor: RefObject<HTMLElement | null>;
	open: boolean;
	locale: Locale;
	onClose(): void;
}) {
	const icon = project.icon,
		color = projectIconColor(project, slot);
	const [tab, setTab] = useState<Tab>(
		icon?.kind === 'repo' || icon?.kind === 'image'
			? 'image'
			: icon?.kind === 'monogram'
				? 'monogram'
				: 'icon'
	);
	const [query, setQuery] = useState('');
	const [asking, setAsking] = useState(false);
	const picking = asking || !!project.iconPicking;
	const save = (next: Icon) =>
		void window.brigadir
			.setProjectIcon(project.id, next)
			.catch(() => toastError(t(locale, 'Could not save the project icon.')));
	const choose = (name: string) =>
		save({
			kind: 'lucide',
			name,
			color,
			by: project.iconPick?.name === name ? 'agent' : 'person',
		});
	const recolor = (next: ProjectIconColor) => {
		if (icon?.kind === 'repo') {
			void window.brigadir
				.setProjectRepoIcon(project.id, icon.path, next)
				.catch(() => toastError(t(locale, 'Could not save the project icon.')));
			return;
		}
		save(
			icon?.kind === 'lucide' || icon?.kind === 'image'
				? { ...icon, color: next }
				: { kind: 'monogram', color: next }
		);
	};
	const pickAgain = () => {
		setAsking(true);
		void window.brigadir
			.pickProjectIcon(project.id)
			.then((result) => {
				if (result === 'off') toastError(t(locale, 'The suggestion model is off.'));
				if (result === 'failed') toastError(t(locale, 'Could not pick an icon.'));
			})
			.catch(() => toastError(t(locale, 'Could not pick an icon.')))
			.finally(() => setAsking(false));
	};
	return (
		<Popover
			open={open}
			onClose={onClose}
			anchor={anchor}
			label={t(locale, 'Project icon')}
			title={
				<>
					{t(locale, 'Project icon')}
					<span className={s.titleNote}>{project.name}</span>
				</>
			}
			locale={locale}
			width={328}
			className={s.picker}
			data-project-icon-picker={project.id}>
			<Segments
				className={s.tabs}
				size="m"
				label={t(locale, 'Project icon')}
				value={tab}
				options={[
					{ value: 'icon', label: t(locale, 'Icon') },
					{ value: 'monogram', label: t(locale, 'Monogram') },
					{ value: 'image', label: t(locale, 'Image') },
				]}
				onChange={(value) => {
					setTab(value as Tab);
					// The monogram has nothing else to choose: the tab is the choice.
					if (value === 'monogram' && icon?.kind !== 'monogram') save({ kind: 'monogram', color });
				}}
			/>
			{tab === 'icon' && (
				<IconTab
					project={project}
					slot={slot}
					color={color}
					query={query}
					locale={locale}
					picking={picking}
					onQuery={setQuery}
					onChoose={choose}
					onPickAgain={pickAgain}
				/>
			)}
			{tab === 'monogram' && (
				<div className={s.monogram}>
					<ProjectIcon
						project={{ name: project.name, icon: { kind: 'monogram', color } }}
						size={48}
					/>
				</div>
			)}
			{tab === 'image' && (
				<ImageTab project={project} color={color} locale={locale} onSave={save} />
			)}
			{tab !== 'image' && (
				<>
					<div className={s.label}>{t(locale, 'Colour')}</div>
					<div className={s.swatches}>
						<SwatchPicker
							label={t(locale, 'Colour')}
							values={projectIconColors}
							value={color}
							onChange={recolor}
							name={(item) => t(locale, colorNames[item])}
							color={(item) => `var(--icon-${item})`}
							data-icon-colors=""
						/>
					</div>
				</>
			)}
			<footer className={s.footer} data-size="s">
				<Button
					variant="ghost"
					data-icon-reset
					disabled={icon?.kind === 'monogram' || !icon}
					onClick={() => {
						save({ kind: 'monogram', color });
						setTab('monogram');
					}}>
					{t(locale, 'Reset to monogram')}
				</Button>
			</footer>
		</Popover>
	);
}
function IconTab({
	project,
	slot,
	color,
	query,
	locale,
	picking,
	onQuery,
	onChoose,
	onPickAgain,
}: {
	project: Project;
	slot: number;
	color: ProjectIconColor;
	query: string;
	locale: Locale;
	picking: boolean;
	onQuery(value: string): void;
	onChoose(name: string): void;
	onPickAgain(): void;
}) {
	const { icons, tags } = useLucide(true);
	const pick = project.iconPick,
		current = project.icon?.kind === 'lucide' ? project.icon.name : null;
	const found = useMemo(() => (tags ? searchProjectIcons(query, tags) : []), [query, tags]);
	const suggested = pick ? [pick.name, ...pick.suggested].slice(0, columns) : [];
	return (
		<>
			<div className={s.agent} data-icon-agent>
				{picking ? (
					<span className={s.agentTile} data-picking>
						<Glyph name="agent-run" size={18} />
					</span>
				) : pick ? (
					<ProjectIcon
						project={{
							name: project.name,
							icon: { kind: 'lucide', name: pick.name, color: pick.color, by: 'agent' },
						}}
						size={36}
					/>
				) : (
					<ProjectIcon project={project} slot={slot} size={36} />
				)}
				<div className={s.agentCopy}>
					<div className={s.agentTitle}>
						<Glyph name="generate" size={12} />
						<span>
							{t(
								locale,
								picking
									? 'Picking an icon…'
									: pick
										? 'Picked by the agent'
										: 'Not picked by the agent'
							)}
						</span>
					</div>
					{pick && !picking && <div className={s.agentWhy}>{pick.reason}</div>}
				</div>
				<Button size="s" data-icon-pick-again disabled={picking} onClick={onPickAgain}>
					<Glyph name="refresh" size={12} />
					{t(locale, pick ? 'Pick again' : 'Ask the agent')}
				</Button>
			</div>
			<div className={s.search} data-size="m">
				<SearchField
					locale={locale}
					label={t(locale, 'Search icons')}
					value={query}
					onChange={onQuery}
					data-icon-search
				/>
			</div>
			{!query.trim() && suggested.length > 0 && (
				<>
					<div className={s.label}>{t(locale, 'Suggested')}</div>
					<div className={s.suggested} role="group" aria-label={t(locale, 'Suggested')}>
						{suggested.map((name) => (
							<IconCell
								key={name}
								name={name}
								chosen={name === current}
								onChoose={onChoose}
								data-icon-suggested={name}
							/>
						))}
					</div>
				</>
			)}
			<div className={s.label}>
				{t(locale, 'All icons')}
				<span className={s.count} data-icon-count>
					{new Intl.NumberFormat(locale).format(
						tags ? found.length : Object.keys(icons ?? {}).length
					)}
				</span>
			</div>
			<IconGrid names={found} current={current} onChoose={onChoose} locale={locale} />
			{tags && !found.length && <p className={s.empty}>{t(locale, 'No icons found')}</p>}
		</>
	);
}
function IconCell({
	name,
	chosen,
	onChoose,
	tabIndex,
	...data
}: {
	name: string;
	chosen: boolean;
	onChoose(name: string): void;
	tabIndex?: number;
} & { [key: `data-${string}`]: string | undefined }) {
	return (
		<button
			{...data}
			type="button"
			className={s.cell}
			title={name}
			aria-label={name}
			aria-pressed={chosen}
			tabIndex={tabIndex}
			data-icon-cell={name}
			onClick={() => onChoose(name)}>
			<LucideIcon name={name} size={18} strokeWidth={1.75} />
		</button>
	);
}
/**
 * Every icon, 8 to a row; only the rows in view are drawn (1 899 icons). Three whole rows show; the rest
 * scroll. Arrows move between cells, Tab leaves the grid.
 */
function IconGrid({
	names,
	current,
	onChoose,
	locale,
}: {
	names: string[];
	current: string | null;
	onChoose(name: string): void;
	locale: Locale;
}) {
	const box = useRef<HTMLDivElement>(null),
		[top, setTop] = useState(0),
		[focus, setFocus] = useState(0);
	useEffect(() => {
		setFocus(0);
		setTop(0);
		if (box.current) box.current.scrollTop = 0;
	}, [names]);
	const rows = Math.ceil(names.length / columns),
		first = Math.max(0, Math.floor(top / rowHeight) - 1),
		last = Math.min(rows, first + visibleRows + 3);
	const move = (index: number) => {
		const next = Math.max(0, Math.min(names.length - 1, index));
		setFocus(next);
		const row = Math.floor(next / columns),
			element = box.current;
		if (element) {
			if (row * rowHeight < element.scrollTop) element.scrollTop = row * rowHeight;
			else if ((row + 1) * rowHeight > element.scrollTop + element.clientHeight)
				element.scrollTop = (row + 1) * rowHeight - element.clientHeight;
		}
		requestAnimationFrame(() =>
			box.current?.querySelector<HTMLButtonElement>(`[data-icon-index="${next}"]`)?.focus()
		);
	};
	return (
		<div
			ref={box}
			className={s.all}
			style={{ height: Math.max(0, Math.min(rows, visibleRows) * rowHeight - 2) }}
			role="group"
			aria-label={t(locale, 'All icons')}
			data-icon-grid
			onScroll={(event) => setTop(event.currentTarget.scrollTop)}
			onKeyDown={(event) => {
				const step =
					event.key === 'ArrowRight'
						? 1
						: event.key === 'ArrowLeft'
							? -1
							: event.key === 'ArrowDown'
								? columns
								: event.key === 'ArrowUp'
									? -columns
									: 0;
				if (!step) return;
				event.preventDefault();
				move(focus + step);
			}}>
			<div className={s.rows} style={{ height: rows * rowHeight }}>
				{Array.from({ length: last - first }, (_, offset) => {
					const row = first + offset;
					return (
						<div key={row} className={s.row} style={{ top: row * rowHeight }}>
							{names.slice(row * columns, row * columns + columns).map((name, column) => {
								const index = row * columns + column;
								return (
									<IconCell
										key={name}
										name={name}
										chosen={name === current}
										onChoose={(chosen) => {
											setFocus(index);
											onChoose(chosen);
										}}
										tabIndex={index === focus ? 0 : -1}
										data-icon-index={String(index)}
									/>
								);
							})}
						</div>
					);
				})}
			</div>
		</div>
	);
}
/**
 * spec/projects-and-board#project-icon: any image the browser decodes (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO) as a square PNG cut to its
 * centre, at most 512 px (a vector one is drawn at 512). The data URL keeps to the page's `img-src 'self' data:`.
 */
async function squarePng(file: Blob): Promise<Uint8Array> {
	if (file.size > 32 * 1024 * 1024) throw new Error('The image is too large');
	const url = await new Promise<string>((done, fail) => {
		const reader = new FileReader();
		reader.onload = () => done(String(reader.result));
		reader.onerror = () => fail(reader.error);
		reader.readAsDataURL(file);
	});
	const image = new Image();
	image.src = url;
	await image.decode();
	const vector = file.type === 'image/svg+xml',
		width = image.naturalWidth || projectImageSide,
		height = image.naturalHeight || projectImageSide,
		side = Math.min(width, height),
		size = vector ? projectImageSide : Math.min(projectImageSide, side);
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('No canvas');
	context.imageSmoothingQuality = 'high';
	context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
	const png = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
	if (!png) throw new Error('The image could not be encoded');
	return new Uint8Array(await png.arrayBuffer());
}
const imageFile = (items: Iterable<{ kind?: string; type: string; getAsFile?(): File | null }>) => {
	for (const item of items)
		if (item.type.startsWith('image/')) {
			const file = item.getAsFile ? item.getAsFile() : (item as unknown as File);
			if (file) return file;
		}
	return null;
};
/**
 * spec/projects-and-board#project-icon: `Your image` (chosen, dragged in or pasted; the file in the project's folder stays to come back to),
 * `Generate with Codex` (an optional line of what to show), and `Found in the repo`.
 */
function ImageTab({
	project,
	color,
	locale,
	onSave,
}: {
	project: Project;
	color: ProjectIconColor;
	locale: Locale;
	onSave(icon: Icon): void;
}) {
	const input = useRef<HTMLInputElement>(null),
		[own, setOwn] = useState<string | null>(null),
		[hint, setHint] = useState(''),
		[asking, setAsking] = useState(false),
		[dragging, setDragging] = useState(false);
	const generating = asking || !!project.iconGenerating,
		current = project.icon?.kind === 'image' ? project.icon : null;
	useEffect(() => {
		let live = true;
		void window.brigadir
			.readProjectImageIcon(project.id)
			.then((value) => live && setOwn(value))
			.catch(() => live && setOwn(null));
		return () => {
			live = false;
		};
	}, [project.id, current?.image]);
	const use = (file: Blob | null) => {
		if (!file) return;
		void squarePng(file)
			.then((png) => window.brigadir.setProjectImageIcon(project.id, png))
			.catch(() => toastError(t(locale, 'Could not use this image.')));
	};
	const generate = () => {
		setAsking(true);
		void window.brigadir
			.generateProjectIcon(project.id, hint)
			.then((result) => {
				if (result === 'off') toastError(t(locale, 'Codex is not available.'));
				if (result === 'failed') toastError(t(locale, 'Could not generate an icon.'));
			})
			.catch(() => toastError(t(locale, 'Could not generate an icon.')))
			.finally(() => setAsking(false));
	};
	return (
		<div
			className={s.imageTab}
			data-dragging={dragging || undefined}
			data-icon-image-tab
			onDragOver={(event) => {
				if (![...event.dataTransfer.items].some((item) => item.type.startsWith('image/'))) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = 'copy';
				setDragging(true);
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
			}}
			onDrop={(event) => {
				const file = imageFile(event.dataTransfer.files);
				setDragging(false);
				if (!file) return;
				event.preventDefault();
				use(file);
			}}
			onPaste={(event) => {
				if (event.target instanceof HTMLInputElement && event.target.type === 'text') return;
				const file = imageFile(event.clipboardData.items);
				if (!file) return;
				event.preventDefault();
				use(file);
			}}>
			<div className={s.label}>{t(locale, 'Your image')}</div>
			<div className={s.own} data-size="s">
				<button
					type="button"
					className={s.candidate}
					aria-pressed={!!current}
					disabled={!own || generating}
					data-icon-own=""
					onClick={() =>
						own && onSave({ kind: 'image', image: own, color, by: current?.by ?? 'person' })
					}>
					{generating ? (
						<span className={s.agentTile} data-generating>
							<Glyph name="agent-run" size={18} />
						</span>
					) : own ? (
						<img className={s.candidateImage} src={own} alt="" draggable={false} />
					) : (
						<span className={s.ownEmpty}>
							<Glyph name="image" size={16} />
						</span>
					)}
					<span className={s.candidateCopy}>
						<span>
							{t(
								locale,
								generating
									? 'Generating…'
									: own
										? current?.by === 'agent'
											? 'Drawn by Codex'
											: 'Your image'
										: 'No image yet'
							)}
						</span>
						<small className={s.ownNote}>{t(locale, 'Or drag or paste it')}</small>
					</span>
					{current && !generating && <Glyph name="check-pass" size={14} />}
				</button>
				<Button data-icon-choose onClick={() => input.current?.click()}>
					{t(locale, 'Choose file…')}
				</Button>
				<input
					ref={input}
					type="file"
					accept="image/*"
					hidden
					data-icon-file
					onChange={(event) => {
						use(event.currentTarget.files?.[0] ?? null);
						event.currentTarget.value = '';
					}}
				/>
			</div>
			<div className={s.label}>{t(locale, 'Generate with Codex')}</div>
			<div className={s.generate} data-size="m">
				<TextInput
					value={hint}
					maxLength={400}
					placeholder={t(locale, 'What should it show?')}
					aria-label={t(locale, 'What should it show?')}
					data-icon-hint
					onChange={(event) => setHint(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !generating) {
							event.preventDefault();
							generate();
						}
					}}
				/>
				<GenerateButton
					label={t(locale, 'Generate')}
					disabled={generating}
					data-icon-generate
					onClick={generate}
				/>
			</div>
			<RepoTab project={project} color={color} locale={locale} />
		</div>
	);
}
function RepoTab({
	project,
	color,
	locale,
}: {
	project: Project;
	color: ProjectIconColor;
	locale: Locale;
}) {
	const [found, setFound] = useState<RepoIconCandidate[] | null>(null);
	useEffect(() => {
		let live = true;
		void window.brigadir
			.readProjectRepoIcons(project.id)
			.then((value) => live && setFound(value))
			.catch(() => live && setFound([]));
		return () => {
			live = false;
		};
	}, [project.id]);
	const chosen = project.icon?.kind === 'repo' ? project.icon.path : null;
	return (
		<>
			<div className={s.label}>{t(locale, 'Found in the repo')}</div>
			{found === null ? (
				<p className={s.empty}>{t(locale, 'Looking in the repo…')}</p>
			) : found.length ? (
				<div className={s.candidates} role="group" aria-label={t(locale, 'Found in the repo')}>
					{found.map((item) => (
						<button
							key={item.path}
							type="button"
							className={s.candidate}
							aria-pressed={item.path === chosen}
							data-icon-repo={item.path}
							onClick={() =>
								void window.brigadir
									.setProjectRepoIcon(project.id, item.path, color)
									.catch(() => toastError(t(locale, 'Could not save the project icon.')))
							}>
							<img className={s.candidateImage} src={item.image} alt="" draggable={false} />
							<span className={s.candidateCopy}>
								<span>{t(locale, repoNames[item.kind])}</span>
								<small>{item.path}</small>
							</span>
							{item.path === chosen && <Glyph name="check-pass" size={14} />}
						</button>
					))}
				</div>
			) : (
				<p className={s.empty}>{t(locale, 'No app icon in the repo')}</p>
			)}
		</>
	);
}
