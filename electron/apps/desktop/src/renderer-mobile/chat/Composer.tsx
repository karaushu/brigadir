/**
 * spec/composer-steering-queue-and-ghost#steering, spec/remote-access-and-mobile#phone-app: the phone's composer — the queue's row with
 * «Надіслати зараз», the field, «+» (camera, photo, file), the context %, the model chip, Send / Stop, and under it the task's
 * branch `⑂ гілка +N −M від база` (a tap opens Changes) or the limit's chip. A tap on Send during a turn sends into it; a long
 * press offers «Надіслати зараз» / «В чергу».
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
	formatDuration,
	t,
	type AgentOption,
	type AgentTask,
	type Locale,
	type PromptAttachment,
	type QueuedPrompt,
	type SessionCommand,
} from '@brigadir/core';
import { Glyph } from '../../renderer/ui/Glyph';
import { Counts } from '../ui/Cards';
import { Icon } from '../ui/Icon';
import { Spinner } from '../ui/Loading';
import s from './Composer.module.css';

type Picked = { attachment: PromptAttachment; url: string };
/** Older Safari has no `field-sizing: content` (spec/remote-access-and-mobile#phone-chat): the field then grows by its scroll height, up to 160. */
const sizesItself =
	typeof CSS !== 'undefined' &&
	typeof CSS.supports === 'function' &&
	CSS.supports('field-sizing', 'content');
const maxFieldHeight = 160;
const longPressMs = 500;
/** Large photos shrink to 2048 px on the long side: a phone's camera writes 12 MP and the upload limit is 10 MB. */
async function shrink(file: File): Promise<{ name: string; bytes: Uint8Array; image: boolean }> {
	const image = file.type.startsWith('image/');
	if (image && file.size > 1_500_000 && typeof createImageBitmap === 'function') {
		try {
			const bitmap = await createImageBitmap(file),
				scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height)),
				canvas = document.createElement('canvas');
			canvas.width = Math.round(bitmap.width * scale);
			canvas.height = Math.round(bitmap.height * scale);
			canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise<Blob | null>((done) =>
				canvas.toBlob(done, 'image/jpeg', 0.85)
			);
			if (blob)
				return {
					name: file.name.replace(/\.[^.]+$/, '') + '.jpg',
					bytes: new Uint8Array(await blob.arrayBuffer()),
					image: true,
				};
		} catch {
			// The original goes as it is.
		}
	}
	return { name: file.name || 'photo.jpg', bytes: new Uint8Array(await file.arrayBuffer()), image };
}
/** How long the limit lasts in whole minutes, by the shared formatter: «42 хв», «2 год», «1 год 5 хв»; unknown — «?». */
export function limitTime(locale: Locale, minutes: number | null) {
	return minutes ? formatDuration(locale, minutes * 60_000) : '?';
}
export function Composer({
	task,
	locale,
	machine,
	busy,
	steers,
	steering,
	disabled,
	limitMinutes,
	queued,
	options,
	context,
	send,
	prepare,
	openChanges,
	openModel,
	openLimit,
}: {
	task: AgentTask;
	locale: Locale;
	machine: string;
	busy: boolean;
	/** The message goes into the running turn (spec/composer-steering-queue-and-ghost#steering); otherwise behind it. */ steers: boolean;
	/** A queued message can still go into the turn (the queue's «Надіслати зараз», spec/composer-steering-queue-and-ghost#steering-hold). */ steering: boolean;
	disabled: boolean;
	/** spec/remote-access-and-mobile#phone-app: the subscription limit with minutes to its reset; null — no limit. */ limitMinutes:
		number | null;
	queued: readonly QueuedPrompt[];
	options: readonly AgentOption[];
	context: number | null;
	send(command: SessionCommand): Promise<boolean>;
	/** Starts an idle agent before the first message; false keeps the draft. */ prepare(): Promise<boolean>;
	openChanges(): void;
	openModel(): void;
	openLimit(): void;
}) {
	const [text, setText] = useState(''),
		[picked, setPicked] = useState<Picked[]>([]),
		[menu, setMenu] = useState<'send' | 'attach' | null>(null),
		[sending, setSending] = useState(false),
		[uploading, setUploading] = useState(0),
		[attachError, setAttachError] = useState(false);
	const field = useRef<HTMLTextAreaElement>(null),
		camera = useRef<HTMLInputElement>(null),
		photo = useRef<HTMLInputElement>(null),
		file = useRef<HTMLInputElement>(null),
		press = useRef<{ timer: ReturnType<typeof setTimeout>; long: boolean } | null>(null),
		loaded = useRef(false);
	const key = { projectId: task.projectId, id: task.id };
	useEffect(() => {
		loaded.current = false;
		void window.brigadir.readComposer(key).then(
			(draft) => {
				if (draft) setText(draft);
				loaded.current = true;
			},
			() => (loaded.current = true)
		);
	}, [task.id]);
	useEffect(() => {
		if (!loaded.current) return;
		const timer = setTimeout(
			() => void window.brigadir.saveComposer(key, text).catch(() => {}),
			600
		);
		return () => clearTimeout(timer);
	}, [text]);
	useLayoutEffect(() => {
		const node = field.current;
		if (sizesItself || !node) return;
		node.style.height = 'auto';
		node.style.height = `${Math.min(node.scrollHeight, maxFieldHeight)}px`;
	}, [text]);
	const filled = Boolean(text.trim()) || picked.length > 0;
	const submit = async (steer: boolean) => {
		if (!filled || sending || disabled) return;
		setSending(true);
		try {
			if (!(await prepare())) return;
			const ids = picked.map((item) => item.attachment.id);
			if (
				await send({
					kind: 'prompt',
					text: text.trim(),
					...(ids.length ? { attachmentIds: ids } : {}),
					...(steer ? { steer: true as const } : {}),
				})
			) {
				setText('');
				for (const item of picked) URL.revokeObjectURL(item.url);
				setPicked([]);
			}
		} finally {
			setSending(false);
		}
	};
	/**
	 * Shrinking and sending a photo takes seconds: a pending thumbnail shows each file on its way, and a file the machine
	 * refused (too large, too many, the link dropped) says so under the thumbnails instead of vanishing.
	 */
	const attach = async (input: HTMLInputElement) => {
		const files = [...(input.files ?? [])].slice(0, 10 - picked.length);
		// The same file chosen again is a change too.
		input.value = '';
		setMenu(null);
		setAttachError(false);
		setUploading((count) => count + files.length);
		for (const item of files) {
			try {
				const { name, bytes, image } = await shrink(item);
				const attachment = await window.brigadir.uploadAttachment(key, name, bytes, image);
				setPicked((list) => [...list, { attachment, url: URL.createObjectURL(item) }]);
			} catch {
				setAttachError(true);
			} finally {
				setUploading((count) => count - 1);
			}
		}
	};
	const model = options.find((option) => /model/i.test(option.id) && option.kind === 'select'),
		effort = options.find(
			(option) => /effort|reasoning/i.test(option.id) && option.kind === 'select'
		);
	const choiceName = (option: AgentOption | undefined) =>
		option?.kind === 'select'
			? (option.choices.find((choice) => choice.value === option.value)?.name ?? option.value)
			: null;
	const modelLabel = [choiceName(model), choiceName(effort)].filter(Boolean).join(' · ');
	const stop = busy && !filled;
	const branch = task.taskTree?.branch ?? task.worktreeBranch ?? null,
		base = task.launch?.baseRef.replace(/^origin\//, '') ?? null,
		counts = task.changeSummary;
	const first = queued[0];
	return (
		<div className={s.wrap} data-composer>
			{first && (
				<div className={s.queue} data-queue-row>
					<span className={s.queueText}>
						<small>
							{t(locale, 'Queued · {count}').replace('{count}', String(queued.length))}
							{limitMinutes !== null ? ` · ${t(locale, 'after the reset')}` : ''}
						</small>
						<span className="ell">{first.command.text}</span>
					</span>
					{steering && limitMinutes === null && (
						<button
							type="button"
							className={s.now}
							data-send-now
							onClick={() => void send({ kind: 'steerQueuedPrompt', id: first.id })}>
							<Icon name="up" size={15} />
							{t(locale, 'Send now')}
						</button>
					)}
				</div>
			)}
			<div className={s.island}>
				{(picked.length > 0 || uploading > 0) && (
					<div className={s.thumbs} data-thumbs>
						{picked.map((item) => (
							<div key={item.attachment.id} className={s.thumb}>
								{item.attachment.kind === 'image' ? (
									<img src={item.url} alt={item.attachment.name} />
								) : (
									<span className={`ell ${s.fileName}`}>{item.attachment.name}</span>
								)}
								<button
									type="button"
									className={s.remove}
									aria-label={`${t(locale, 'Remove')} ${item.attachment.name}`}
									onClick={() => {
										URL.revokeObjectURL(item.url);
										setPicked((list) => list.filter((other) => other !== item));
									}}>
									<Icon name="close" size={12} />
								</button>
							</div>
						))}
						{Array.from({ length: uploading }, (_, index) => (
							<div
								key={`uploading-${index}`}
								className={s.thumb}
								data-uploading
								role="status"
								aria-label={t(locale, 'Attaching…')}>
								<Spinner />
							</div>
						))}
					</div>
				)}
				{attachError && (
					<p className={s.attachError} role="alert" data-attach-error>
						{t(locale, 'The files could not be attached. Check the attachment limits.')}
					</p>
				)}
				<textarea
					ref={field}
					className={s.field}
					rows={1}
					value={text}
					disabled={disabled}
					aria-label={t(locale, 'Message')}
					placeholder={
						disabled
							? t(locale, 'No connection to {machine}').replace('{machine}', machine)
							: limitMinutes !== null
								? t(locale, 'What you send goes after the limit resets')
								: t(locale, 'Write a message…')
					}
					onChange={(event) => setText(event.target.value)}
				/>
				<div className={s.row}>
					<button
						type="button"
						className={s.circle}
						aria-label={t(locale, 'Add a photo or file')}
						aria-expanded={menu === 'attach'}
						disabled={disabled}
						onClick={() => setMenu('attach')}>
						<Icon name="plus" size={22} />
					</button>
					<span className={s.space} />
					{context !== null && (
						<span className={s.context} title={t(locale, 'Context')}>
							{context}%
						</span>
					)}
					{modelLabel && (
						<button
							type="button"
							className={s.model}
							data-model-chip
							disabled={disabled}
							onClick={openModel}>
							{task.provider && (
								<Glyph name={task.provider === 'claude' ? 'claude' : 'openai'} size={13} />
							)}
							{modelLabel}
							<Icon name="chev" size={12} />
						</button>
					)}
					{stop ? (
						<button
							type="button"
							className={s.send}
							aria-label={t(locale, 'Stop')}
							data-stop
							disabled={disabled}
							onClick={() => void send({ kind: 'cancel' })}>
							<Icon name="stop" size={18} />
						</button>
					) : (
						<button
							type="button"
							className={s.send}
							data-idle={!filled || undefined}
							aria-label={t(locale, busy && !steers ? 'Add to queue' : 'Send')}
							aria-haspopup={busy ? 'menu' : undefined}
							disabled={disabled || sending}
							data-send
							onPointerDown={() => {
								if (!busy || !filled) return;
								const timer = setTimeout(() => {
									if (press.current) press.current.long = true;
									setMenu('send');
									navigator.vibrate?.(10);
								}, longPressMs);
								press.current = { timer, long: false };
							}}
							onPointerUp={() => press.current && clearTimeout(press.current.timer)}
							onPointerCancel={() => {
								if (press.current) clearTimeout(press.current.timer);
								press.current = null;
							}}
							onContextMenu={(event) => event.preventDefault()}
							onClick={() => {
								const long = press.current?.long;
								press.current = null;
								if (long) return;
								void submit(steers || !busy);
							}}>
							<Icon name="up" size={20} />
						</button>
					)}
				</div>
				{branch && (
					<button
						type="button"
						className={s.branch}
						data-branch-row
						onClick={limitMinutes !== null ? openLimit : openChanges}>
						<Icon name="branch" size={14} />
						<span className="mono ell">{branch}</span>
						{limitMinutes === null && counts && (counts.additions > 0 || counts.deletions > 0) && (
							<Counts additions={counts.additions} deletions={counts.deletions} />
						)}
						{limitMinutes === null && base && (
							<span className={s.base}>{t(locale, 'from {base}').replace('{base}', base)}</span>
						)}
						<span className={s.space} />
						{limitMinutes !== null ? (
							<span className={s.limit} data-limit-chip>
								<Icon name="clock" size={14} />
								{t(locale, 'Limit · {time}').replace('{time}', limitTime(locale, limitMinutes))}
							</span>
						) : (
							<Icon name="chevr" size={14} className={s.chevron} />
						)}
					</button>
				)}
			</div>
			{menu && (
				<>
					<div className={s.menuScrim} onClick={() => setMenu(null)} aria-hidden="true" />
					<div
						className={s.menu}
						data-menu={menu}
						role="menu"
						aria-label={menu === 'send' ? t(locale, 'Send') : t(locale, 'Add a photo or file')}>
						{menu === 'send' ? (
							<>
								<button
									type="button"
									role="menuitem"
									className={s.item}
									onClick={() => {
										setMenu(null);
										void submit(true);
									}}>
									<Icon name="up" size={20} />
									<span className={s.two}>
										<span>{t(locale, 'Send now')}</span>
										<small>{t(locale, 'Into this turn, at the agent’s next step')}</small>
									</span>
								</button>
								<button
									type="button"
									role="menuitem"
									className={s.item}
									onClick={() => {
										setMenu(null);
										void submit(false);
									}}>
									<Icon name="list" size={20} />
									<span className={s.two}>
										<span>{t(locale, 'To the queue')}</span>
										<small>{t(locale, 'After the turn ends')}</small>
									</span>
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									role="menuitem"
									className={s.item}
									onClick={() => camera.current?.click()}>
									<Icon name="camera" size={20} />
									<span className={s.two}>{t(locale, 'Take photo')}</span>
								</button>
								<button
									type="button"
									role="menuitem"
									className={s.item}
									onClick={() => photo.current?.click()}>
									<Icon name="photo" size={20} />
									<span className={s.two}>{t(locale, 'Choose photo')}</span>
								</button>
								<button
									type="button"
									role="menuitem"
									className={s.item}
									onClick={() => file.current?.click()}>
									<Icon name="file" size={20} />
									<span className={s.two}>{t(locale, 'Choose file')}</span>
								</button>
							</>
						)}
					</div>
				</>
			)}
			<input
				ref={camera}
				hidden
				type="file"
				accept="image/*"
				capture="environment"
				onChange={(e) => void attach(e.currentTarget)}
			/>
			<input
				ref={photo}
				hidden
				type="file"
				accept="image/*"
				multiple
				onChange={(e) => void attach(e.currentTarget)}
			/>
			<input
				ref={file}
				hidden
				type="file"
				multiple
				data-file-input
				onChange={(e) => void attach(e.currentTarget)}
			/>
		</div>
	);
}
