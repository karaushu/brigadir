import s from './Avatar.module.css';
/**
 * Avatar — the first letter of the login on a palette token (rule 4: no hardcoded colours). One look for PRs on desktop and
 * phone and for Slack people (rule 17): `s` 14 and `m` 18 — the PR panel, `l` 22 — the touch scale (spec/remote-access-and-mobile#phone-task-tools)
 * and the Slack mention's header; `xl` 24, `xxl` 28 and `xxxl` 32 — the Slack section's rows, thread and People
 * (spec/todo-and-slack-inbox#slack-inbox-entry). `name` shows two initials; `badge` sits on the corner: an amber dot — waiting, a green
 * tick — answered.
 */
export function Avatar({
	login,
	name,
	size = 's',
	badge,
	label,
}: {
	login: string;
	/** A person's name: its initials (`Olena Kovalenko` → `OK`) and the tooltip. */
	name?: string | undefined;
	size?: 's' | 'm' | 'l' | 'xl' | 'xxl' | 'xxxl';
	badge?: 'waiting' | 'answered' | null | undefined;
	/** The tooltip instead of the name (`Olena · 3 mentions`). */
	label?: string | undefined;
}) {
	let hash = 0;
	for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	const initials = name
		? name
				.trim()
				.split(/[\s._-]+/)
				.filter(Boolean)
				.slice(0, 2)
				.map((word) => [...word][0]!.toUpperCase())
				.join('')
		: login.slice(0, 1).toUpperCase();
	return (
		<span
			className={s.avatar}
			data-size={size}
			data-avatar
			style={{ background: `var(--avatar-${hash % 6})` }}
			title={label ?? name ?? login}>
			{initials}
			{badge && (
				<span className={s.badge} data-badge={badge} aria-hidden="true">
					{badge === 'answered' && (
						<svg width="8" height="8" viewBox="0 0 8 8" fill="none">
							<path
								d="M1.6 4.2 3.3 5.8 6.4 2.4"
								stroke="currentColor"
								strokeWidth="1.4"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					)}
				</span>
			)}
		</span>
	);
}
