import { useEffect, useId, useRef, useState } from 'react';
import {
	t,
	attachmentLabel,
	type Locale,
	type PromptAttachment,
	type TaskKey,
} from '@brigadir/core';
import { PopupClose } from './PopupClose';
import { Glyph } from './Glyph';
import { Thumbnail, useThumbnail } from './Thumbnail';
import styles from './ImageViewer.module.css';

/** spec/chat#images: a message's images over the whole window (focus on the surface itself, so ←/→ work at once and no ring shows on Esc) — the picture fitted without upscaling, `Esc` in the header (rule 14),
 * ←/→ and a strip of 44 px tiles when there are several. The full PNG is read only here. */
export function ImageViewer({
	task,
	locale,
	images,
	index: initial,
	close,
}: {
	task: TaskKey;
	locale: Locale;
	images: PromptAttachment[];
	index: number;
	close(): void;
}) {
	const ref = useRef<HTMLDialogElement>(null),
		titleId = useId();
	const [index, setIndex] = useState(Math.max(0, Math.min(initial, images.length - 1)));
	const [image, setImage] = useState<{
		id: string;
		src: string | null;
		failed: boolean;
		width: number;
		height: number;
	}>({ id: '', src: null, failed: false, width: 0, height: 0 });
	const item = images[index]!,
		label = attachmentLabel(locale, item),
		many = images.length > 1;
	useEffect(() => {
		const previous = document.activeElement,
			dialog = ref.current!;
		dialog.showModal();
		dialog.focus({ preventScroll: true });
		return () => {
			dialog.close();
			if (previous instanceof HTMLElement && previous.isConnected)
				previous.focus({ preventScroll: true });
		};
	}, []);
	useEffect(() => {
		let active = true;
		setImage({ id: item.id, src: null, failed: false, width: 0, height: 0 });
		void window.brigadir.readAttachment(task, item.id).then(
			(input) => {
				if (active)
					setImage(
						input.kind === 'image'
							? {
									id: item.id,
									src: `data:${input.mimeType};base64,${input.data}`,
									failed: false,
									width: 0,
									height: 0,
								}
							: { id: item.id, src: null, failed: true, width: 0, height: 0 }
					);
			},
			() => {
				if (active) setImage({ id: item.id, src: null, failed: true, width: 0, height: 0 });
			}
		);
		return () => {
			active = false;
		};
	}, [task.id, task.projectId, item.id]);
	const go = (next: number) => {
		if (next >= 0 && next < images.length) setIndex(next);
	};
	const current = image.id === item.id ? image : { src: null, failed: false, width: 0, height: 0 };
	return (
		<dialog
			ref={ref}
			tabIndex={-1}
			className={styles.viewer}
			aria-labelledby={titleId}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onKeyDown={(event) => {
				if (event.key === 'ArrowLeft') {
					event.preventDefault();
					go(index - 1);
				} else if (event.key === 'ArrowRight') {
					event.preventDefault();
					go(index + 1);
				}
			}}>
			<header className={styles.header}>
				<h2 id={titleId} className={styles.name}>
					<bdi>{label}</bdi>
				</h2>
				{current.width > 0 && (
					<span className={styles.meta}>
						{current.width} × {current.height}
					</span>
				)}
				{many && (
					<span className={styles.counter} aria-live="polite">
						{t(locale, '{index} of {count}')
							.replace('{index}', new Intl.NumberFormat(locale).format(index + 1))
							.replace('{count}', new Intl.NumberFormat(locale).format(images.length))}
					</span>
				)}
				<span className={styles.space} />
				<PopupClose locale={locale} close={close} />
			</header>
			<div className={styles.stage}>
				{current.failed ? (
					<div className={styles.missing} role="status">
						<Glyph name="image-off" size={28} />
						<strong>{t(locale, 'The image could not be opened')}</strong>
						<span>
							{t(locale, 'The attachment file is gone from the task data or has changed.')}
						</span>
					</div>
				) : (
					current.src && (
						<img
							key={item.id}
							className={styles.image}
							alt={label}
							src={current.src}
							onLoad={(event) => {
								const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
								setImage((state) => (state.id === item.id ? { ...state, width, height } : state));
							}}
						/>
					)
				)}
				{many && (
					<>
						<button
							type="button"
							className={styles.arrow}
							data-side="previous"
							aria-label={`${t(locale, 'Previous image')} · ←`}
							title={`${t(locale, 'Previous image')} · ←`}
							disabled={index === 0}
							onClick={() => go(index - 1)}>
							<Glyph name="back" size={16} />
						</button>
						<button
							type="button"
							className={styles.arrow}
							data-side="next"
							aria-label={`${t(locale, 'Next image')} · →`}
							title={`${t(locale, 'Next image')} · →`}
							disabled={index === images.length - 1}
							onClick={() => go(index + 1)}>
							<Glyph name="forward" size={16} />
						</button>
					</>
				)}
			</div>
			{many && (
				<div className={styles.strip} role="tablist" aria-label={t(locale, 'Message images')}>
					{images.map((image, i) => (
						<StripTile
							key={image.id}
							task={task}
							locale={locale}
							item={image}
							selected={i === index}
							select={() => setIndex(i)}
						/>
					))}
				</div>
			)}
		</dialog>
	);
}
function StripTile({
	task,
	locale,
	item,
	selected,
	select,
}: {
	task: TaskKey;
	locale: Locale;
	item: PromptAttachment;
	selected: boolean;
	select(): void;
}) {
	const thumb = useThumbnail(task, item),
		label = attachmentLabel(locale, item);
	return (
		<button
			type="button"
			role="tab"
			aria-selected={selected}
			className={styles.tile}
			data-state={thumb.failed ? 'missing' : thumb.src ? undefined : 'loading'}
			aria-label={label}
			title={label}
			onClick={select}>
			{thumb.src ? (
				<Thumbnail src={thumb.src} />
			) : (
				thumb.failed && <Glyph name="image-off" size={14} />
			)}
		</button>
	);
}
