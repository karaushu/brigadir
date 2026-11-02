/**
 * spec/remote-access-and-mobile#phone-app: the phone's glyphs, 16 × 16.
 * The task states, the providers and the helmet stay `ui/Glyph` and `ui/StatusIcon`, as on the computer.
 */
import type { ReactNode } from 'react';

const s = {
	stroke: 'currentColor',
	strokeWidth: 1.4,
	strokeLinecap: 'round',
	strokeLinejoin: 'round',
} as const;
const s2 = { ...s, strokeWidth: 1.7 } as const;
const glyphs = {
	back: <path d="M10.5 2.5 4.5 8.5l6 6" {...s2} />,
	arrow: (
		<path
			d="M13.4 8H3M7.4 3.4 2.8 8l4.6 4.6"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	),
	chev: <path d="M4.5 6.5 8 10l3.5-3.5" {...s} />,
	chevr: <path d="M6.5 4 10 8l-3.5 4" {...s} />,
	plus: <path d="M8 2.8v10.4M2.8 8h10.4" {...s} />,
	close: <path d="M4 4l8 8M12 4l-8 8" {...s} />,
	search: (
		<>
			<circle cx="7.2" cy="7.2" r="4.4" {...s} />
			<path d="M10.5 10.5 13.6 13.6" {...s} />
		</>
	),
	filter: <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" {...s} />,
	more: (
		<>
			<circle cx="3.4" cy="8" r="1.25" fill="currentColor" />
			<circle cx="8" cy="8" r="1.25" fill="currentColor" />
			<circle cx="12.6" cy="8" r="1.25" fill="currentColor" />
		</>
	),
	vmore: (
		<>
			<circle cx="8" cy="3.4" r="1.25" fill="currentColor" />
			<circle cx="8" cy="8" r="1.25" fill="currentColor" />
			<circle cx="8" cy="12.6" r="1.25" fill="currentColor" />
		</>
	),
	machine: (
		<>
			<rect x="1.8" y="2.6" width="12.4" height="8.4" rx="1.6" {...s} />
			<path d="M6 13.6h4M8 11v2.6" {...s} />
		</>
	),
	branch: (
		<>
			<circle cx="4.5" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.2" />
			<circle cx="4.5" cy="12.5" r="1.7" stroke="currentColor" strokeWidth="1.2" />
			<circle cx="11.5" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.2" />
			<path
				d="M4.5 5.2v5.6M11.5 7.2c0 2.6-2.4 2.6-4.7 3.2"
				stroke="currentColor"
				strokeWidth="1.2"
			/>
		</>
	),
	diff: (
		<>
			<path d="M5 2.5v6M2 5.5h6M2.5 12.5h6" {...s} />
			<path d="M11 3v10" {...s} />
		</>
	),
	pr: (
		<>
			<circle cx="4.5" cy="3.6" r="1.6" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="4.5" cy="12.4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="11.5" cy="12.4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
			<path
				d="M4.5 5.2v5.6M11.5 10.8V6.2a1.8 1.8 0 0 0-1.8-1.8H7.4M8.8 2.8 7.2 4.4l1.6 1.6"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</>
	),
	folder: (
		<path
			d="M1.8 4.4a1 1 0 0 1 1-1h3.1l1.4 1.6h5.9a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"
			stroke="currentColor"
			strokeWidth="1.3"
			strokeLinejoin="round"
		/>
	),
	file: (
		<>
			<path
				d="M9.2 1.8H4.4a1.2 1.2 0 0 0-1.2 1.2v10a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V5.4z"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinejoin="round"
			/>
			<path d="M9 2v3.6h3.6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
		</>
	),
	term: (
		<>
			<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.8" {...s} />
			<path d="M4.6 6.2 6.8 8l-2.2 1.8M8.6 10h3" {...s} />
		</>
	),
	stop: <rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor" />,
	up: <path d="M8 13V3.4M3.8 7.4 8 3.2l4.2 4.2" {...s2} />,
	down: <path d="M8 3v9.6M3.8 8.6 8 12.8l4.2-4.2" {...s2} />,
	camera: (
		<>
			<path
				d="M2 5.6a1.2 1.2 0 0 1 1.2-1.2h1.9l1.1-1.6h3.6l1.1 1.6h1.9A1.2 1.2 0 0 1 14 5.6v6.2a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8z"
				{...s}
			/>
			<circle cx="8" cy="8.6" r="2.4" {...s} />
		</>
	),
	photo: (
		<>
			<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8" {...s} />
			<circle cx="5.6" cy="6.4" r="1.2" {...s} />
			<path d="m2.4 12 3.8-3.6 2.6 2.4 1.8-1.6 3.4 3" {...s} />
		</>
	),
	tick: (
		<path
			d="M3.4 8.4 6.5 11.4 12.6 4.8"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	),
	lock: (
		<>
			<rect x="3.4" y="7" width="9.2" height="6.6" rx="1.6" {...s} />
			<path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" {...s} />
		</>
	),
	bell: (
		<>
			<path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1.2 1.4H2.8z" {...s} />
			<path d="M6.6 14h2.8" {...s} />
		</>
	),
	/** spec/remote-access-and-mobile#phone-pr-list: Board in the project's header. */
	board: (
		<g stroke="currentColor" strokeWidth="1.2">
			<rect x="1.8" y="2.6" width="3.6" height="10.8" rx="1.2" />
			<rect x="6.2" y="2.6" width="3.6" height="7.4" rx="1.2" />
			<rect x="10.6" y="2.6" width="3.6" height="5" rx="1.2" />
		</g>
	),
	/** spec/remote-access-and-mobile#phone-pr-list: the pull to refresh (`arrowdn`). */
	arrowdn: <path d="M8 3v9.6M3.8 8.6 8 12.8l4.2-4.2" {...s2} />,
	list: (
		<>
			<path d="M5.6 4h8M5.6 8h8M5.6 12h8" {...s} />
			<circle cx="2.6" cy="4" r=".9" fill="currentColor" />
			<circle cx="2.6" cy="8" r=".9" fill="currentColor" />
			<circle cx="2.6" cy="12" r=".9" fill="currentColor" />
		</>
	),
	moon: <path d="M12.8 10.2A5.6 5.6 0 0 1 5.8 3.2a5.6 5.6 0 1 0 7 7z" {...s} />,
	share: (
		<>
			<path d="M8 10V2.4M5.2 5 8 2.2 10.8 5" {...s} />
			<path
				d="M5 7H3.8a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H11"
				{...s}
			/>
		</>
	),
	addsq: (
		<>
			<rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.6" {...s} />
			<path d="M8 5.2v5.6M5.2 8h5.6" {...s} />
		</>
	),
	key: (
		<>
			<circle cx="5.2" cy="10.8" r="2.8" {...s} />
			<path d="m7.2 8.8 5.6-5.6M10.8 5.2l1.6 1.6M9.4 6.6l1.2 1.2" {...s} />
		</>
	),
	faceid: (
		<>
			<path
				d="M2.4 5.4V3.6a1.2 1.2 0 0 1 1.2-1.2h1.8M10.6 2.4h1.8a1.2 1.2 0 0 1 1.2 1.2v1.8M13.6 10.6v1.8a1.2 1.2 0 0 1-1.2 1.2h-1.8M5.4 13.6H3.6a1.2 1.2 0 0 1-1.2-1.2v-1.8"
				{...s}
			/>
			<path d="M5.6 6v1M10.4 6v1M8 6v2.8l-.8.4M6 10.6c1.2 1 2.8 1 4 0" {...s} />
		</>
	),
	eye: (
		<>
			<path d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8s-2.4 4.4-6.4 4.4S1.6 8 1.6 8z" {...s} />
			<circle cx="8" cy="8" r="2" {...s} />
		</>
	),
	tools: (
		<>
			<rect x="2.2" y="4.6" width="11.6" height="8.6" rx="1.6" {...s} />
			<path d="M5.8 4.6V3.4a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1v1.2M2.2 8.4h11.6" {...s} />
		</>
	),
	plan: (
		<>
			<path d="M5.6 4h8M5.6 8h8M5.6 12h5" {...s} />
			<path d="M2 4h1M2 8h1M2 12h1" {...s} />
		</>
	),
	out: (
		<path
			d="M6.4 13.6H3.6a1.2 1.2 0 0 1-1.2-1.2V3.6a1.2 1.2 0 0 1 1.2-1.2h2.8M10.4 11.2 13.6 8l-3.2-3.2M13.4 8H6.4"
			{...s}
		/>
	),
	theme: (
		<>
			<circle cx="8" cy="8" r="5.6" {...s} />
			<path d="M8 2.4v11.2A5.6 5.6 0 0 0 8 2.4z" fill="currentColor" />
		</>
	),
	clock: (
		<path
			d="M4.4 2.4h7.2M4.4 13.6h7.2M5.2 2.4c0 3 5.6 3.2 5.6 5.6s-5.6 2.6-5.6 5.6M10.8 2.4c0 3-5.6 3.2-5.6 5.6s5.6 2.6 5.6 5.6"
			{...s}
		/>
	),
	x2: (
		<>
			<circle cx="8" cy="8" r="6.4" {...s} />
			<path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" {...s} />
		</>
	),
	refresh: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6" {...s} />,
	// spec/remote-access-and-mobile#phone-task-tools: the task tools' glyphs.
	wrap: <path d="M2.4 4h11.2M2.4 8h9a2 2 0 0 1 0 4H8.6M2.4 12h3.2M10 10.6 8.6 12l1.4 1.4" {...s} />,
	link: (
		<path
			d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"
			{...s}
		/>
	),
	spark: (
		<>
			<path
				d="M8 1.8c.4 2.9 1.4 4 4.3 4.4-2.9.4-3.9 1.5-4.3 4.4-.4-2.9-1.4-4-4.3-4.4 2.9-.4 3.9-1.5 4.3-4.4z"
				fill="currentColor"
			/>
			<path
				d="M12.6 9.6c.2 1.4.7 1.9 2.1 2.1-1.4.2-1.9.7-2.1 2.1-.2-1.4-.7-1.9-2.1-2.1 1.4-.2 1.9-.7 2.1-2.1z"
				fill="currentColor"
			/>
		</>
	),
	hourglass: (
		<path
			d="M4.4 2.4h7.2M4.4 13.6h7.2M5.2 2.4c0 3 5.6 3.2 5.6 5.6s-5.6 2.6-5.6 5.6M10.8 2.4c0 3-5.6 3.2-5.6 5.6s5.6 2.6 5.6 5.6"
			{...s}
		/>
	),
	alert: (
		<>
			<circle cx="8" cy="8" r="7" fill="var(--red)" opacity=".3" />
			<path d="M8 4.4v4.2" stroke="var(--red)" strokeWidth="1.7" strokeLinecap="round" />
			<circle cx="8" cy="11.4" r="1" fill="var(--red)" />
		</>
	),
	prOpen: (
		<>
			<circle cx="4.5" cy="3.6" r="1.6" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="4.5" cy="12.4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="11.5" cy="12.4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
			<path
				d="M4.5 5.2v5.6M11.5 10.8V6.2a1.8 1.8 0 0 0-1.8-1.8H7.4M8.8 2.8 7.2 4.4l1.6 1.6"
				{...s}
				strokeWidth="1.3"
			/>
		</>
	),
	comment: (
		<path
			d="M2.4 4a1.2 1.2 0 0 1 1.2-1.2h8.8A1.2 1.2 0 0 1 13.6 4v6a1.2 1.2 0 0 1-1.2 1.2H7l-3 2.4v-2.4h-.4A1.2 1.2 0 0 1 2.4 10z"
			{...s}
		/>
	),
	archive: (
		<>
			<rect x="2" y="2.8" width="12" height="3.4" rx="1" stroke="currentColor" strokeWidth="1.3" />
			<path
				d="M3.2 6.2v6a1.1 1.1 0 0 0 1.1 1.1h7.4a1.1 1.1 0 0 0 1.1-1.1v-6M6.4 8.9h3.2"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinecap="round"
			/>
		</>
	),
	copy: (
		<>
			<rect x="5.2" y="5.2" width="8.4" height="8.4" rx="1.4" {...s} />
			<path
				d="M10.8 5.2V3.6a1.2 1.2 0 0 0-1.2-1.2H3.6a1.2 1.2 0 0 0-1.2 1.2v6a1.2 1.2 0 0 0 1.2 1.2h1.6"
				{...s}
			/>
		</>
	),
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof glyphs;
export function Icon({
	name,
	size = 16,
	className,
	label,
}: {
	name: IconName;
	size?: number;
	className?: string | undefined;
	label?: string;
}) {
	return (
		<svg
			{...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
			className={className}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			data-icon={name}
			data-keep-size>
			{glyphs[name]}
		</svg>
	);
}
