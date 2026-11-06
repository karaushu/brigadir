import { createElement, type CSSProperties } from 'react';
import {
	projectIconColorAt,
	projectMonogram,
	type Project,
	type ProjectIconColor,
} from '@brigadir/core';
import { useLucide } from '../project-icons';
import s from './ProjectIcon.module.css';

/** A Lucide icon from the vendored set (spec/appearance#evolution-redesign), drawn from its nodes; empty until the set has loaded. */
export function LucideIcon({
	name,
	size,
	strokeWidth = 2,
}: {
	name: string;
	size: number;
	strokeWidth?: number;
}) {
	const { icons } = useLucide();
	return (
		<svg
			className={s.lucide}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			data-lucide={name}>
			{icons?.[name]?.map(([tag, attributes], index) =>
				createElement(tag, { key: index, ...attributes })
			)}
		</svg>
	);
}
/** Tile size → corner radius, glyph and stroke, monogram letters (22 in the sidebar, 36 and 48 in the picker). */
const metrics = {
	14: { radius: 4, glyph: 10, stroke: 2.2, letters: 9 },
	18: { radius: 5, glyph: 12, stroke: 2.1, letters: 8.5 },
	22: { radius: 6, glyph: 14, stroke: 2.1, letters: 10 },
	36: { radius: 9, glyph: 22, stroke: 2, letters: 15 },
	48: { radius: 12, glyph: 28, stroke: 2, letters: 23 },
} as const;
export type ProjectIconSize = keyof typeof metrics;
/** The colour a project shows: its icon's, or before it has one the slot it had as a dot. */
export function projectIconColor(project: Project, slot: number): ProjectIconColor {
	return project.icon?.color ?? projectIconColorAt(slot);
}
/** spec/sidebar#project-groups: the tone a sidebar header hands to the fold button that lies over its tile. */
export function projectToneStyle(project: Pick<Project, 'icon'>, slot: number): CSSProperties {
	return {
		'--project-tone': `var(--icon-${project.icon?.color ?? projectIconColorAt(slot)})`,
	} as CSSProperties;
}
/**
 * spec/appearance#evolution-redesign: the project's icon in place of the coloured dot — a Lucide icon on a tile of its colour, the app icon from
 * the repo, the person's or Codex's image (spec/projects-and-board#project-icon), or the monogram of the name (also before the agent has picked). One look everywhere: the sidebar, boards, the
 * archive, the task header's repo chip and the picker (rule 17).
 */
export function ProjectIcon({
	project,
	slot = 0,
	size = 18,
	className,
}: {
	project: Pick<Project, 'name' | 'icon'>;
	slot?: number;
	size?: ProjectIconSize;
	className?: string | undefined;
}) {
	const icon = project.icon,
		color = icon?.color ?? projectIconColorAt(slot),
		metric = metrics[size];
	const style = {
		'--icon-tone': `var(--icon-${color})`,
		'--icon-size': `${size}px`,
		'--icon-radius': `${metric.radius}px`,
		'--icon-letters': `${metric.letters}px`,
	} as CSSProperties;
	const kind = icon?.kind ?? 'monogram';
	return (
		<span
			className={`${s.tile}${className ? ` ${className}` : ''}`}
			style={style}
			data-project-icon={kind}
			data-icon-color={color}
			data-icon-name={icon?.kind === 'lucide' ? icon.name : undefined}
			aria-hidden="true">
			{icon?.kind === 'lucide' ? (
				<LucideIcon name={icon.name} size={metric.glyph} strokeWidth={metric.stroke} />
			) : icon?.kind === 'repo' || icon?.kind === 'image' ? (
				<img className={s.image} src={icon.image} alt="" draggable={false} />
			) : (
				<span className={s.letters}>
					{/* A 14 px tile (the task header, boards, the archive) holds one letter. */}
					{size === 14 ? [...projectMonogram(project.name)][0] : projectMonogram(project.name)}
				</span>
			)}
		</span>
	);
}
