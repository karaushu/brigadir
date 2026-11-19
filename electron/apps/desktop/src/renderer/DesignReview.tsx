import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
	designCounts,
	designMatchCount,
	designMismatchCount,
	designNodeCount,
	designNodeLabel,
	designRowCount,
	designShotCount,
	formatTime,
	providerName,
	t,
	type AgentTask,
	type DesignArea,
	type DesignNode,
	type EventRecord,
	type Locale,
	type MessageKey,
	type TaskKey,
} from '@brigadir/core';
import { ChatCard } from './ui/ChatCard';
import { Glyph } from './ui/Glyph';
import { Popover } from './ui/Popover';
import { Tag, type TagTone } from './ui/Tag';
import { CardFold } from './Crew';
import service from './Crew.module.css';
import s from './DesignReview.module.css';

type Reviewed = Extract<EventRecord['event'], { kind: 'design.reviewed' }>;

/** A design review's images, read once per file while the window lives (the newest 80). */
const images = new Map<string, Promise<{ src: string; width: number; height: number }>>();
function loadImage(task: TaskKey, file: string) {
	const key = `${task.projectId}/${task.id}/${file}`;
	let found = images.get(key);
	if (!found) {
		found = window.brigadir.readDesignImage(task, file).then(async (src) => {
			const image = new Image();
			image.src = src;
			await image.decode();
			return { src, width: image.naturalWidth, height: image.naturalHeight };
		});
		found.catch(() => images.delete(key));
		images.set(key, found);
		if (images.size > 80) images.delete(images.keys().next().value!);
	}
	return found;
}
/**
 * spec/design-review#card: an image of a tile — fitted, cropped to the node's area when it has one, with the mismatched rows' areas outlined.
 * One SVG holds the picture and the outlines in the image's own pixels, so they stay on the element at any size.
 */
function DesignImage({
	task,
	file,
	crop,
	marks = [],
}: {
	task: TaskKey;
	file: string;
	crop?: DesignArea | undefined;
	marks?: readonly DesignArea[];
}) {
	const [image, setImage] = useState<{ src: string; width: number; height: number } | false | null>(
		null
	);
	const clip = useId();
	useEffect(() => {
		let live = true;
		setImage(null);
		loadImage(task, file).then(
			(value) => live && setImage(value),
			() => live && setImage(false)
		);
		return () => {
			live = false;
		};
	}, [task.projectId, task.id, file]);
	if (image === false) return <Glyph name="image-off" size={16} />;
	if (!image) return null;
	const box = crop ?? { x: 0, y: 0, width: 1, height: 1 };
	const area = {
		x: box.x * image.width,
		y: box.y * image.height,
		width: Math.max(1, box.width * image.width),
		height: Math.max(1, box.height * image.height),
	};
	return (
		<svg
			className={s.picture}
			viewBox={`${area.x} ${area.y} ${area.width} ${area.height}`}
			preserveAspectRatio="xMidYMid meet"
			aria-hidden="true">
			{/* The crop: what lies outside the node's area is not drawn where the tile is wider than the area. */}
			<clipPath id={clip}>
				<rect {...area} />
			</clipPath>
			<g clipPath={`url(#${clip})`}>
				<image href={image.src} width={image.width} height={image.height} />
				{marks.map((mark, index) => (
					<rect
						key={index}
						className={s.mark}
						x={mark.x * image.width}
						y={mark.y * image.height}
						width={mark.width * image.width}
						height={mark.height * image.height}
						rx={3}
						vectorEffect="non-scaling-stroke"
					/>
				))}
			</g>
		</svg>
	);
}
const marksOf = (node: DesignNode) =>
	node.state === 'ok' ? node.rows.flatMap((row) => (!row.match && row.area ? [row.area] : [])) : [];
/** spec/design-review#card: the `Figma | Device` pair of a node; a tile opens the viewer. */
function Pair({
	task,
	node,
	locale,
	large = false,
	open,
}: {
	task: TaskKey;
	node: DesignNode;
	locale: Locale;
	large?: boolean;
	open?: ((anchor: HTMLButtonElement) => void) | undefined;
}) {
	const id = designNodeLabel(node.figma);
	const tile = (
		side: 'figma' | 'device',
		body: ReactNode,
		caption: ReactNode,
		state?: 'warn' | 'old'
	) => {
		const content = (
			<>
				<span className={s.image}>{body}</span>
				<span className={s.caption}>{caption}</span>
			</>
		);
		return open ? (
			<button
				type="button"
				className={s.tile}
				data-side={side}
				data-state={state}
				aria-label={t(locale, 'Images of {node}').replace('{node}', node.name)}
				onClick={(event) => open(event.currentTarget)}>
				{content}
			</button>
		) : (
			<div className={s.tile} data-side={side} data-state={state} data-static>
				{content}
			</div>
		);
	};
	const missing = (text: string) => (
		<>
			<Glyph name="image" size={16} />
			{text}
		</>
	);
	const shot = node.shot;
	return (
		<div className={s.pair} data-large={large || undefined}>
			{tile(
				'figma',
				node.figmaFile ? (
					<DesignImage task={task} file={node.figmaFile} />
				) : (
					missing(t(locale, 'No design image'))
				),
				<>
					<b>{t(locale, 'Figma')}</b>
					<span className={s.mono}>{id}</span>
				</>,
				node.figmaFile ? undefined : 'warn'
			)}
			{tile(
				'device',
				shot && node.state !== 'no-shot' ? (
					<DesignImage task={task} file={shot.file} crop={node.area} marks={marksOf(node)} />
				) : (
					missing(t(locale, 'No screenshot'))
				),
				<>
					<b>{t(locale, 'Device')}</b>
					{shot && node.state !== 'no-shot' && (
						<span className={s.mono}>
							{large
								? [shot.id, shot.device, formatTime(shot.at)].filter(Boolean).join(' · ')
								: shot.id}
						</span>
					)}
					{node.state === 'old-shot' && (
						<span className={s.old}>{t(locale, 'before the last change')}</span>
					)}
				</>,
				node.state === 'no-shot' ? 'warn' : node.state === 'old-shot' ? 'old' : undefined
			)}
		</div>
	);
}
const notAccepted: Record<Exclude<DesignNode['state'], 'ok'>, [MessageKey, TagTone]> = {
	'old-shot': ['old screenshot', 'amber'],
	'no-shot': ['no screenshot', 'red'],
	'no-figma': ['no design image', 'red'],
};
/** spec/design-review#card: the node's rows — property, expected, on device, then a check or a tag. */
function Rows({ node, locale }: { node: DesignNode; locale: Locale }) {
	return (
		<>
			{(['Property', 'Expected', 'On device'] as const).map((head) => (
				<span key={head} className={s.head} role="columnheader">
					{t(locale, head)}
				</span>
			))}
			<span className={s.head} role="columnheader" />
			{node.rows.map((row, index) => {
				const bad = node.state === 'ok' && !row.match;
				return (
					<div key={index} className={s.row} role="row" data-mismatch={bad || undefined}>
						<span role="cell">{row.property}</span>
						<span role="cell" className={s.value}>
							{row.expected}
						</span>
						<span role="cell" className={s.value} data-actual>
							{row.actual}
						</span>
						<span role="cell">
							{node.state !== 'ok' ? (
								<Tag tone={notAccepted[node.state][1]}>{t(locale, notAccepted[node.state][0])}</Tag>
							) : row.match ? (
								<span className={s.ok}>
									<Glyph name="check-pass" size={12} />
								</span>
							) : (
								<Tag tone="amber">{t(locale, 'mismatch')}</Tag>
							)}
						</span>
					</div>
				);
			})}
		</>
	);
}
/** spec/design-review#card: every node — its chip and id, the pair, its rows — in one grid, so the columns line up across nodes. */
function DesignTable({
	task,
	nodes,
	locale,
}: {
	task: AgentTask;
	nodes: readonly DesignNode[];
	locale: Locale;
}) {
	const [viewing, setViewing] = useState<number | null>(null);
	const anchor = useRef<HTMLButtonElement | null>(null);
	const node = viewing === null ? null : nodes[viewing];
	return (
		<div className={s.table} role="table">
			{nodes.map((item, index) => (
				<div key={index} className={s.node} role="rowgroup">
					<div className={s.nodeHead} role="row">
						<span role="cell" className={s.chip}>
							<Glyph name="link" size={11} />
							<span>{item.name}</span>
						</span>
						<span className={s.mono}>{designNodeLabel(item.figma)}</span>
					</div>
					<Pair
						task={task}
						node={item}
						locale={locale}
						open={(element) => {
							anchor.current = element;
							setViewing(index);
						}}
					/>
					<Rows node={item} locale={locale} />
				</div>
			))}
			{node && (
				<Popover
					open
					onClose={() => setViewing(null)}
					anchor={anchor}
					label={node.name}
					title={node.name}
					note={<span className={s.mono}>{designNodeLabel(node.figma)}</span>}
					locale={locale}
					width={500}
					data-design-viewer>
					<div className={s.viewer}>
						<Pair task={task} node={node} locale={locale} large />
						<div className={s.table} role="table">
							<Rows node={node} locale={locale} />
						</div>
					</div>
				</Popover>
			)}
		</div>
	);
}
/** spec/design-review#card: the foot's counts. */
export function designCountsLine(locale: Locale, nodes: readonly DesignNode[]) {
	const counts = designCounts(nodes);
	return [
		designRowCount(locale, counts.rows),
		counts.match ? designMatchCount(locale, counts.match) : '',
		counts.mismatch ? designMismatchCount(locale, counts.mismatch) : '',
		counts.old ? t(locale, '{n} with an old screenshot').replace('{n}', String(counts.old)) : '',
		counts.noShot
			? t(locale, '{n} without a screenshot').replace('{n}', String(counts.noShot))
			: '',
		counts.noFigma
			? t(locale, '{n} without a design image').replace('{n}', String(counts.noFigma))
			: '',
	]
		.filter(Boolean)
		.join(' · ');
}
/**
 * spec/design-review#card: a design review in the chat — the card while it is not passed (and a service row when the host refused rows), the
 * folded row once it passed.
 */
export function DesignReviewRow({
	task,
	record,
	locale,
	open,
	onToggle,
}: {
	task: AgentTask;
	record: EventRecord;
	locale: Locale;
	open: boolean;
	onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void;
}) {
	const e = record.event as Reviewed;
	const counts = designCounts(e.nodes);
	if (e.state === 'passed')
		return (
			<CardFold
				glyph="agent-idle"
				data={{ 'data-design-review': e.id, 'data-state': e.state }}
				title={t(locale, 'Design review passed')}
				count=""
				tail={
					<small>
						{e.screen} · {designRowCount(locale, counts.rows)} ·{' '}
						{designShotCount(locale, counts.shots)}
					</small>
				}
				at={record.at}
				open={open}
				onToggle={onToggle}>
				<DesignTable task={task} nodes={e.nodes} locale={locale} />
			</CardFold>
		);
	const agent = task.provider ? providerName(task.provider) : 'Agent';
	return (
		<>
			<ChatCard
				glyph="image"
				title={t(locale, 'Design review')}
				hint={`${e.screen} · ${designNodeCount(locale, e.nodes.length)}`}
				note={designCountsLine(locale, e.nodes)}
				data-design-review={e.id}
				data-state={e.state}>
				<DesignTable task={task} nodes={e.nodes} locale={locale} />
			</ChatCard>
			{counts.notAccepted > 0 && (
				<div className={service.service} data-design-row="refused">
					<Glyph name="image" size={12} />
					<small>{t(locale, 'design')}</small>
					<span className={service.label}>{e.screen}</span>
					<small className={service.warn}>
						{t(locale, '{rows} not accepted').replace(
							'{rows}',
							designRowCount(locale, counts.notAccepted)
						)}
					</small>
					<small>{t(locale, '{agent} takes new screenshots').replace('{agent}', agent)}</small>
				</div>
			)}
		</>
	);
}
