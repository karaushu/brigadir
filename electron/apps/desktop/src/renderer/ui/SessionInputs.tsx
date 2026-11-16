import type { ReactNode } from 'react';
import { Glyph, type GlyphName } from './Glyph';
import { useSecondTick } from './second-tick';
import { TextArea, TextInput } from './Input';
import {
	t,
	ageShort,
	toolHeadline,
	validAnswer,
	type UserQuestion,
	type QuestionAnswer,
	type SessionCommand,
	type Locale,
	type PermissionRequest,
	browserShowCard,
} from '@brigadir/core';
import { Button, Choice, Segments } from './Controls';
import styles from './SessionInputs.module.css';
export function Question({
	question,
	locale,
	disabled,
	answer,
	onChange,
	send,
	since,
	submitShortcut = null,
	touch = false,
	skip = true,
	body,
}: {
	/** spec/chat-turns-plans-and-questions#question-card: the question as Markdown, rendered by the caller (the chat's MarkdownBlock, the phone's card Markdown); plain text without it. */ body?: ReactNode;
	/** «Skip»: a crew question on the phone (spec/crew#attention) has no skip — the worker waits for an answer. */ skip?: boolean;
	/** spec/remote-access-and-mobile#phone-app: the phone's card — 52 rows, 44 buttons that share the footer, no key hint. */ touch?: boolean;
	question: UserQuestion;
	locale: Locale;
	disabled: boolean;
	answer: QuestionAnswer;
	onChange(a: QuestionAnswer): void;
	send(c: SessionCommand): void;
	/** When the agent asked: the card's «waiting 3 min». */ since?: number;
	/** View ▸ Submit as the keymap shows it (spec/chat#tool-calls). */ submitShortcut?:
		string | null;
}) {
	const chosen = answer.labels.length + (answer.text.trim() ? 1 : 0);
	const now = useSecondTick(since !== undefined),
		waited =
			since !== undefined && now - since >= 60_000
				? t(locale, 'waiting {age}').replace('{age}', ageShort(locale, since, now))
				: null;
	return (
		<section
			className={styles.question}
			data-question-id={question.id}
			data-menu-answer={!disabled && validAnswer(question, answer)}
			data-touch={touch || undefined}
			aria-label={t(locale, 'Question')}>
			<header>
				{touch ? <Glyph name="agent-question" size={16} /> : <Glyph name="question" size={14} />}
				<strong>{t(locale, 'Question')}</strong>
				{question.header && <small>{question.header}</small>}
				{waited && <span className={styles.waited}>{waited}</span>}
			</header>
			{body ? <div className={styles.text}>{body}</div> : <h3>{question.question}</h3>}
			<div className={styles.options}>
				{question.options.map((option) => (
					<label
						key={option.label}
						className={styles.questionOption}
						data-selected={answer.labels.includes(option.label)}>
						<Choice
							type={question.allowsMultiple ? 'checkbox' : 'radio'}
							name={question.id}
							label={option.label}
							disabled={disabled}
							checked={answer.labels.includes(option.label)}
							onChange={(event) =>
								onChange({
									...answer,
									labels: question.allowsMultiple
										? event.currentTarget.checked
											? [...answer.labels, option.label]
											: answer.labels.filter((l) => l !== option.label)
										: [option.label],
								})
							}
						/>
						<span>
							<strong>{option.label}</strong>
							{option.description && (
								<span className={styles.description}>{option.description}</span>
							)}
						</span>
					</label>
				))}
				{/* spec/chat-turns-plans-and-questions#question-card: the own answer is the list's last row, a circle (or box) and the field, accent while it holds text. */}
				{question.allowsFreeText && (
					<label
						className={`${styles.questionOption} ${styles.ownAnswer}`}
						data-selected={Boolean(answer.text.trim())}
						data-multiple={question.allowsMultiple}>
						<TextArea
							embedded
							rows={1}
							aria-label={t(locale, 'Answer')}
							placeholder={t(locale, 'Your answer…')}
							value={answer.text}
							disabled={disabled}
							onChange={(e) => onChange({ ...answer, text: e.target.value })}
						/>
						<Choice
							type={question.allowsMultiple ? 'checkbox' : 'radio'}
							label={t(locale, 'Answer')}
							aria-hidden="true"
							tabIndex={-1}
							readOnly
							checked={Boolean(answer.text.trim())}
							onChange={() => {}}
						/>
					</label>
				)}
			</div>
			<footer className={styles.actions} data-size={touch ? 'l' : 'm'}>
				{/* One option: the key that answers; several options: how many are chosen. «Skip» has no key. */}
				{touch ? null : question.allowsMultiple && chosen > 0 ? (
					<small className={styles.footHint}>
						{t(locale, '{n} selected').replace('{n}', new Intl.NumberFormat(locale).format(chosen))}
					</small>
				) : submitShortcut ? (
					<small className={styles.footHint}>
						{t(locale, '{key} to answer').replace('{key}', submitShortcut)}
					</small>
				) : null}
				{skip && (
					<Button
						disabled={disabled}
						onClick={() => send({ kind: 'answerQuestion', id: question.id, answer: null })}>
						{t(locale, 'Skip')}
					</Button>
				)}
				<Button
					appearance="primary"
					disabled={disabled || !validAnswer(question, answer)}
					onClick={() => send({ kind: 'answerQuestion', id: question.id, answer })}>
					{t(locale, 'Submit answer')}
				</Button>
			</footer>
		</section>
	);
}
/** spec/chat-turns-plans-and-questions#model-card: one model of a catalog on the model question card. */
export type ModelRow = { key: string; name: string; note?: string };
/**
 * spec/chat-turns-plans-and-questions#model-card: the Auto agent asks for a model outside its roles. The question card's look (rule 17): the reason,
 * the catalog models grouped by provider, the effort of the chosen model, `Save as role`, and `Keep {role}` / `Use this model`.
 * `groups` null — the catalogs are still loading; empty — no other models.
 */
export function ModelQuestion({
	title,
	part,
	reason,
	groups,
	selected,
	onSelect,
	efforts,
	effort,
	onEffort,
	saveAs,
	onSaveAs,
	keepLabel,
	onKeep,
	onUse,
	onSettings,
	waited = null,
	submitShortcut = null,
	disabled,
	locale,
}: {
	title: string;
	part?: string | undefined;
	reason: string;
	groups: { label: string; rows: ModelRow[] }[] | null;
	selected: string | null;
	onSelect(key: string): void;
	efforts: { value: string; name: string }[] | null;
	effort: string | null;
	onEffort(value: string): void;
	/** null — `Save as role` is off; a string — on, with the role's name. */ saveAs: string | null;
	onSaveAs(value: string | null): void;
	keepLabel: string;
	onKeep(): void;
	onUse(): void;
	onSettings(): void;
	/** `waiting 3 min`, from the caller's clock. */ waited?: string | null;
	submitShortcut?: string | null;
	disabled: boolean;
	locale: Locale;
}) {
	const empty = groups !== null && groups.every((group) => !group.rows.length);
	return (
		<section
			className={styles.question}
			data-model-question
			aria-label={title}
			onKeyDown={(event) => {
				if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && selected && !disabled) {
					event.preventDefault();
					onUse();
				}
			}}>
			<header>
				<Glyph name="question" size={14} />
				<strong>{title}</strong>
				{part && <small>{part}</small>}
				{waited && <span className={styles.waited}>{waited}</span>}
			</header>
			<h3>{reason}</h3>
			{groups === null ? (
				<p className={styles.description}>{t(locale, 'Loading models…')}</p>
			) : empty ? (
				<p className={styles.description}>{t(locale, 'No other models.')}</p>
			) : (
				groups.map((group) =>
					group.rows.length ? (
						<div key={group.label} className={styles.modelGroup}>
							<span className={styles.modelGroupLabel}>{group.label}</span>
							<div className={styles.options} role="radiogroup" aria-label={group.label}>
								{group.rows.map((row) => (
									<label
										key={row.key}
										className={styles.questionOption}
										data-selected={selected === row.key}>
										<Choice
											type="radio"
											name="model"
											label={row.name}
											disabled={disabled}
											checked={selected === row.key}
											onChange={() => onSelect(row.key)}
										/>
										<span>
											<strong>{row.name}</strong>
											{row.note && <span className={styles.description}>{row.note}</span>}
										</span>
									</label>
								))}
							</div>
						</div>
					) : null
				)
			)}
			{!empty && groups !== null && efforts && efforts.length > 0 && (
				<div className={styles.modelRow} data-size="s">
					<span>{t(locale, 'Effort')}</span>
					<Segments
						size="s"
						label={t(locale, 'Effort')}
						value={effort ?? ''}
						disabled={disabled}
						options={efforts.map((level) => ({ value: level.value, label: level.name }))}
						onChange={onEffort}
					/>
				</div>
			)}
			{!empty && groups !== null && (
				<div className={styles.modelRow} data-size="s">
					<label className={styles.saveAs}>
						<Choice
							type="checkbox"
							label={t(locale, 'Save as role')}
							disabled={disabled}
							checked={saveAs !== null}
							onChange={(event) => onSaveAs(event.currentTarget.checked ? '' : null)}
						/>
						<span>{t(locale, 'Save as role')}</span>
					</label>
					{saveAs !== null && (
						<TextInput
							size="s"
							aria-label={t(locale, 'Role name')}
							placeholder={t(locale, 'Role name')}
							maxLength={80}
							value={saveAs}
							disabled={disabled}
							onChange={(event) => onSaveAs(event.target.value)}
						/>
					)}
				</div>
			)}
			<footer className={styles.actions} data-size="m">
				{empty ? (
					<Button className={styles.footStart} disabled={disabled} onClick={onSettings}>
						{t(locale, 'Settings…')}
					</Button>
				) : submitShortcut ? (
					<small className={styles.footHint}>
						{t(locale, '{key} to answer').replace('{key}', submitShortcut)}
					</small>
				) : null}
				<Button disabled={disabled} onClick={onKeep}>
					{keepLabel}
				</Button>
				{!empty && (
					<Button appearance="primary" disabled={disabled || !selected} onClick={onUse}>
						{t(locale, 'Use this model')}
					</Button>
				)}
			</footer>
		</section>
	);
}
/**
 * spec/chat-turns-plans-and-questions#budget-card: a card of the question family — the amber band and frame of `Question`, any body, actions at the
 * foot. The budget question is this card (rule 17).
 */
export function InputCard({
	glyph,
	title,
	hint,
	since,
	label,
	locale,
	actions,
	children,
	...data
}: {
	glyph: GlyphName;
	title: ReactNode;
	hint?: ReactNode;
	/** When it was asked: `waiting 3 min` after a minute. */ since?: number;
	label: string;
	locale: Locale;
	actions: ReactNode;
	children: ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	const now = useSecondTick(since !== undefined),
		waited =
			since !== undefined && now - since >= 60_000
				? t(locale, 'waiting {age}').replace('{age}', ageShort(locale, since, now))
				: null;
	return (
		<section {...data} className={styles.question} aria-label={label}>
			<header>
				<Glyph name={glyph} size={14} />
				<strong>{title}</strong>
				{hint && <small>{hint}</small>}
				{waited && <span className={styles.waited}>{waited}</span>}
			</header>
			{children}
			<footer className={styles.actions} data-size="m">
				{actions}
			</footer>
		</section>
	);
}
export function PermissionCard({
	request,
	locale,
	disabled,
	send,
	touch = false,
	since,
	body,
	onChat,
}: {
	/** spec/chat-turns-plans-and-questions#checklist-tools on the phone: the agent's plan in place of the edit's first lines, read before «Approve plan». */ body?: ReactNode;
	/** spec/task-window-workspace#two-columns: the request over a file in two columns ends with `Open chat`, the way back to the Chat tab. */
	onChat?: () => void;
	request: PermissionRequest;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
	/** spec/remote-access-and-mobile#phone-app: the phone's card — the path and the edit's first lines in the body, the actions one under another. */ touch?: boolean;
	since?: number;
}) {
	const now = useSecondTick(touch && since !== undefined),
		waited =
			touch && since !== undefined && now - since >= 60_000
				? t(locale, 'waiting {age}').replace('{age}', ageShort(locale, since, now))
				: null;
	const preview = touch
		? (request.tool.content ?? []).flatMap((content) =>
				content.kind === 'diff'
					? content.after
							.split('\n')
							.filter((line) => !(content.before ?? '').split('\n').includes(line) && line.trim())
							.slice(0, 4)
					: []
			)
		: [];
	// One line «⚠ Permission: Write  apps/admin/…/flags.ts», the agent's options under it, the first «allow once» primary.
	// The raw input shows only when the title names no target; «Reject» only when the agent gives no reject option of its own.
	// spec/browser-and-simulator#background: the host's own «Needs you» request of `browser_show` reads in the person's language.
	const showPage = request.tool.name === browserShowCard.tool,
		head = showPage
			? { name: t(locale, browserShowCard.title), target: '' }
			: toolHeadline(request.tool),
		optionName = (option: PermissionRequest['options'][number]) =>
			showPage && option.id === 'show'
				? t(locale, 'Show')
				: showPage && option.id === 'decline'
					? t(locale, 'Decline (show the page)')
					: option.name,
		primary =
			request.options.find((option) => option.kind === 'allow_once') ??
			request.options.find((option) => option.kind.startsWith('allow'));
	return (
		<section
			className={`${styles.question} ${styles.permission}`}
			data-permission-id={request.id}
			data-menu-allow-once={
				!disabled && request.options.some((option) => option.kind === 'allow_once')
			}
			data-menu-allow-always={
				!disabled && request.options.some((option) => option.kind === 'allow_always')
			}
			data-menu-deny={!disabled}
			data-touch={touch || undefined}
			aria-label={t(locale, 'Permission')}>
			<h3 className={styles.permissionHead} title={request.tool.title ?? undefined}>
				<Glyph name="agent-permission" size={touch ? 16 : 15} />
				<strong>
					{t(locale, 'Permission')}
					{head.name ? `: ${head.name}` : ''}
				</strong>
				{head.target && !touch && <span>{head.target}</span>}
				{waited && <span className={styles.waited}>{waited}</span>}
			</h3>
			{touch && head.target && <p className={styles.permissionPath}>{head.target}</p>}
			{body}
			{!body && preview.length > 0 && (
				<div className={styles.preview} aria-hidden="true">
					{preview.map((line, index) => (
						<div key={index}>+ {line}</div>
					))}
				</div>
			)}
			{request.tool.input && !head.target && <pre>{request.tool.input}</pre>}
			<div className={styles.actions} data-size={touch ? 'l' : 'm'}>
				{request.options.map((option) => (
					<Button
						key={option.id}
						appearance={
							option === primary
								? 'primary'
								: touch && option.kind.startsWith('reject')
									? 'danger'
									: 'neutral'
						}
						disabled={disabled}
						onClick={() => send({ kind: 'answerPermission', id: request.id, optionId: option.id })}>
						{optionName(option)}
					</Button>
				))}
				{!request.options.some((option) => option.kind.startsWith('reject')) && (
					<Button
						disabled={disabled}
						onClick={() => send({ kind: 'answerPermission', id: request.id, optionId: null })}>
						{t(locale, 'Dismiss')}
					</Button>
				)}
				{onChat && (
					<Button onClick={onChat}>
						<Glyph name="chat" size={12} />
						{t(locale, 'Open chat')}
					</Button>
				)}
			</div>
		</section>
	);
}
