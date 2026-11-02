import s from './Avatar.module.css';
/**
 * Avatar — the first letter of the login on a palette token (rule 4: no hardcoded colours). One look for PRs on desktop and
 * phone (rule 17): `s` 14 and `m` 18 — the PR panel, `l` 22 — the touch scale (spec/remote-access-and-mobile#phone-task-tools).
 */
export function Avatar({ login, size = 's' }: { login: string; size?: 's' | 'm' | 'l' }) {
	let hash = 0;
	for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return (
		<span
			className={s.avatar}
			data-size={size}
			data-avatar
			style={{ background: `var(--avatar-${hash % 6})` }}
			title={login}>
			{login.slice(0, 1).toUpperCase()}
		</span>
	);
}
