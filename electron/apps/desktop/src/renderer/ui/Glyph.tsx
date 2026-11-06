// Original SVG sources are recorded in docs/third-party-assets.md.
import type { ReactNode } from 'react';
export type GlyphName =
	| 'remote'
	| 'folder-browse'
	| 'folder-up'
	| 'machine'
	| 'laptop'
	| 'unlink'
	| 'log'
	| 'bell'
	| 'bell-on'
	| 'speaker'
	| 'speaker-muted'
	| 'check-queued'
	| 'check-skipped'
	| 'deploy'
	| 'globe'
	| 'cut'
	| 'copy-text'
	| 'paste'
	| 'paste-plain'
	| 'delete'
	| 'select-all'
	| 'redo'
	| 'copy-line'
	| 'link'
	| 'revert'
	| 'comment-toggle'
	| 'format'
	| 'indent'
	| 'outdent'
	| 'references'
	| 'completions'
	| 'parameters'
	| 'replace'
	| 'find-in-files'
	| 'problem-next'
	| 'problem-previous'
	| 'change-next'
	| 'change-previous'
	| 'needs-next'
	| 'needs-previous'
	| 'block-next'
	| 'block-previous'
	| 'turn-next'
	| 'turn-previous'
	| 'tab-next'
	| 'tab-previous'
	| 'group-next'
	| 'group-previous'
	| 'expand-all'
	| 'collapse-all'
	| 'quit'
	| 'minimize'
	| 'zoom'
	| 'fullscreen'
	| 'front'
	| 'hide-others'
	| 'font-larger'
	| 'font-smaller'
	| 'font-reset'
	| 'bold'
	| 'italic'
	| 'format-text'
	| 'text-replace'
	| 'quotes'
	| 'dash'
	| 'speech'
	| 'mode-next'
	| 'duplicate'
	| 'pin'
	| 'split-right'
	| 'split-down'
	| 'under-chat'
	| 'tab-close-others'
	| 'tab-close-all'
	| 'tab-close-clean'
	| 'tab-close-right'
	| 'copy-absolute'
	| 'split-move-right'
	| 'split-move-down'
	| 'group-move'
	| 'unsplit'
	| 'unsplit-all'
	| 'git-pull'
	| 'git-stash'
	| 'git-unstash'
	| 'task-new'
	| 'editor-toggle'
	| 'editor-toggle-off'
	| 'archive-box'
	| 'archive-restore'
	| 'archive-warn'
	| 'search-action'
	| 'search-setting'
	| 'search-repo'
	| 'search-more'
	| 'search-previous'
	| 'search-mask'
	| 'agent-key'
	| 'image'
	| 'send-plane'
	| 'chevron-down'
	| 'turn-done'
	| 'tick'
	| 'commit-dot'
	| 'list-bullets'
	| 'chevron-left'
	| 'pr-draft'
	| 'pr-merged'
	| 'pr-closed'
	| 'review-changes'
	| 'check-run'
	| 'bubble'
	| 'xmark'
	| 'simulator'
	| 'sim-home'
	| 'sim-rotate'
	| 'sim-devtools'
	| 'platform-android'
	| 'platform-apple'
	| 'intro-send'
	| 'intro-chevron'
	| 'env-ok'
	| 'env-warn'
	| 'env-miss'
	| 'git'
	| 'github'
	| 'slack'
	| 'command-play'
	| 'command-idle'
	| 'command-stop'
	| 'command-halt'
	| 'code'
	| 'settings-editor'
	| 'notifications-off'
	| 'scope-hidden'
	| 'push-commits'
	| 'board-branch'
	| 'resume'
	| 'sidebar-branch'
	| 'sidebar-worktree'
	| 'sidebar-eye'
	| 'agent-queued'
	| 'agent-backlog'
	| 'agent-hourglass'
	| 'agents'
	| 'activity'
	| 'agent-run'
	| 'agent-permission'
	| 'agent-question'
	| 'agent-idle'
	| 'agent-completed'
	| 'agent-failed'
	| 'agent-stopped'
	| 'sidebar-needs'
	| 'sidebar-running'
	| 'sidebar-unreviewed'
	| 'sidebar-chevron'
	| 'sidebar-triangle'
	| 'knowledge'
	| 'knowledge-disclosure'
	| 'badge-pass'
	| 'badge-fail'
	| 'check-pass'
	| 'check-fail'
	| 'check-pending'
	| 'pr-branch'
	| 'generate'
	| 'commit-disclosure'
	| 'relay'
	| 'relay-summary'
	| 'relay-diff'
	| 'scope-lock'
	| 'lock-branch'
	| 'board-edit'
	| 'board'
	| 'list'
	| 'settings-notifications'
	| 'settings-templates'
	| 'settings-modules'
	| 'settings-agents'
	| 'settings-notice'
	| 'settings-appearance'
	| 'settings-language'
	| 'review-warning'
	| 'review-info'
	| 'question'
	| 'search-file'
	| 'external'
	| 'tree-eye'
	| 'tree-search'
	| 'tree-right'
	| 'send-context'
	| 'page-console'
	| 'pick'
	| 'mobile'
	| 'desktop'
	| 'comment'
	| 'paperclip'
	| 'comment-list'
	| 'send-chat'
	| 'send-chat-go'
	| 'filter'
	| 'undo'
	| 'copy'
	| 'more'
	| 'helmet'
	| 'person'
	| 'claude'
	| 'effort'
	| 'openai'
	| 'folder'
	| 'folder-plus'
	| 'plus'
	| 'search'
	| 'chat'
	| 'editor'
	| 'diff'
	| 'review'
	| 'browser'
	| 'console'
	| 'refresh'
	| 'send'
	| 'stop'
	| 'history'
	| 'close'
	| 'back'
	| 'forward'
	| 'camera'
	| 'image-off'
	| 'plug'
	| 'clear'
	| 'network'
	| 'inspect'
	| 'hide'
	| 'file'
	| 'file-new'
	| 'trash'
	| 'edit'
	| 'save'
	| 'symbol'
	| 'unified'
	| 'split'
	| 'wrap'
	| 'md-side'
	| 'md-preview'
	| 'why'
	| 'sidebar-toggle'
	| 'sidebar-toggle-off'
	| 'layout-chat'
	| 'layout-work'
	| 'layout-panel'
	| 'layout-chat-off'
	| 'layout-work-off'
	| 'layout-panel-off'
	| 'layout-all'
	| 'layout-reset'
	| 'layout-two'
	| 'layout-two-panel'
	| 'layout-three'
	| 'tools'
	| 'agent-spinner'
	| 'app-menu'
	| 'right-toggle'
	| 'plan'
	| 'plan-document'
	| 'note'
	| 'schedule'
	| 'pause'
	| 'base-task'
	| 'base-head'
	| 'tree-branch'
	| 'drop'
	| 'clock'
	| 'send-now'
	| 'tool-group'
	| 'tool-error'
	| 'toast-success'
	| 'toast-info'
	| 'toast-warning'
	| 'toast-error'
	// spec/appearance#evolution-redesign: the find panel — Lucide `case-sensitive`, `whole-word`, `regex`, `arrow-up`, `arrow-down`,
	// `replace-all`, `chevron-right` / `chevron-down` (ISC), on a 24 grid, stroke 1.8.
	| 'settings'
	| 'find-case'
	| 'find-word'
	| 'find-regex'
	| 'find-previous'
	| 'find-next'
	| 'replace-all'
	| 'find-replace-show'
	| 'find-replace-hide';
/** The stroke frame every native-menu glyph shares (spec/search-menus-and-commands#menu-glyphs): 16 × 16, stroke 1.2, round caps and joins. */
function Line({ name, size, children }: { name: GlyphName; size: number; children: ReactNode }) {
	return (
		<svg
			data-glyph={name}
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.2"
			strokeLinecap="round"
			strokeLinejoin="round">
			{children}
		</svg>
	);
}
/** A Lucide icon (ISC) on its own 24 grid, stroke 1.8. */
function Lucide({ name, size, children }: { name: GlyphName; size: number; children: ReactNode }) {
	return (
		<svg
			data-glyph={name}
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round">
			{children}
		</svg>
	);
}
export function Glyph({ name, size = 12 }: { name: GlyphName; size?: number }) {
	switch (name) {
		// spec/sidebar#section-rail: Settings at the foot of the sections rail — Lucide `settings` (lucide-static 1.60.0).
		case 'settings':
			return (
				<Lucide name={name} size={size}>
					<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
					<circle cx="12" cy="12" r="3" />
				</Lucide>
			);
		case 'find-case':
			return (
				<Lucide name={name} size={size}>
					<path d="m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16" />
					<path d="M22 9v7" />
					<path d="M3.304 13h6.392" />
					<circle cx="18.5" cy="12.5" r="3.5" />
				</Lucide>
			);
		case 'find-word':
			return (
				<Lucide name={name} size={size}>
					<circle cx="7" cy="12" r="3" />
					<path d="M10 9v6" />
					<circle cx="17" cy="12" r="3" />
					<path d="M14 7v8" />
					<path d="M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1" />
				</Lucide>
			);
		case 'find-regex':
			return (
				<Lucide name={name} size={size}>
					<path d="M17 3v10" />
					<path d="m12.67 5.5 8.66 5" />
					<path d="m12.67 10.5 8.66-5" />
					<path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z" />
				</Lucide>
			);
		case 'find-previous':
			return (
				<Lucide name={name} size={size}>
					<path d="m5 12 7-7 7 7" />
					<path d="M12 19V5" />
				</Lucide>
			);
		case 'find-next':
			return (
				<Lucide name={name} size={size}>
					<path d="M12 5v14" />
					<path d="m19 12-7 7-7-7" />
				</Lucide>
			);
		case 'replace-all':
			return (
				<Lucide name={name} size={size}>
					<path d="M14 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1" />
					<path d="M14 4a1 1 0 0 1 1-1" />
					<path d="M15 10a1 1 0 0 1-1-1" />
					<path d="M19 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1" />
					<path d="M21 4a1 1 0 0 0-1-1" />
					<path d="M21 9a1 1 0 0 1-1 1" />
					<path d="m3 7 3 3 3-3" />
					<path d="M6 10V5a2 2 0 0 1 2-2h2" />
					<rect x="3" y="14" width="7" height="7" rx="1" />
				</Lucide>
			);
		case 'find-replace-show':
			return (
				<Lucide name={name} size={size}>
					<path d="m9 18 6-6-6-6" />
				</Lucide>
			);
		case 'find-replace-hide':
			return (
				<Lucide name={name} size={size}>
					<path d="m6 9 6 6 6-6" />
				</Lucide>
			);
		// spec/remote-access-and-mobile#client-ui-seam: remote access — a screen with a signal over its corner.
		case 'remote':
			return (
				<Line name={name} size={size}>
					<rect x="1.6" y="4.6" width="9.6" height="7" rx="1.4" />
					<path d="M4.6 14h3.8" />
					<path d="M12.2 1.9a3.4 3.4 0 0 1 2.2 2.2M11.6 3.6a1.5 1.5 0 0 1 1 1" />
				</Line>
			);
		// Remote access: a paired machine, a device, Disconnect and the log.
		case 'machine':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<rect x="1.8" y="2.4" width="12.4" height="8.6" rx="1.6" />
					<path d="M6 13.6h4M8 11v2.6" />
				</svg>
			);
		case 'laptop':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<rect x="3" y="3.2" width="10" height="7" rx="1.2" />
					<path d="M1.6 12.8h12.8" />
				</svg>
			);
		case 'unlink':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M6.4 9.6 4.8 11.2a2.3 2.3 0 0 1-3.2-3.2l1.6-1.6M9.6 6.4l1.6-1.6a2.3 2.3 0 0 1 3.2 3.2l-1.6 1.6M5 2.5l.6 1.6M2.5 5l1.6.6M11 13.5l-.6-1.6M13.5 11l-1.6-.6" />
				</svg>
			);
		case 'log':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5" />
				</svg>
			);
		// spec/editor#editor-groups: split right and split down — a frame halved across or down.
		case 'split-right':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.8"
						y="2.6"
						width="12.4"
						height="10.8"
						rx="2.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M8 2.6v10.8" stroke="currentColor" strokeWidth="1.2" />
				</svg>
			);
		case 'split-down':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.8"
						y="2.6"
						width="12.4"
						height="10.8"
						rx="2.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M1.8 8h12.4" stroke="currentColor" strokeWidth="1.2" />
				</svg>
			);
		// spec/task-window-workspace#work-area: the chat's frame with the bottom group under its line — the «Below the chat» drop chip.
		case 'under-chat':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.8"
						y="2.6"
						width="12.4"
						height="10.8"
						rx="2.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M1.8 9.4h12.4" stroke="currentColor" strokeWidth="1.2" />
				</svg>
			);
		// spec/editor#editor-groups: the document tab menu's items (drawn for it, no source icon existed): what stays and what goes, the frame of
		// the groups and the way a tab moves. 16 × 16, stroke 1.2 like split-right; the menu shows them as template images.
		case 'tab-close-others':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round">
					<rect x="1.8" y="3.2" width="6.6" height="9.6" rx="1.6" />
					<path d="M10.6 6.2l3.4 3.6M14 6.2l-3.4 3.6" />
				</svg>
			);
		case 'tab-close-all':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round">
					<path d="M5 2.4h7.2a1.6 1.6 0 0 1 1.6 1.6v7.2" />
					<rect x="2.2" y="4.8" width="8.8" height="8.8" rx="1.6" />
					<path d="M4.9 7.5l3.4 3.4M8.3 7.5l-3.4 3.4" />
				</svg>
			);
		case 'tab-close-clean':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M4 1.8h5.2L12.4 5v8.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z" />
					<path d="M5.8 7.8l3.2 3.2M9 7.8l-3.2 3.2" />
				</svg>
			);
		case 'tab-close-right':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M3.2 3v10M6 8h7.4M10.6 5.2 13.4 8l-2.8 2.8" />
				</svg>
			);
		case 'copy-absolute':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round">
					<rect x="5.4" y="2.4" width="8.2" height="10.2" rx="1.6" />
					<path d="M10.6 13.6H3.4a1 1 0 0 1-1-1V5.4M10.8 5.2 8.2 9.8" />
				</svg>
			);
		case 'split-move-right':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
					strokeLinejoin="round">
					<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.2" />
					<path d="M8 2.6v2.2M8 11.2v2.2M4 8h7M9.4 6.4 11 8l-1.6 1.6" />
				</svg>
			);
		case 'split-move-down':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
					strokeLinejoin="round">
					<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.2" />
					<path d="M1.8 8h2.6M11.6 8h2.6M8 4.2v6.6M6.4 9.2 8 10.8l1.6-1.6" />
				</svg>
			);
		case 'group-move':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
					strokeLinejoin="round">
					<rect x="1.6" y="3" width="5.4" height="10" rx="1.4" />
					<rect x="9" y="3" width="5.4" height="10" rx="1.4" />
					<path d="M3.6 8h7.6M9.8 6.6 11.2 8l-1.4 1.4" />
				</svg>
			);
		case 'unsplit':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2">
					<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.2" />
					<path d="M8 4.4v7.2" strokeDasharray="1.6 1.6" />
				</svg>
			);
		case 'unsplit-all':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2">
					<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.2" />
					<path d="M8 4.4v7.2M3.6 8h8.8" strokeDasharray="1.6 1.6" />
				</svg>
			);
		// spec/search-menus-and-commands#menu-glyphs: the native menus' items (drawn for them, no source icon existed): clipboard, code, next/previous (the object
		// on the left, the arrow on the right), window, type and task items. 16 × 16, stroke 1.2, round caps and joins.
		case 'cut':
			return (
				<Line name={name} size={size}>
					<circle cx="4.6" cy="11.8" r="2" />
					<circle cx="11.4" cy="11.8" r="2" />
					<path d="M6 10.3 11.4 2.4M10 10.3 4.6 2.4" />
				</Line>
			);
		case 'copy-text':
			return (
				<Line name={name} size={size}>
					<rect x="5.4" y="2.4" width="8.2" height="10.2" rx="1.6" />
					<path d="M10.6 13.6H3.4a1 1 0 0 1-1-1V5.4M7.6 5.6h3.8M7.6 7.8h3.8M7.6 10h2.2" />
				</Line>
			);
		case 'paste':
			return (
				<Line name={name} size={size}>
					<path d="M5.4 3H4.2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-1.2" />
					<rect x="5.4" y="1.8" width="5.2" height="2.6" rx=".8" />
				</Line>
			);
		case 'paste-plain':
			return (
				<Line name={name} size={size}>
					<path d="M5.4 3H4.2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-1.2" />
					<rect x="5.4" y="1.8" width="5.2" height="2.6" rx=".8" />
					<path d="M5.8 7.6h4.4M5.8 10.4h4.4" />
				</Line>
			);
		case 'delete':
			return (
				<Line name={name} size={size}>
					<path d="M5.4 3.4h7.2a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1H5.4L1.8 8z" />
					<path d="M7.6 6.2l3.4 3.6M11 6.2l-3.4 3.6" />
				</Line>
			);
		case 'select-all':
			return (
				<Line name={name} size={size}>
					<rect x="2" y="2.6" width="12" height="10.8" rx="1.6" strokeDasharray="2 2" />
					<path d="M5 6h6M5 8.4h6M5 10.8h3.6" />
				</Line>
			);
		case 'redo':
			return (
				<Line name={name} size={size}>
					<path d="m11 2 3 3-3 3M14 5H7a4 4 0 0 0 0 8h3" />
				</Line>
			);
		case 'copy-line':
			return (
				<Line name={name} size={size}>
					<rect x="5.4" y="2.4" width="8.2" height="10.2" rx="1.6" />
					<path d="M10.6 13.6H3.4a1 1 0 0 1-1-1V5.4M8.8 5.2l-.6 5M11.2 5.2l-.6 5M7.6 6.6h4.4M7.4 8.8h4.4" />
				</Line>
			);
		case 'link':
			return (
				<Line name={name} size={size}>
					<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
					<path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
				</Line>
			);
		case 'revert':
			return (
				<Line name={name} size={size}>
					<path d="M2.6 2.8v10.4M7.8 3.4 5.4 5.8l2.4 2.4M5.4 5.8h4.4a3.2 3.2 0 0 1 0 6.4H7.6" />
				</Line>
			);
		case 'comment-toggle':
			return (
				<Line name={name} size={size}>
					<path d="M6.8 3.2 4 12.8M11.6 3.2 8.8 12.8" />
				</Line>
			);
		case 'format':
			return (
				<Line name={name} size={size}>
					<path d="M2.4 3.6h8M4.8 6.8h8.8M4.8 10h6M2.4 13.2h8" />
				</Line>
			);
		case 'indent':
			return (
				<Line name={name} size={size}>
					<path d="M7.2 4h6.4M7.2 8h6.4M7.2 12h6.4M2.4 5.6 4.8 8l-2.4 2.4" />
				</Line>
			);
		case 'outdent':
			return (
				<Line name={name} size={size}>
					<path d="M7.2 4h6.4M7.2 8h6.4M7.2 12h6.4M4.8 5.6 2.4 8l2.4 2.4" />
				</Line>
			);
		case 'references':
			return (
				<Line name={name} size={size}>
					<circle cx="10.4" cy="10.2" r="2.6" />
					<path d="m12.3 12.1 1.7 1.7M2.4 3.4h10.4M2.4 6.6h5.2M2.4 9.8h3.2M2.4 13h3.2" />
				</Line>
			);
		case 'completions':
			return (
				<Line name={name} size={size}>
					<path d="M3.4 2v4.4M2.4 2h2M2.4 6.4h2" />
					<rect x="3.4" y="8.2" width="10.4" height="5.6" rx="1.4" />
					<path d="M5.8 11h5.6" />
				</Line>
			);
		case 'parameters':
			return (
				<Line name={name} size={size}>
					<path d="M5 2.8a7.4 7.4 0 0 0 0 10.4M11 2.8a7.4 7.4 0 0 1 0 10.4M7.4 9.6l-.5 1.2M9.6 9.6l-.5 1.2" />
				</Line>
			);
		case 'replace':
			return (
				<Line name={name} size={size}>
					<circle cx="6.2" cy="6.2" r="3.6" />
					<path d="m8.8 8.8 1.4 1.4M8.6 13.2h5M12 11.6l1.6 1.6-1.6 1.6" />
				</Line>
			);
		case 'find-in-files':
			return (
				<Line name={name} size={size}>
					<path d="M8.4 13.6H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1h4.6l3 3v1.8" />
					<circle cx="10.6" cy="10.4" r="2.2" />
					<path d="m12.2 12 1.6 1.6" />
				</Line>
			);
		case 'problem-next':
			return (
				<Line name={name} size={size}>
					<path d="M5.4 2.8 9.2 12.6H1.6zM5.4 6.6v2.4M5.4 10.8v.1M12.6 3.6v8.4M10.8 10.2l1.8 1.8 1.8-1.8" />
				</Line>
			);
		case 'problem-previous':
			return (
				<Line name={name} size={size}>
					<path d="M5.4 2.8 9.2 12.6H1.6zM5.4 6.6v2.4M5.4 10.8v.1M12.6 12.4V4M10.8 5.8l1.8-1.8 1.8 1.8" />
				</Line>
			);
		case 'change-next':
			return (
				<Line name={name} size={size}>
					<path d="M2.6 3.4v9.2M5.2 5.2h3.6M5.2 8h3.6M5.2 10.8h2.2M12.6 3.6v8.4M10.8 10.2l1.8 1.8 1.8-1.8" />
				</Line>
			);
		case 'change-previous':
			return (
				<Line name={name} size={size}>
					<path d="M2.6 3.4v9.2M5.2 5.2h3.6M5.2 8h3.6M5.2 10.8h2.2M12.6 12.4V4M10.8 5.8l1.8-1.8 1.8 1.8" />
				</Line>
			);
		case 'needs-next':
			return (
				<Line name={name} size={size}>
					<circle cx="5.4" cy="8" r="3.8" />
					<path d="M5.4 6v2.4M5.4 10v.1M12.6 3.6v8.4M10.8 10.2l1.8 1.8 1.8-1.8" />
				</Line>
			);
		case 'needs-previous':
			return (
				<Line name={name} size={size}>
					<circle cx="5.4" cy="8" r="3.8" />
					<path d="M5.4 6v2.4M5.4 10v.1M12.6 12.4V4M10.8 5.8l1.8-1.8 1.8 1.8" />
				</Line>
			);
		case 'block-next':
			return (
				<Line name={name} size={size}>
					<rect x="1.8" y="2.6" width="7.4" height="4.4" rx="1.2" />
					<rect x="1.8" y="9" width="7.4" height="4.4" rx="1.2" />
					<path d="M12.6 3.6v8.4M10.8 10.2l1.8 1.8 1.8-1.8" />
				</Line>
			);
		case 'block-previous':
			return (
				<Line name={name} size={size}>
					<rect x="1.8" y="2.6" width="7.4" height="4.4" rx="1.2" />
					<rect x="1.8" y="9" width="7.4" height="4.4" rx="1.2" />
					<path d="M12.6 12.4V4M10.8 5.8l1.8-1.8 1.8 1.8" />
				</Line>
			);
		case 'turn-next':
			return (
				<Line name={name} size={size}>
					<path d="M1.8 4.4a1 1 0 0 1 1-1h5.6a1 1 0 0 1 1 1v4.6a1 1 0 0 1-1 1H5.2L3 11.8V10h-.2a1 1 0 0 1-1-1zM12.6 3.6v8.4M10.8 10.2l1.8 1.8 1.8-1.8" />
				</Line>
			);
		case 'turn-previous':
			return (
				<Line name={name} size={size}>
					<path d="M1.8 4.4a1 1 0 0 1 1-1h5.6a1 1 0 0 1 1 1v4.6a1 1 0 0 1-1 1H5.2L3 11.8V10h-.2a1 1 0 0 1-1-1zM12.6 12.4V4M10.8 5.8l1.8-1.8 1.8 1.8" />
				</Line>
			);
		case 'tab-next':
			return (
				<Line name={name} size={size}>
					<rect x="1.8" y="3.4" width="7.6" height="9.2" rx="1.4" />
					<path d="M1.8 6.2h7.6M11 8h3.4M12.6 6.2 14.4 8l-1.8 1.8" />
				</Line>
			);
		case 'tab-previous':
			return (
				<Line name={name} size={size}>
					<rect x="6.6" y="3.4" width="7.6" height="9.2" rx="1.4" />
					<path d="M6.6 6.2h7.6M5 8H1.6M3.4 6.2 1.6 8l1.8 1.8" />
				</Line>
			);
		case 'group-next':
			return (
				<Line name={name} size={size}>
					<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.2" />
					<path d="M8 2.6v10.8M9.8 8h2.6M11.2 6.6 12.6 8l-1.4 1.4" />
				</Line>
			);
		case 'group-previous':
			return (
				<Line name={name} size={size}>
					<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.2" />
					<path d="M8 2.6v10.8M6.2 8H3.6M5 6.6 3.6 8 5 9.4" />
				</Line>
			);
		case 'expand-all':
			return (
				<Line name={name} size={size}>
					<path d="M4.6 5.6 8 2.4l3.4 3.2M4.6 10.4 8 13.6l3.4-3.2" />
				</Line>
			);
		case 'collapse-all':
			return (
				<Line name={name} size={size}>
					<path d="M4.6 2.4 8 5.6l3.4-3.2M4.6 13.6 8 10.4l3.4 3.2" />
				</Line>
			);
		case 'quit':
			return (
				<Line name={name} size={size}>
					<path d="M8 1.8v5.6M4.6 4.2a5.2 5.2 0 1 0 6.8 0" />
				</Line>
			);
		case 'minimize':
			return (
				<Line name={name} size={size}>
					<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.2" />
					<path d="M5.2 10.2h5.6" />
				</Line>
			);
		case 'zoom':
			return (
				<Line name={name} size={size}>
					<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.2" />
					<path d="M5.4 10.6l5.2-5.2M7.6 5.4h3v3" />
				</Line>
			);
		case 'fullscreen':
			return (
				<Line name={name} size={size}>
					<path d="M2.4 5.6V2.4h3.2M10.4 2.4h3.2v3.2M13.6 10.4v3.2h-3.2M5.6 13.6H2.4v-3.2" />
				</Line>
			);
		case 'front':
			return (
				<Line name={name} size={size}>
					<rect x="4.6" y="5.2" width="9.6" height="8.2" rx="1.6" />
					<path d="M1.8 10.4V3.8a1.2 1.2 0 0 1 1.2-1.2h7.6" />
				</Line>
			);
		case 'hide-others':
			return (
				<Line name={name} size={size}>
					<rect x="4.6" y="5.2" width="9.6" height="8.2" rx="1.6" />
					<path d="M1.8 10.4V3.8a1.2 1.2 0 0 1 1.2-1.2h7.6M2.2 14.2 14.2 2.2" />
				</Line>
			);
		case 'font-larger':
			return (
				<Line name={name} size={size}>
					<path d="M1.8 13.2 5.4 3.4h.8l3.6 9.8M3.2 9.8h6.2M12.6 2.4v4M10.6 4.4h4" />
				</Line>
			);
		case 'font-smaller':
			return (
				<Line name={name} size={size}>
					<path d="M1.8 13.2 5.4 3.4h.8l3.6 9.8M3.2 9.8h6.2M10.6 4.4h4" />
				</Line>
			);
		case 'font-reset':
			return (
				<Line name={name} size={size}>
					<path d="M1.8 13.2 5.4 3.4h.8l3.6 9.8M3.2 9.8h6.2M10.8 3.4h3.6M10.8 5.6h3.6" />
				</Line>
			);
		case 'bold':
			return (
				<Line name={name} size={size}>
					<path
						d="M4.6 2.8h4a2.4 2.4 0 0 1 0 4.8h-4zM4.6 7.6h4.6a2.8 2.8 0 0 1 0 5.6H4.6z"
						strokeWidth="1.6"
					/>
				</Line>
			);
		case 'italic':
			return (
				<Line name={name} size={size}>
					<path d="M7 2.8h5M4 13.2h5M9.6 2.8 6.4 13.2" />
				</Line>
			);
		case 'format-text':
			return (
				<Line name={name} size={size}>
					<path d="M1.6 12.6 4.8 3.6h.8l3.2 9M2.8 9.6h5.2" />
					<circle cx="11.6" cy="10.4" r="2.2" />
					<path d="M13.8 8v4.6" />
				</Line>
			);
		case 'text-replace':
			return (
				<Line name={name} size={size}>
					<path d="M2.4 4h7.2M2.4 7.2h4.4M11.8 3v5.6a2 2 0 0 1-2 2H6.4M8 9 6.4 10.6 8 12.2" />
				</Line>
			);
		case 'quotes':
			return (
				<Line name={name} size={size}>
					<path d="M3.2 10c0-3 .9-4.8 3-6M8.8 10c0-3 .9-4.8 3-6" />
					<circle cx="4.6" cy="10.4" r="1.6" />
					<circle cx="10.2" cy="10.4" r="1.6" />
				</Line>
			);
		case 'dash':
			return (
				<Line name={name} size={size}>
					<path d="M2.6 8h10.8" strokeWidth="1.6" />
				</Line>
			);
		case 'speech':
			return (
				<Line name={name} size={size}>
					<path d="M2.4 6h2.4L8 3.4v9.2L4.8 10H2.4z" />
					<path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.4 3.8a6 6 0 0 1 0 8.4" />
				</Line>
			);
		case 'mode-next':
			return (
				<Line name={name} size={size}>
					<rect x="1.8" y="4.4" width="12.4" height="7.2" rx="3.6" />
					<circle cx="10.6" cy="8" r="2" />
				</Line>
			);
		case 'duplicate':
			return (
				<Line name={name} size={size}>
					<rect x="5.4" y="2.4" width="8.2" height="10.2" rx="1.6" />
					<path d="M10.6 13.6H3.4a1 1 0 0 1-1-1V5.4M9.5 5.4v4.2M7.4 7.5h4.2" />
				</Line>
			);
		case 'pin':
			return (
				<Line name={name} size={size}>
					<path d="M5.8 2.4h4.4M6.8 2.4v4L4.6 9.2h6.8L9.2 6.4v-4M8 9.2v4.4" />
				</Line>
			);
		// spec/git#pull: git-pull and push-commits are plain arrows, no bar; the chips are the text ↓N/↑N.
		case 'git-pull':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M8 2.8v10.4M4.4 9.6 8 13.2l3.6-3.6" />
				</svg>
			);
		case 'git-stash':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.5 9.5h3l1 1.6h3l1-1.6h3M2.5 9.5l1.6-5.5h7.8l1.6 5.5v3.3h-11z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'git-unstash':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.5 9.5h3l1 1.6h3l1-1.6h3v3.3h-11zM8 7.6V1.8M5.8 4 8 1.8 10.2 4"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		// spec/tasks#agent-created-tasks: the proposed task — a card with a plus (the «New task» card in the chat, the sheet's «Proposed in»).
		case 'task-new':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="2.2"
						y="2.6"
						width="11.6"
						height="10.8"
						rx="2"
						stroke="currentColor"
						strokeWidth="1.3"
					/>
					<path
						d="M8 5.4v5.2M5.4 8h5.2"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/search-menus-and-commands#search-tabs: a menu action, a setting,
		// the repo and mask fields of Text, and the arrow of «More N».
		case 'search-action':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M8.8 1.8 3.6 9h4l-.6 5.2L12.4 7h-4z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'search-setting':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
					<path
						d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
					<circle cx="8" cy="8" r="4.4" stroke="currentColor" strokeWidth="1.2" />
				</svg>
			);
		case 'search-repo':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4 2.6h7.4a1 1 0 0 1 1 1V13H5a1.4 1.4 0 0 1 0-2.8h7.4"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
				</svg>
			);
		// spec/search-menus-and-commands#menu-structure: Find previous — the arrow of `search-more` (Find next) turned back.
		case 'search-more':
		case 'search-previous':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d={name === 'search-more' ? 'M3 8h9M9 5l3 3-3 3' : 'M13 8H4M7 5 4 8l3 3'}
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'search-mask':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.5 3.5h11L9.2 8.6v4l-2.4 1.1V8.6z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
				</svg>
			);
		// spec/tasks#archive: box, unbox and the warning triangle.
		case 'archive-box':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="2"
						y="2.8"
						width="12"
						height="3.4"
						rx="1"
						stroke="currentColor"
						strokeWidth="1.25"
					/>
					<path
						d="M3.2 6.2v6a1.1 1.1 0 0 0 1.1 1.1h7.4a1.1 1.1 0 0 0 1.1-1.1v-6"
						stroke="currentColor"
						strokeWidth="1.25"
					/>
					<path d="M6.4 8.9h3.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
				</svg>
			);
		case 'archive-restore':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M5.8 3.2 3.1 5.9l2.7 2.7"
						stroke="currentColor"
						strokeWidth="1.35"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M3.4 5.9h6.3a3.3 3.3 0 0 1 0 6.6H6.9"
						stroke="currentColor"
						strokeWidth="1.35"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'archive-warn':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M8 2.4 14.2 13.4H1.8z"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinejoin="round"
					/>
					<path
						d="M8 6.6v3M8 11.4v.2"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/agents-and-providers#sign-in-recovery: the sign-in key.
		case 'agent-key':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="5.4" cy="10.6" r="2.9" stroke="currentColor" strokeWidth="1.4" />
					<path
						d="M7.5 8.5 13.4 2.6M11.3 4.7l1.8 1.8M9.8 6.2l1.3 1.3"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/settings-modules-and-onboarding#intro: the composer's send arrow (inline in the composer) and a chevron down.
		case 'intro-send':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<path
						d="M8 13V3M3.5 7.5 8 3l4.5 4.5"
						stroke="currentColor"
						strokeWidth="1.8"
						strokeLinecap="round"
						strokeLinejoin="round"
						fill="none"
					/>
				</svg>
			);
		case 'intro-chevron':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 10 10">
					<path
						d="M2 3.6 5 6.6 8 3.6"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
						fill="none"
					/>
				</svg>
			);
		// spec/settings-modules-and-onboarding#intro: the environment check rows — ok, warn, miss, git, gh.
		case 'env-ok':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".18" />
					<path
						d="M4.9 8.3 6.9 10.3 11.1 5.9"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
						fill="none"
					/>
				</svg>
			);
		case 'env-warn':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".18" />
					<path d="M8 4.6v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
					<circle cx="8" cy="11.2" r=".95" fill="currentColor" />
				</svg>
			);
		case 'env-miss':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".18" />
					<path
						d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'git':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<circle cx="4.5" cy="4" r="1.7" stroke="currentColor" strokeWidth="1.3" fill="none" />
					<circle cx="4.5" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.3" fill="none" />
					<circle cx="11.5" cy="6.5" r="1.7" stroke="currentColor" strokeWidth="1.3" fill="none" />
					<path
						d="M4.5 5.7v4.6M11.5 8.2c0 2-2.2 2.4-5.4 3"
						stroke="currentColor"
						strokeWidth="1.3"
						fill="none"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/notifications-slack-notes-and-schedules#slack: one-colour Slack mark, drawn in the manner of `github`.
		case 'slack':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<path
						fill="currentColor"
						d="M3.4 10.1a1.4 1.4 0 1 1-1.4-1.4h1.4v1.4zm.7 0a1.4 1.4 0 0 1 2.8 0v3.5a1.4 1.4 0 1 1-2.8 0v-3.5zM5.9 3.4a1.4 1.4 0 1 1 1.4-1.4v1.4H5.9zm0 .7a1.4 1.4 0 0 1 0 2.8H2.4a1.4 1.4 0 1 1 0-2.8h3.5zM12.6 5.9a1.4 1.4 0 1 1 1.4 1.4h-1.4V5.9zm-.7 0a1.4 1.4 0 0 1-2.8 0V2.4a1.4 1.4 0 1 1 2.8 0v3.5zM10.1 12.6a1.4 1.4 0 1 1-1.4 1.4v-1.4h1.4zm0-.7a1.4 1.4 0 0 1 0-2.8h3.5a1.4 1.4 0 1 1 0 2.8h-3.5z"
					/>
				</svg>
			);
		case 'github':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<path
						fill="currentColor"
						d="M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2z"
					/>
				</svg>
			);
		// spec/search-menus-and-commands#project-commands: play, play outlined, stop and halt.
		case 'command-play':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<path
						d="M5 3.4v9.2a.6.6 0 0 0 .9.5l7.2-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5z"
						fill="currentColor"
					/>
				</svg>
			);
		case 'command-idle':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M5.2 3.8v8.4l6.6-4.2z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'command-stop':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<rect x="3.8" y="3.8" width="8.4" height="8.4" rx="1.6" fill="currentColor" />
				</svg>
			);
		case 'command-halt':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
					<rect x="5.8" y="5.8" width="4.4" height="4.4" rx=".8" fill="currentColor" />
				</svg>
			);
		case 'sidebar-branch':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M3 2.5v11M3 13.5h6.5a3 3 0 0 0 3-3V8"
						stroke="currentColor"
						strokeWidth="1.2"
						fill="none"
						strokeLinecap="round"
					/>
					<circle cx="12.5" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.2" fill="none" />
				</svg>
			);
		case 'sidebar-worktree':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="4.5" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.2" fill="none" />
					<circle cx="4.5" cy="12.5" r="1.7" stroke="currentColor" strokeWidth="1.2" fill="none" />
					<circle cx="11.5" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.2" fill="none" />
					<path
						d="M4.5 5.2v5.6M11.5 7.2c0 2.6-2.4 2.6-4.7 3.2"
						stroke="currentColor"
						strokeWidth="1.2"
						fill="none"
					/>
				</svg>
			);
		// Repos block: eye with a slash, and the push arrow.
		case 'scope-hidden':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8s-2.4 4.4-6.4 4.4S1.6 8 1.6 8z"
						stroke="currentColor"
						strokeWidth="1.2"
						fill="none"
					/>
					<path
						d="M2.4 2.4 13.6 13.6"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'push-commits':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M8 13.2V2.8M4.4 6.4 8 2.8l3.6 3.6" />
				</svg>
			);
		case 'sidebar-eye':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8s-2.4 4.4-6.4 4.4S1.6 8 1.6 8z"
						stroke="currentColor"
						strokeWidth="1.2"
						fill="none"
					/>
					<circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
				</svg>
			);

		case 'agent-queued':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".22" />
					<rect
						x="5.2"
						y="7.6"
						width="5.6"
						height="4"
						rx="1.1"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M6.5 7.6V6.5a1.5 1.5 0 0 1 3 0v1.1" stroke="currentColor" strokeWidth="1.2" />
				</svg>
			);
		case 'agent-backlog':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle
						cx="8"
						cy="8"
						r="6.2"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeDasharray="2.2 2.2"
					/>
				</svg>
			);
		case 'agent-hourglass':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4.6 2.6h6.8M4.6 13.4h6.8M5.4 2.6v2.1c0 1.3 2.6 2.1 2.6 3.3s-2.6 2-2.6 3.3v2.1M10.6 2.6v2.1c0 1.3-2.6 2.1-2.6 3.3s2.6 2 2.6 3.3v2.1"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);

		// spec/appearance#evolution-redesign: «Agents in work» — Lucide `activity` (ISC), a pulse, 16 px with a 1.8 stroke.
		case 'activity':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
				</svg>
			);
		case 'agents':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle
						cx="10.6"
						cy="5.8"
						r="3.9"
						stroke="currentColor"
						strokeWidth="1.3"
						opacity=".32"
					/>
					<circle cx="6.5" cy="9.6" r="4.9" stroke="currentColor" strokeWidth="1.5" opacity=".28" />
					<path
						d="M6.5 4.7a4.9 4.9 0 0 1 4.9 4.9"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'agent-run':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.7" opacity=".25" />
					<path
						d="M8 2a6 6 0 0 1 6 6"
						stroke="currentColor"
						strokeWidth="1.7"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'agent-permission':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".3" />
					<path d="M8 4.4v4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
					<circle cx="8" cy="11.4" r="1" fill="currentColor" />
				</svg>
			);
		case 'agent-question':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".3" />
					<path
						d="M6.1 6.2a1.9 1.9 0 1 1 2.5 1.8c-.4.2-.6.5-.6.9v.4"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
					<circle cx="8" cy="11.4" r="1" fill="currentColor" />
				</svg>
			);
		case 'agent-completed':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M3.6 8.4 6.6 11.2 12.4 5"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'agent-idle':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".22" />
					<path
						d="M4.9 8.3 6.9 10.3 11.1 5.9"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'agent-failed':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".22" />
					<path
						d="M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'agent-stopped':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
					<path
						d="M6.6 6.2v3.6M9.4 6.2v3.6"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
					/>
				</svg>
			);

		case 'sidebar-needs':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="var(--amber)" opacity=".3" />
					<path d="M8 4.4v4.2" stroke="var(--amber)" strokeWidth="1.7" strokeLinecap="round" />
					<circle cx="8" cy="11.4" r="1" fill="var(--amber)" />
				</svg>
			);
		case 'sidebar-running':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="6" stroke="var(--accent)" strokeWidth="1.7" opacity=".3" />
					<path
						d="M8 2a6 6 0 0 1 6 6"
						stroke="var(--accent)"
						strokeWidth="1.7"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'sidebar-unreviewed':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size + 2}
					height={size + 1}
					viewBox="0 0 18 16"
					fill="none">
					<circle cx="7" cy="8" r="6.4" fill="var(--fg2)" opacity=".22" />
					<path
						d="M4.1 8.3 5.9 10.1 9.7 5.9"
						stroke="var(--fg2)"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<circle cx="15" cy="3.4" r="2.2" fill="var(--accent)" />
				</svg>
			);
		// The sidebar toggle: a window with its sidebar pane filled.
		// spec/task-window#layout-overview: the sidebar toggle mirrored — the strip on the right.
		case 'right-toggle':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.6"
						y="2.6"
						width="12.8"
						height="10.8"
						rx="2.4"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M10 2.6v10.8" stroke="currentColor" strokeWidth="1.2" />
					<rect x="11" y="3.6" width="2.4" height="8.8" rx="1" fill="currentColor" opacity=".45" />
				</svg>
			);
		// spec/task-window#layout-overview: the middle column of three; the strip is filled while the editor is shown, an outline while it is hidden.
		case 'editor-toggle':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.6"
						y="2.6"
						width="12.8"
						height="10.8"
						rx="2.4"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M5.8 2.6v10.8M10.2 2.6v10.8" stroke="currentColor" strokeWidth="1.2" />
					<rect x="6.8" y="3.6" width="2.4" height="8.8" rx="1" fill="currentColor" opacity=".45" />
				</svg>
			);
		case 'editor-toggle-off':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.6"
						y="2.6"
						width="12.8"
						height="10.8"
						rx="2.4"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M5.8 2.6v10.8M10.2 2.6v10.8" stroke="currentColor" strokeWidth="1.2" />
				</svg>
			);
		// spec/architecture-and-platform#window-frame: ☰ of the app menu on Windows and Linux, the toolbar's 1.3 px line.
		case 'app-menu':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.5 4.2h11M2.5 8h11M2.5 11.8h11"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/task-window-workspace#layout-switch: the sidebar toggle is the Layout glyph — the frame, its left column filled while the sidebar shows.
		case 'sidebar-toggle':
		case 'sidebar-toggle-off':
			return (
				<ColumnFrame name={name} size={size} fill={name === 'sidebar-toggle' ? [1.6, 4.9] : null}>
					{name === 'sidebar-toggle-off' && (
						<path d="M6 3.2v9.6" stroke="currentColor" strokeWidth="1" />
					)}
				</ColumnFrame>
			);
		// spec/task-window-workspace#layout-switch: a window frame with two dividers; a column that is on
		// is filled under the frame and takes the dividers beside it. One opaque colour, the opacity on the whole glyph.
		case 'layout-chat':
		case 'layout-work':
		case 'layout-panel':
		case 'layout-chat-off':
		case 'layout-work-off':
		case 'layout-panel-off': {
			const column = ['chat', 'work', 'panel'].indexOf(name.split('-')[1]!),
				on = !name.endsWith('-off');
			const spans: [number, number][] = [
				[1.6, 4.5],
				[5.1, 5.8],
				[9.9, 4.5],
			];
			const left = !(on && (column === 0 || column === 1)),
				right = !(on && (column === 1 || column === 2));
			const lines = `${left ? 'M5.6 3.2v9.6' : ''}${right ? 'M10.4 3.2v9.6' : ''}`;
			return (
				<ColumnFrame name={name} size={size} fill={on ? spans[column]! : null} clip>
					{lines && <path d={lines} stroke="currentColor" strokeWidth="1" />}
				</ColumnFrame>
			);
		}
		// spec/task-window-workspace#layout-switch: Show all — the frame and all its columns.
		case 'layout-all':
			return (
				<ColumnFrame name={name} size={size} fill={null}>
					<path d="M5.6 3.2v9.6M10.4 3.2v9.6" stroke="currentColor" strokeWidth="1" />
				</ColumnFrame>
			);
		// spec/task-window-workspace#two-columns: two columns — the frame, the pinned tab's plate top left and the panel's
		// divider; `layout-two-panel` fills the panel's column (it is open) in the divider's place. Three — the frame and two dividers.
		case 'layout-two':
		case 'layout-two-panel':
			return (
				<ColumnFrame
					name={name}
					size={size}
					fill={name === 'layout-two-panel' ? [9.9, 4.5] : null}
					clip={name === 'layout-two-panel'}>
					{name === 'layout-two' && (
						<path d="M10.4 3.2v9.6" stroke="currentColor" strokeWidth="1" />
					)}
					<rect x="3.3" y="4.4" width="3.4" height="1.6" rx="0.6" fill="currentColor" />
				</ColumnFrame>
			);
		case 'layout-three':
			return (
				<ColumnFrame name={name} size={size} fill={null}>
					<path d="M5.6 3.2v9.6M10.4 3.2v9.6" stroke="currentColor" strokeWidth="1" />
				</ColumnFrame>
			);
		// Reset column widths: the frame with the dividers and arrows apart from the middle.
		case 'layout-reset':
			return (
				<ColumnFrame name={name} size={size} fill={null}>
					<path
						d="M5.6 3.2v9.6M10.4 3.2v9.6M7 8h2M3 8h1.2M11.8 8H13"
						stroke="currentColor"
						strokeWidth="1"
						strokeLinecap="round"
					/>
				</ColumnFrame>
			);
		// spec/task-window-workspace#work-area: three tiles and a plus — the task's tools.
		case 'tools':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.8"
						y="1.8"
						width="5.4"
						height="5.4"
						rx="1.4"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<rect
						x="8.8"
						y="1.8"
						width="5.4"
						height="5.4"
						rx="1.4"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<rect
						x="1.8"
						y="8.8"
						width="5.4"
						height="5.4"
						rx="1.4"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path
						d="M11.5 9.2v4.6M9.2 11.5h4.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/task-window-workspace#work-area: the agent acting on a tab — an accent arc on its ring, turning.
		case 'agent-spinner':
			return (
				<svg
					data-glyph={name}
					data-spin="true"
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" opacity=".25" />
					<path
						d="M8 2a6 6 0 0 1 6 6"
						stroke="currentColor"
						strokeWidth="1.8"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/sidebar#completed-fold: the filled disclosure triangle after «Completed · N»; it points down, a fold turns it right.
		case 'sidebar-triangle':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 10 10"
					fill="none">
					<path
						d="M2.2 3.3h5.6a.5.5 0 0 1 .4.8L5.4 7.2a.5.5 0 0 1-.8 0L1.8 4.1a.5.5 0 0 1 .4-.8z"
						fill="currentColor"
					/>
				</svg>
			);
		case 'sidebar-chevron':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 10 10"
					fill="none">
					<path
						d="M2 3.6 5 6.6 8 3.6"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);

		case 'knowledge':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M8 1.8a4.4 4.4 0 0 1 2.6 7.9c-.4.3-.6.7-.6 1.2v.3H6v-.3c0-.5-.2-.9-.6-1.2A4.4 4.4 0 0 1 8 1.8z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
					<path d="M6.6 13.4h2.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
				</svg>
			);
		case 'knowledge-disclosure':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 10 10"
					fill="none">
					<path
						d="M2 3.6 5 6.6 8 3.6"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
						fill="none"
					/>
				</svg>
			);

		case 'badge-pass':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M3.2 8.4 L6.4 11.4 L12.8 4.6" />
				</svg>
			);
		case 'badge-fail':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round">
					<path d="M4.4 4.4 L11.6 11.6 M11.6 4.4 L4.4 11.6" />
				</svg>
			);
		case 'check-pass':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<circle cx="8" cy="8" r="6.2" />
					<path d="M5.4 8.2 L7.2 10 L10.6 6.2" />
				</svg>
			);
		/* spec/notifications-slack-notes-and-schedules#message-classes: toast marks — a 24 % plate and the mark in the same colour. */
		case 'toast-success':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".24" />
					<path
						d="M4.9 8.3 6.9 10.3 11.1 5.9"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'toast-info':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".26" />
					<path d="M8 7.2v4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
					<circle cx="8" cy="4.8" r="1" fill="currentColor" />
				</svg>
			);
		case 'toast-warning':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M8 1.9 14.6 13.6H1.4z"
						fill="currentColor"
						fillOpacity=".26"
						stroke="currentColor"
						strokeWidth="1.1"
						strokeLinejoin="round"
					/>
					<path d="M8 6.2v3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
					<circle cx="8" cy="11.6" r=".95" fill="currentColor" />
				</svg>
			);
		case 'toast-error':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".26" />
					<path d="M8 4.4v4.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
					<circle cx="8" cy="11.4" r="1" fill="currentColor" />
				</svg>
			);
		case 'check-fail':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round">
					<circle cx="8" cy="8" r="6.2" />
					<path d="M5.8 5.8 L10.2 10.2 M10.2 5.8 L5.8 10.2" />
				</svg>
			);
		case 'check-pending':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round">
					<path d="M8 1.8 A6.2 6.2 0 1 1 3.6 3.6" />
				</svg>
			);
		// spec/pull-requests-and-ci#pr-panel: PR states.
		case 'turn-done':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".22" />
					<path
						d="M4.9 8.3 6.9 10.3 11.1 5.9"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'tick':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M3.2 8.4 6.4 11.4 12.8 4.6"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'commit-dot':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="2.6" stroke="currentColor" strokeWidth="1.3" />
					<path
						d="M1.6 8h3.8M10.6 8h3.8"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'list-bullets':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M5.6 4.4h8M5.6 8h8M5.6 11.6h8"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
					<circle cx="2.8" cy="4.4" r=".9" fill="currentColor" />
					<circle cx="2.8" cy="8" r=".9" fill="currentColor" />
					<circle cx="2.8" cy="11.6" r=".9" fill="currentColor" />
				</svg>
			);
		case 'send-plane':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.4 8 13.6 2.6 10.6 13.4 7.8 9.2z"
						stroke="currentColor"
						strokeWidth="1.25"
						strokeLinejoin="round"
					/>
					<path d="M7.8 9.2 13.6 2.6" stroke="currentColor" strokeWidth="1.25" />
				</svg>
			);
		case 'chevron-down':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 10 10"
					fill="none">
					<path
						d="M2 3.6 5 6.6 8 3.6"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'chevron-left':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 10 10"
					fill="none">
					<path
						d="M6.4 2 3.4 5 6.4 8"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'pr-draft':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round">
					<path d="M4 4.7V10.3" />
					<path d="M12 3.2v.1M12 6.2v.1M12 9.2v.1" strokeWidth="1.6" />
					<circle cx="4" cy="3" r="1.7" />
					<circle cx="4" cy="12" r="1.7" />
					<circle cx="12" cy="12" r="1.7" />
				</svg>
			);
		case 'pr-merged':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round">
					<path d="M4 4.7V13.6M4.4 4.8c.6 2.8 3.2 4.6 5.9 4.9" />
					<circle cx="4" cy="3" r="1.7" />
					<circle cx="12" cy="9.8" r="1.7" />
				</svg>
			);
		case 'pr-closed':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round">
					<path d="M4 4.7V10.3" />
					<path d="M10.4 2.4l3.2 3.2M13.6 2.4l-3.2 3.2M12 8.2v2.1" />
					<circle cx="4" cy="3" r="1.7" />
					<circle cx="4" cy="12" r="1.7" />
					<circle cx="12" cy="12" r="1.7" />
				</svg>
			);
		case 'review-changes':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round">
					<rect x="2.8" y="1.8" width="10.4" height="12.4" rx="2.2" />
					<path d="M8 4.6v3.6M6.2 6.4h3.6M6.2 11h3.6" />
				</svg>
			);
		// spec/pull-requests-and-ci#ci: a step or job that has not started — a dashed ring; one skipped or cancelled — a ring with a stroke.
		case 'check-queued':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3">
					<circle cx="8" cy="8" r="6.2" strokeDasharray="2.2 2.2" />
				</svg>
			);
		case 'check-skipped':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3">
					<circle cx="8" cy="8" r="6.2" />
					<path d="M4.4 11.6 11.6 4.4" />
				</svg>
			);
		// spec/pull-requests-and-ci#ci: a job with `environment` (a deploy) and «Open staging» — the environment's page.
		case 'deploy':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M9.5 2.6c2-.6 3.6-.4 3.9-.1.3.3.5 1.9-.1 3.9-.6 2-2.2 3.8-4.4 5l-2.4-2.4c1.2-2.2 3-3.8 5-4.4z" />
					<circle cx="10.3" cy="5.7" r="1" fill="currentColor" stroke="none" />
					<path d="M6.5 9.6 4.7 9.3 6 7.4l1.6-.2M6.4 9.5l.3 1.8 1.9-1.3.2-1.6M4.6 11.4l-1.5 1.5" />
				</svg>
			);
		case 'globe':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<circle cx="8" cy="8" r="6" />
					<path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8s.8 4.3 2.6 6" />
				</svg>
			);
		case 'check-run':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round">
					<circle cx="8" cy="8" r="6.2" opacity=".3" />
					<path d="M8 1.8A6.2 6.2 0 0 1 14.2 8" />
				</svg>
			);
		case 'bubble':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.6 6.4a2.8 2.8 0 0 1 2.8-2.8h5.2a2.8 2.8 0 0 1 2.8 2.8v2.2a2.8 2.8 0 0 1-2.8 2.8H7.4l-3.2 2.3v-2.4a2.8 2.8 0 0 1-1.6-2.5z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'xmark':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'pr-branch':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M4 4.7 V10.3 M12 10.3 V6.5 A3 3 0 0 0 9 3.5 V1.8 M7.2 3.6 L9 1.8 L10.8 3.6" />
					<circle cx="4" cy="3" r="1.7" />
					<circle cx="4" cy="12" r="1.7" />
					<circle cx="12" cy="12" r="1.7" />
				</svg>
			);
		// spec/diff-and-review#changes-header, the diff base icons: flag = task start, commit node = last commit.
		case 'base-task':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M4 14.2V2.4" />
					<path d="M4 2.9h7.8l-1.9 2.9 1.9 2.9H4" />
				</svg>
			);
		case 'base-head':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<circle cx="8" cy="8" r="2.6" />
					<path d="M1.6 8h3.8M10.6 8h3.8" />
				</svg>
			);
		case 'generate':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M8 2.2 9.3 6.7 13.8 8 9.3 9.3 8 13.8 6.7 9.3 2.2 8 6.7 6.7Z" />
				</svg>
			);
		// Every disclosure uses the shared chevron.
		case 'commit-disclosure':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 10 10"
					fill="none">
					<path
						d="M2 3.6 5 6.6 8 3.6"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		// Scope lock and isolated branch geometry.
		case 'resume':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M5 3.6 12 8l-7 4.4z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'relay':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4 12.4V6.2a2.4 2.4 0 0 1 2.4-2.4h6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
					<path
						d="M10.2 1.8 12.8 3.8l-2.6 2"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<circle cx="4" cy="13.4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
				</svg>
			);
		case 'relay-summary':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4 2.4h5l3 3v8.2H4z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
					<path d="M9 2.4v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
					<path
						d="M5.8 8.4h4.4M5.8 10.6h3"
						stroke="currentColor"
						strokeWidth="1.1"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'relay-diff':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.4 4.6h3.4M4.1 2.9v3.4M13.6 2.4 5.2 13.6M10.2 11.4h3.4"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'scope-lock':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="3.4"
						y="7"
						width="9.2"
						height="6.6"
						rx="1.6"
						stroke="currentColor"
						strokeWidth="1.3"
					/>
					<path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" stroke="currentColor" strokeWidth="1.3" />
				</svg>
			);
		case 'board-branch':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4.6 3.4v6.2M11.4 3.4v3.2c0 1.7-1.4 3-3.1 3H4.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
					<circle cx="4.6" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.3" />
					<circle cx="11.4" cy="2.4" r="1.7" stroke="currentColor" strokeWidth="1.3" />
				</svg>
			);
		case 'lock-branch':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4.6 3.4v6.2M11.4 3.4v3.2c0 1.7-1.4 3-3.1 3H4.6"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
					/>
					<circle cx="4.6" cy="12" r="1.8" stroke="currentColor" strokeWidth="1.4" />
					<circle cx="11.4" cy="2.4" r="1.8" stroke="currentColor" strokeWidth="1.4" />
				</svg>
			);

		// spec/projects-and-board#board: the page-and-pencil artwork.
		case 'board-edit':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M12.6 9.4v3a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 12.4V5a1.6 1.6 0 0 1 1.6-1.6h3"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
					<path
						d="M11.4 1.9a1.35 1.35 0 0 1 1.9 1.9l-5.2 5.2-2.5.6.6-2.5z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"
					/>
				</svg>
			);

		// spec/notifications-slack-notes-and-schedules#schedules: a clock inside a turning arrow — a schedule; two bars — a paused one.
		case 'schedule':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M13.4 9.3A5.6 5.6 0 1 1 11.6 3.7"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
					<path
						d="M12.4 1.6v2.6H9.8"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M8 5.4v2.9l1.9 1.2"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'pause':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M5.9 4.2v7.6M10.1 4.2v7.6"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'note':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M3 2.6h10v6.6L9.2 13H3z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"
					/>
					<path
						d="M12.8 9.4H9.4v3.4M5.4 5.8h5.2M5.4 8.4h2.8"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'plan-document':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4 1.8h5.4L12.6 5v9.2H4z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"
					/>
					<path
						d="M9.2 1.8V5.2h3.4M6.2 8h4M6.2 10.6h4"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'plan':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M6.4 4.4h6.8M6.4 8h6.8M6.4 11.6h6.8"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
					<path
						d="M2.6 4.3 3.5 5.2 5 3.6"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<circle cx="3.7" cy="8" r="1" fill="currentColor" />
					<circle cx="3.7" cy="11.6" r="1" fill="currentColor" />
				</svg>
			);
		case 'list':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.4 4.2h11.2M2.4 8h11.2M2.4 11.8h11.2"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		// Board card: the board/list symbols.
		case 'board':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.8"
						y="2.6"
						width="3.6"
						height="10.8"
						rx="1.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<rect
						x="6.2"
						y="2.6"
						width="3.6"
						height="7.4"
						rx="1.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<rect
						x="10.6"
						y="2.6"
						width="3.6"
						height="5"
						rx="1.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
				</svg>
			);

		// Review clear-all icons.
		case 'review-warning':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M8 2.2 14.4 13.4H1.6z"
						stroke="var(--amber)"
						strokeWidth="1.3"
						strokeLinejoin="round"
					/>
					<path d="M8 6.4v3" stroke="var(--amber)" strokeWidth="1.4" strokeLinecap="round" />
					<circle cx="8" cy="11.4" r=".9" fill="var(--amber)" />
				</svg>
			);
		// spec/notifications-slack-notes-and-schedules#macos-permission: the tab bell with a slash, for the permission banner.
		case 'notifications-off':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4.4 10.6V7.4a3.6 3.6 0 0 1 5.9-2.8M11.6 7.4v3.2l1.2 1.6H4.4"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M6.4 12.8a1.7 1.7 0 0 0 3.2 0M2.6 13.4 13.4 2.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/browser-and-simulator#tab-sound: the sound of a browser tab — waves while it plays, a cross when muted.
		case 'speaker':
		case 'speaker-muted':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.6 6.2h2.2L8 3.4v9.2L4.8 9.8H2.6z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"
					/>
					<path
						d={
							name === 'speaker'
								? 'M10.4 6a2.8 2.8 0 0 1 0 4M12.2 4.2a5.4 5.4 0 0 1 0 7.6'
								: 'M10.6 6.2l3.6 3.6M14.2 6.2l-3.6 3.6'
						}
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/pull-requests-and-ci#ci-bell: the bell on a run — outline to watch it, filled while watched.
		case 'bell':
		case 'bell-on':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4 11.4V7a4 4 0 0 1 8 0v4.4l1.2 1.4H2.8z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"
						fill={name === 'bell-on' ? 'currentColor' : 'none'}
					/>
					<path
						d="M6.4 12.8a1.7 1.7 0 0 0 3.2 0"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		// Settings: the Notifications tab bell.
		case 'settings-notifications':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4 11.4V7a4 4 0 0 1 8 0v4.4l1.2 1.4H2.8z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
					<path
						d="M6.4 12.8a1.7 1.7 0 0 0 3.2 0"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		// Settings: the Templates tab icon.
		case 'settings-templates':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="2"
						y="2.4"
						width="5"
						height="5"
						rx="1.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<rect
						x="9"
						y="2.4"
						width="5"
						height="5"
						rx="1.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<rect
						x="2"
						y="9.4"
						width="5"
						height="4.2"
						rx="1.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path
						d="M11.5 9.4v4.2M9.4 11.5h4.2"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'settings-modules':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M8 2 14 5 8 8 2 5z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
					<path
						d="M2 8l6 3 6-3M2 11l6 3 6-3"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'settings-agents':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="5.6" cy="5.2" r="2.2" stroke="currentColor" strokeWidth="1.2" />
					<circle cx="10.8" cy="5.8" r="1.8" stroke="currentColor" strokeWidth="1.2" />
					<path
						d="M1.8 12.6c.4-2.2 1.9-3.3 3.8-3.3s3.4 1.1 3.8 3.3M9.6 12.6c.3-1.6 1.3-2.5 2.6-2.5s2.1.7 2.4 2.5"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'settings-notice':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="var(--amber)" opacity=".3" />
					<path d="M8 4.4v4.2" stroke="var(--amber)" strokeWidth="1.7" strokeLinecap="round" />
					<circle cx="8" cy="11.4" r="1" fill="var(--amber)" />
				</svg>
			);
		case 'settings-appearance':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M8 1.6a6.4 6.4 0 1 0 0 12.8c.9 0 1.4-.6 1.4-1.3 0-.7-.5-1.2-.5-1.8 0-.6.5-1.1 1.2-1.1h1.3a2.9 2.9 0 0 0 2.9-3c0-3-2.8-5.6-6.3-5.6z"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<circle cx="5" cy="6" r="1" fill="currentColor" />
					<circle cx="8" cy="4.6" r="1" fill="currentColor" />
					<circle cx="4.4" cy="9.4" r="1" fill="currentColor" />
				</svg>
			);
		case 'settings-editor':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M5.6 4.4 2 8l3.6 3.6M10.4 4.4 14 8l-3.6 3.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'settings-language':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.2" />
					<path
						d="M1.8 8h12.4M8 1.6c1.8 1.8 2.6 4 2.6 6.4S9.8 12.6 8 14.4C6.2 12.6 5.4 10.4 5.4 8S6.2 3.4 8 1.6z"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
				</svg>
			);
		case 'review-info':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
					<path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
					<circle cx="8" cy="4.9" r=".9" fill="currentColor" />
				</svg>
			);
		// Browser: open externally.
		case 'external':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M9.4 2.6h4v4M13.4 2.6 7.8 8.2"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M12 9.8v2.8a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.8"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		// Files inspector icons, including the eye variant.
		case 'tree-eye':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M1.6 8s2.4-4.2 6.4-4.2S14.4 8 14.4 8s-2.4 4.2-6.4 4.2S1.6 8 1.6 8z"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.2" />
				</svg>
			);
		case 'tree-search':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
					<path
						d="M10.6 10.6 14 14"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/task-window#files-look: the branch mark of the Files scope header and of nested scope rows.
		case 'tree-branch':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5">
					<circle cx="4.5" cy="3.5" r="1.8" />
					<circle cx="4.5" cy="12.5" r="1.8" />
					<circle cx="11.5" cy="5.5" r="1.8" />
					<path d="M4.5 5.3v5.4M11.5 7.3c0 2.6-3 2.6-6.4 3.6" />
				</svg>
			);
		case 'tree-right':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 10 10"
					fill="none">
					<path
						d="M3.6 2 6.6 5 3.6 8"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'send-context':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.4 3.6a1 1 0 0 1 1-1h9.2a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H6.9L4 13.4v-2.6H3.4a1 1 0 0 1-1-1z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
					<path
						d="M8 8.2V4.6M6.4 6.2 8 4.6l1.6 1.6"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'page-console':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.6"
						y="2.6"
						width="12.8"
						height="10.8"
						rx="2.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M1.6 6.2h12.8" stroke="currentColor" strokeWidth="1.2" />
					<path
						d="M4.2 8.8h4.4M4.2 11.1h6.6"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'pick':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.4 6.4V3.4a1 1 0 0 1 1-1h3M13.6 6.4V3.4a1 1 0 0 0-1-1h-3M2.4 9.6v3a1 1 0 0 0 1 1h2.2"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
					<path
						d="m8.1 7.2 5.3 2.2-2.2.8-.8 2.2z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'mobile':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="4.6"
						y="1.8"
						width="6.8"
						height="12.4"
						rx="1.8"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M7.2 12.4h1.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
				</svg>
			);
		case 'desktop':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.8"
						y="3"
						width="12.4"
						height="8.2"
						rx="1.6"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M5.6 13.6h4.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
				</svg>
			);
		// Review icons: selection and draft.
		case 'comment':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.4 3.4h11.2v7.4H7.6L4.4 13.4v-2.6H2.4z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'paperclip':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M10.6 5.4 6.2 9.8a2.2 2.2 0 0 0 3.1 3.1l4.4-4.4a4.4 4.4 0 0 0-6.2-6.2L2.9 6.9"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'comment-list':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.6 4h10.8M2.6 8h10.8M2.6 12h6.4"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'send-chat':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.4 8h7.2M6 4.4 9.6 8 6 11.6M12.4 3.4v9.2"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'send-chat-go':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M3.4 4.4h5.2a4 4 0 0 1 0 8H4.6M7 9.8 4.4 12.4 7 15"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);

		// Custom filter/undo: drawn here, no source icon.
		case 'filter':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round">
					<path d="M2 4h12M5 8h6M7 12h2" />
				</svg>
			);
		case 'undo':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="m5 2-3 3 3 3M2 5h7a4 4 0 0 1 0 8H6" />
				</svg>
			);
		case 'copy':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="5.4"
						y="2.4"
						width="8.2"
						height="10.2"
						rx="1.6"
						stroke="currentColor"
						strokeWidth="1.2"></rect>
					<path d="M10.6 13.6H3.4a1 1 0 0 1-1-1V5.4" stroke="currentColor" strokeWidth="1.2"></path>
				</svg>
			);
		case 'more':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="currentColor">
					<circle cx="3" cy="8" r="1" />
					<circle cx="8" cy="8" r="1" />
					<circle cx="13" cy="8" r="1" />
				</svg>
			);

		// Search Everywhere: the file-result outline.
		// Question card: the inline question header.
		case 'question':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="var(--amber)" opacity=".3" />
					<path
						d="M6.1 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.7.5-.7 1"
						stroke="var(--amber)"
						strokeWidth="1.4"
						strokeLinecap="round"
					/>
					<circle cx="8" cy="11.4" r=".9" fill="var(--amber)" />
				</svg>
			);
		case 'search-file':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4 2.5h5.2L12.5 6v7.5H4z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'code':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M5.6 4.4 2.2 8l3.4 3.6M10.4 4.4 13.8 8l-3.4 3.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'file':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4 2.2h5l3 3v8.6H4z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
					<path d="M9 2.2v3.2h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
				</svg>
			);
		// spec/editor#new-file: «New file…» — the file outline with a plus inside (own drawing: the set had no such glyph).
		case 'file-new':
			// spec/editor#new-file: the Tools menu glyph — a rounded file with the folded corner and a plus.
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M9.2 1.8H4.4a1.2 1.2 0 0 0-1.2 1.2v10a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V5.4z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
					<path
						d="M9.2 1.8v3.6h3.6M8 7.6v4.4M5.8 9.8h4.4"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'trash':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.8 4.4h10.4M6.4 4.4V3a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.4M4.2 4.4l.6 8.2a1.2 1.2 0 0 0 1.2 1.1h4a1.2 1.2 0 0 0 1.2-1.1l.6-8.2"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'edit':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<path
						d="M3 13l.9-3.2L10.6 3.1a1.3 1.3 0 0 1 1.85 0l.45.45a1.3 1.3 0 0 1 0 1.85L6.2 12.1 3 13z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
						fill="none"
					/>
					<path d="M9.6 4.1l2.3 2.3" stroke="currentColor" strokeWidth="1.2" />
				</svg>
			);
		case 'save':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2">
					<path d="M2 2h10l2 2v10H2ZM5 2v4h6V2M5 14V9h6v5" />
				</svg>
			);
		case 'symbol':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2">
					<path d="M6 2H4v12h2M10 2h2v12h-2M6 8h4" />
				</svg>
			);
		// Diff inspector layout controls.
		case 'unified':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="2"
						y="2.6"
						width="12"
						height="10.8"
						rx="2.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path
						d="M4.6 6h6.8M4.6 8.6h4.6M4.6 11.2h6.8"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/editor#markdown-views: Markdown views: code beside its preview, and an open book.
		case 'md-side':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="2"
						y="2.6"
						width="12"
						height="10.8"
						rx="2.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M8 2.6v10.8" stroke="currentColor" strokeWidth="1.2" />
					<path
						d="M3.9 6.1 5.1 7.3 3.9 8.5"
						stroke="currentColor"
						strokeWidth="1.05"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path d="M9.7 6h2.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
					<path
						d="M9.7 8.6h2.4M9.7 10.6h1.6"
						stroke="currentColor"
						strokeWidth="1"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'md-preview':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M8 4.3C6.7 3.3 4.7 2.9 2.3 3.1v9.6c2.4-.2 4.4.2 5.7 1.2 1.3-1 3.3-1.4 5.7-1.2V3.1C11.3 2.9 9.3 3.3 8 4.3Zm0 0v9.6"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'wrap':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.4 4h11.2M2.4 8h8.2a2.4 2.4 0 1 1 0 4.8H8.4M10.4 10.8 8.4 12.8l2 2M2.4 12.8h3"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'split':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="2"
						y="2.6"
						width="12"
						height="10.8"
						rx="2.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M8 2.6v10.8" stroke="currentColor" strokeWidth="1.2" />
					<path
						d="M4 6.2h2.4M4 9.4h2.4M9.6 6.2H12M9.6 9.4H12"
						stroke="currentColor"
						strokeWidth="1.1"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'why':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2">
					<circle cx="8" cy="8" r="6" />
					<path d="M6 6c0-3 5-3 4 0-.5 1-2 1-2 3M8 11v1" />
				</svg>
			);

		case 'back':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M9.6 3.4 5 8l4.6 4.6"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'forward':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M6.4 3.4 11 8l-4.6 4.6"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		// spec/chat#images: a tile whose image could not be opened. Drawn for this state (no source icon): a picture frame struck through.
		// spec/tasks#backlog-edit: the picture of the sheet's «⌘V or drag» hint (image-off without its slash).
		case 'image':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
					strokeLinejoin="round">
					<rect x="2.2" y="3" width="11.6" height="10" rx="1.8" />
					<path d="M4.6 10.6 7 8.2l1.8 1.8 1.2-1.1 1.6 1.7" />
					<circle cx="10.6" cy="6.1" r="1" />
				</svg>
			);
		case 'image-off':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="2.2"
						y="3"
						width="11.6"
						height="10"
						rx="1.8"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path
						d="M4.6 10.6 7 8.2l1.8 1.8 1.2-1.1 1.6 1.7"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M2.6 2.4 13.6 13.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'camera':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2">
					<path d="M2 5h3l1-2h4l1 2h3v8H2Z" />
					<circle cx="8" cy="8.5" r="2.5" />
				</svg>
			);
		case 'clear':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.6 4.4h10.8M5.4 4.4V3.2a1 1 0 0 1 1-1h3.2a1 1 0 0 1 1 1v1.2M4.2 4.4l.7 8.2a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.7-8.2"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'network':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4.4 12.4V6.2M4.4 3.2 2.2 5.4M4.4 3.2l2.2 2.2"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M11.6 3.6v6.2M11.6 12.8l2.2-2.2M11.6 12.8 9.4 10.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'inspect':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.6"
						y="2.6"
						width="12.8"
						height="10.8"
						rx="2.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M1.6 6.2h12.8" stroke="currentColor" strokeWidth="1.2" />
					<circle cx="7.4" cy="9.6" r="2.2" stroke="currentColor" strokeWidth="1.2" />
					<path
						d="m9.1 11.3 1.9 1.9"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'hide':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 10 10">
					<path
						d="M2 3.6 5 6.6 8 3.6"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
						fill="none"
					/>
				</svg>
			);
		case 'close':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'history':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.2"></circle>
					<path
						d="M8 4.6V8l2.4 1.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"></path>
				</svg>
			);
		case 'chat':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.6 6.4a2.8 2.8 0 0 1 2.8-2.8h5.2a2.8 2.8 0 0 1 2.8 2.8v2.2a2.8 2.8 0 0 1-2.8 2.8H7.4l-3.2 2.3v-2.4a2.8 2.8 0 0 1-1.6-2.5z"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"></path>
				</svg>
			);
		case 'editor':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M6.2 4.4 3 8l3.2 3.6M9.8 4.4 13 8l-3.2 3.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"></path>
				</svg>
			);
		case 'diff':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.4 4.6h3.4M4.1 2.9v3.4M13.6 2.4 5.2 13.6M10.2 11.4h3.4"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"></path>
				</svg>
			);
		case 'review':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M5 2h8v12H3V4m2-2v3H2m4 3h4m-4 3h3" />
				</svg>
			);
		// spec/browser-and-simulator#simulator: the simulator glyphs.
		case 'simulator':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="3.6"
						y="1.4"
						width="7.6"
						height="13.2"
						rx="2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M6.4 3.4h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
					<circle
						cx="11.6"
						cy="11.4"
						r="2.6"
						fill="var(--bgdot, var(--tb))"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<circle cx="11.6" cy="11.4" r=".9" fill="currentColor" />
				</svg>
			);
		case 'sim-home':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M2.6 7.4 8 2.8l5.4 4.6M4.2 6.2v6.8h7.6V6.2"
						stroke="currentColor"
						strokeWidth="1.25"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'sim-rotate':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M3 8a5 5 0 0 1 8.6-3.5M13 8a5 5 0 0 1-8.6 3.5"
						stroke="currentColor"
						strokeWidth="1.25"
						strokeLinecap="round"
					/>
					<path
						d="M11.8 2.2v2.6H9.2M4.2 13.8v-2.6h2.6"
						stroke="currentColor"
						strokeWidth="1.25"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'sim-devtools':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<ellipse cx="8" cy="8" rx="6.4" ry="2.5" stroke="currentColor" strokeWidth="1.1" />
					<ellipse
						cx="8"
						cy="8"
						rx="6.4"
						ry="2.5"
						stroke="currentColor"
						strokeWidth="1.1"
						transform="rotate(60 8 8)"
					/>
					<ellipse
						cx="8"
						cy="8"
						rx="6.4"
						ry="2.5"
						stroke="currentColor"
						strokeWidth="1.1"
						transform="rotate(-60 8 8)"
					/>
					<circle cx="8" cy="8" r="1.1" fill="currentColor" />
				</svg>
			);
		case 'platform-android':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M3.2 11V8.2a4.8 4.8 0 0 1 9.6 0V11z"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
					<path
						d="M5 4.4 4 2.8M11 4.4l1-1.6"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
					<circle cx="6" cy="8.4" r=".7" fill="currentColor" />
					<circle cx="10" cy="8.4" r=".7" fill="currentColor" />
				</svg>
			);
		case 'platform-apple':
			return (
				<svg data-glyph={name} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
					<path
						fill="currentColor"
						d="M11.2 8.5c0-1.6 1.3-2.3 1.4-2.4-.8-1.1-1.9-1.3-2.3-1.3-1-.1-1.9.6-2.4.6-.5 0-1.3-.6-2.1-.5-1.1 0-2.1.6-2.6 1.6-1.1 1.9-.3 4.8.8 6.3.5.8 1.1 1.6 1.9 1.6.8 0 1-.5 2-.5s1.2.5 2 .5c.8 0 1.4-.8 1.9-1.5.6-.9.8-1.7.8-1.8 0 0-1.4-.6-1.4-2.6zM9.7 3.8c.4-.5.7-1.2.6-1.9-.6 0-1.3.4-1.8.9-.4.4-.7 1.1-.6 1.8.7.1 1.3-.3 1.8-.8z"
					/>
				</svg>
			);
		case 'browser':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.6"
						y="2.6"
						width="12.8"
						height="10.8"
						rx="2.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path d="M1.6 6.2h12.8" stroke="currentColor" strokeWidth="1.2" />
					<circle cx="3.9" cy="4.4" r=".7" fill="currentColor" />
					<circle cx="6" cy="4.4" r=".7" fill="currentColor" />
				</svg>
			);
		case 'console':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="1.6"
						y="2.6"
						width="12.8"
						height="10.8"
						rx="2.2"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path
						d="M4.6 6.2 6.6 8l-2 1.8M8.6 10h3"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'refresh':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M13 8a5 5 0 1 1-1.6-3.7"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
					<path
						d="M13.2 2.4v3.2H10"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'send':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M8 12.6V3.8M4.2 7.2 8 3.4l3.8 3.8"
						stroke="currentColor"
						strokeWidth="1.7"
						strokeLinecap="round"
						strokeLinejoin="round"></path>
				</svg>
			);
		// spec/composer-steering-queue-and-ghost#steering-hold: «Waiting for the agent» and «Queue».
		case 'tool-error':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="7" fill="currentColor" opacity=".22" />
					<path
						d="M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4"
						stroke="currentColor"
						strokeWidth="1.8"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'tool-group':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<rect
						x="2.4"
						y="6.6"
						width="11.2"
						height="6.8"
						rx="1.6"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path
						d="M4 4.5h8M5.6 2.5h4.8"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
			);
		case 'clock':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
					<path
						d="M8 4.8V8l2.2 1.5"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'send-now':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<path
						d="M8 12.6V3.8M4.2 7.2 8 3.4l3.8 3.8"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);
		case 'stop':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M5 5h6v6H5Z" />
				</svg>
			);
		case 'openai':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="-1.5 -1.5 27 27"
					fill="currentColor"
					fillRule="evenodd">
					<path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
				</svg>
			);
		// spec/remote-access-and-mobile#client-ui-seam: the folder browser's row and its «Up».
		case 'folder-browse':
			return (
				<Line name={name} size={size}>
					<path d="M1.8 4.4a1 1 0 0 1 1-1h3.1l1.4 1.6h5.9a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
				</Line>
			);
		case 'folder-up':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M8 13V3.5M4 7.5l4-4 4 4" />
				</svg>
			);
		case 'folder':
		case 'folder-plus':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2">
					<path d="M1.8 4.6a1 1 0 0 1 1-1h3l1.3 1.6h7.1a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
					{name === 'folder-plus' && <path d="M8 7.6v3.6M6.2 9.4h3.6" strokeLinecap="round" />}
				</svg>
			);
		// spec/composer#paste: the drop zone's arrow for dragged files.
		case 'drop':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.4"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M8 2.6v7.6M4.8 7.2 8 10.4l3.2-3.2M3 13.2h10" />
				</svg>
			);
		case 'plus':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.4"
					strokeLinecap="round">
					<path d="M8 2.6v10.8M2.6 8h10.8" />
				</svg>
			);
		case 'search':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none">
					<circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.3" />
					<path
						d="M10.4 10.4 13.6 13.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
			);
		// spec/chat#mcp-calls: a tool of another MCP server; the plug says «connected from outside» without naming a brand.
		case 'plug':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
					strokeLinejoin="round">
					<path d="M5.6 1.8v3M10.4 1.8v3M4 4.8h8v2.6a4 4 0 0 1-8 0zM8 11.4v2.8" />
				</svg>
			);
		case 'helmet':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 30 30"
					fill="currentColor">
					<path d="M 14 3 C 13.448 3 13 3.448 13 4 L 13 4.2304688 L 13 6 C 13 6.552 12.552 7 12 7 C 11.448 7 11 6.552 11 6 L 11 4.9472656 C 8.039 6.4202656 6 9.468 6 13 L 6 15 L 5 15 A 1.0001 1.0001 0 1 0 5 17 L 6 17 L 6 17.957031 L 6 18.572266 L 6 19.800781 C 6 21.067448 6.5630258 21.996554 7.140625 22.501953 C 7.4938002 22.810981 7.645978 22.816388 7.8847656 22.910156 C 7.9749139 23.146233 8.2661545 23.820662 8.8085938 24.595703 C 9.6466236 26.386706 11.361419 27.951961 14.869141 27.992188 A 1.0001 1.0001 0 0 0 14.990234 28 C 14.993687 28.000003 14.996544 28 15 28 A 1.0001 1.0001 0 0 0 15.119141 27.994141 C 18.639347 27.957433 20.357374 26.385577 21.195312 24.589844 C 21.735475 23.817323 22.025288 23.145704 22.115234 22.910156 C 22.354022 22.816386 22.5062 22.810986 22.859375 22.501953 C 23.436974 21.996554 24 21.067448 24 19.800781 L 24 18.199219 L 24 17.957031 L 24 17 L 25 17 A 1.0001 1.0001 0 1 0 25 15 L 11 15 C 10.448 15 10 14.552 10 14 C 10 13.448 10.448 13 11 13 L 24 13 C 24 9.468 21.961 6.4202656 19 4.9472656 L 19 6 C 19 6.552 18.552 7 18 7 C 17.448 7 17 6.552 17 6 L 17 4.2304688 L 17 4 C 17 3.448 16.552 3 16 3 L 14 3 z M 10.976562 17 L 21.005859 17 C 21.565329 17.52777 22 18.220543 22 19 L 22 19.800781 C 22 19.885592 21.98641 19.944577 21.980469 20.017578 C 21.923071 20.074882 18.990261 23 18 23 C 17 23 15.992 22 15 22 C 14.008 22 13 23 12 23 C 11.009739 23 8.0769288 20.074882 8.0195312 20.017578 C 8.0135905 19.944577 8 19.885592 8 19.800781 L 8 18.572266 C 8 17.38592 9.7084243 18.231752 10.976562 17 z" />
				</svg>
			);
		case 'person':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 16 16"
					fill="currentColor">
					<circle cx="8" cy="5.4" r="2.6" stroke="currentColor" strokeWidth="1.3" fill="none" />
					<path
						d="M3.4 13.2c.5-2.4 2.2-3.6 4.6-3.6s4.1 1.2 4.6 3.6"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						fill="none"
					/>
				</svg>
			);
		case 'claude':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="-2 -2 28 28"
					fill="currentColor">
					<path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
				</svg>
			);
		case 'effort':
			return (
				<svg
					data-glyph={name}
					aria-hidden="true"
					width={size}
					height={size}
					viewBox="0 0 14 14"
					fill="currentColor">
					<circle
						cx="7"
						cy="7"
						r="5.25"
						stroke="currentColor"
						strokeWidth="1.15"
						opacity=".45"
						fill="none"
					/>
					<path d="M7 7 L7 2.9 A4.1 4.1 0 1 1 2.90 7.00 Z" fill="currentColor" />
				</svg>
			);
	}
}

/** The window frame of the Layout glyphs (spec/task-window-workspace#layout-switch): `fill` — the filled column as [x, width], clipped by the frame. */
function ColumnFrame({
	name,
	size,
	fill,
	clip: always = false,
	children,
}: {
	name: GlyphName;
	size: number;
	fill: [number, number] | null;
	/** The clip stands even with nothing to fill (the Layout glyphs keep it, spec/task-window-workspace#layout-switch). */ clip?: boolean;
	children?: ReactNode;
}) {
	const clip = `glyph-clip-${name}`;
	return (
		<svg
			data-glyph={name}
			data-column="true"
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none">
			{(fill || always) && (
				<defs>
					<clipPath id={clip}>
						<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.4" />
					</clipPath>
				</defs>
			)}
			{fill && (
				<>
					<rect
						x={fill[0]}
						y="2.6"
						width={fill[1]}
						height="10.8"
						fill="currentColor"
						clipPath={`url(#${clip})`}
					/>
				</>
			)}
			{children}
			<rect
				x="1.6"
				y="2.6"
				width="12.8"
				height="10.8"
				rx="2.4"
				stroke="currentColor"
				strokeWidth="1.2"
			/>
		</svg>
	);
}
