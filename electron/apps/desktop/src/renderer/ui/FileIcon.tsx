import { fileKind } from '@brigadir/core';
import styles from './FileIcon.module.css';
// spec/task-window#files-look: the SVG of the Files tree rows; badges and text marks are type, not SVG.
const lines = <path d="M3 4.5h10M3 8h10M3 11.5h6.5" />;
export function FileIcon({
	name,
	directory = false,
	library = false,
}: {
	name: string;
	directory?: boolean;
	library?: boolean;
}) {
	if (directory)
		return (
			<svg
				data-glyph="ft-folder"
				aria-hidden="true"
				className={styles.folder}
				data-library={library}
				width="16"
				height="16"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.25"
				strokeLinejoin="round">
				<path d="M1.8 4.4a1 1 0 0 1 1-1h3.1l1.4 1.7h6.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
			</svg>
		);
	const kind = fileKind(name);
	switch (kind) {
		case 'ts':
		case 'js':
			return (
				<span aria-hidden="true" className={styles.slot} data-kind={kind}>
					<span className={styles.badge}>{kind.toUpperCase()}</span>
				</span>
			);
		case 'json':
		case 'md':
		case 'shell':
			return (
				<span aria-hidden="true" className={`${styles.slot} ${styles.glyph}`} data-kind={kind}>
					{kind === 'json' ? '{}' : kind === 'md' ? 'M↓' : '>_'}
				</span>
			);
		case 'react':
			return (
				<svg
					data-glyph="ft-react"
					aria-hidden="true"
					className={styles.svg}
					data-kind={kind}
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1">
					<ellipse cx="8" cy="8" rx="6.6" ry="2.5" />
					<ellipse cx="8" cy="8" rx="6.6" ry="2.5" transform="rotate(60 8 8)" />
					<ellipse cx="8" cy="8" rx="6.6" ry="2.5" transform="rotate(120 8 8)" />
					<circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
				</svg>
			);
		case 'docker':
			return (
				<svg
					data-glyph="ft-docker"
					aria-hidden="true"
					className={styles.svg}
					data-kind={kind}
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="currentColor">
					<rect x="2.8" y="5.2" width="2.1" height="1.9" rx=".3" />
					<rect x="5.3" y="5.2" width="2.1" height="1.9" rx=".3" />
					<rect x="7.8" y="5.2" width="2.1" height="1.9" rx=".3" />
					<rect x="5.3" y="2.9" width="2.1" height="1.9" rx=".3" />
					<rect x="7.8" y="2.9" width="2.1" height="1.9" rx=".3" />
					<path d="M1 7.8h11.6c.4-.9 1.4-1.3 2.3-1.1.1.9-.3 1.7-1.1 2.1-.9 2.6-3.4 4.2-6.7 4.2-3.3 0-5.4-1.8-6.1-5.2z" />
				</svg>
			);
		case 'git':
			return (
				<svg
					data-glyph="ft-git"
					aria-hidden="true"
					className={styles.svg}
					data-kind={kind}
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5">
					<circle cx="8" cy="8" r="5.4" />
					<path d="M4.2 11.8 11.8 4.2" />
				</svg>
			);
		case 'image':
			return (
				<svg
					data-glyph="ft-image"
					aria-hidden="true"
					className={styles.svg}
					data-kind={kind}
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinejoin="round">
					<rect x="2" y="3" width="12" height="10" rx="1.5" />
					<circle cx="5.6" cy="6.4" r="1.2" />
					<path d="M2.4 12 6.6 8.4l2.6 2.2 1.8-1.4 2.6 2.4" />
				</svg>
			);
		case 'lock':
			return (
				<svg
					data-glyph="ft-lock"
					aria-hidden="true"
					className={styles.svg}
					data-kind={kind}
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinejoin="round">
					<rect x="3.2" y="7" width="9.6" height="7" rx="1.4" />
					<path d="M5.4 7V5a2.6 2.6 0 0 1 5.2 0v2" />
				</svg>
			);
		default:
			return (
				<svg
					data-glyph="ft-lines"
					aria-hidden="true"
					className={styles.svg}
					data-kind={kind}
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.4"
					strokeLinecap="round">
					{lines}
				</svg>
			);
	}
}
