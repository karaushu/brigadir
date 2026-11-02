import type { ReactNode } from 'react';
import type { Locale } from '@brigadir/core';
import { ModalDialog } from './ModalDialog';
import styles from './DocumentDialog.module.css';
/**
 * Content previews: the divided `ModalDialog` (spec/appearance#dialogs), 800 wide in the middle of the window;
 * only the body scrolls. The header closes with `Esc` (rule 14, spec/chat#images).
 */
export function DocumentDialog({
	title,
	locale,
	children,
	footer,
	close,
}: {
	title: string;
	locale: Locale;
	children: ReactNode;
	footer?: ReactNode;
	close(): void;
}) {
	return (
		<ModalDialog
			divided
			width={800}
			top="center"
			title={title}
			locale={locale}
			close={close}
			footer={footer}>
			<div className={styles.content}>{children}</div>
		</ModalDialog>
	);
}
