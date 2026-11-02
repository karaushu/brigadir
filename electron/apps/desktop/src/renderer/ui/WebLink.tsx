import type { ReactNode } from 'react';
import s from './WebLink.module.css';

/**
 * spec/remote-access-and-mobile#tailscale-guidance: a website link in running text (the Tailscale download, its admin console). It opens in the system
 * browser through `openWebLink` — on a device's window, on that device — never inside the app.
 */
export function WebLink({
	href,
	children,
	...data
}: {
	href: string;
	children: ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	return (
		<a
			{...data}
			// spec/appearance#touch-targets: a link inside a sentence keeps the text's line height — no hidden hit area around it (spec/appearance#control-scale).
			data-allow-small
			className={s.link}
			href={href}
			rel="noreferrer"
			onClick={(event) => {
				event.preventDefault();
				void window.brigadir.openWebLink(href).catch(() => {});
			}}>
			{children}
		</a>
	);
}
