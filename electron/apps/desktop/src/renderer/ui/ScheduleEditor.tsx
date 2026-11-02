import { useMemo, useState, type ReactNode } from 'react';
import {
	clockMinutes,
	describeRule,
	formatSlot,
	isClockTime,
	parseCron,
	t,
	upcomingRuns,
	zonedDay,
	zonedInstant,
	zoneOffsetLabel,
	type Locale,
	type MessageKey,
	type ScheduleInTasks,
	type ScheduleMissed,
	type ScheduleRule,
	type Weekday,
} from '@brigadir/core';
import { Button, Popup, Segments, Stepper, Switch } from './Controls';
import { TextInput } from './Input';
import { Glyph } from './Glyph';
import s from './ScheduleEditor.module.css';

/** What the editor changes; the name and the blank belong to the sheet or the schedule screen. */
export type ScheduleTiming = {
	rule: ScheduleRule;
	timeZone: string;
	missed: ScheduleMissed;
	inTasks: ScheduleInTasks;
};
type Kind = 'hourly' | 'interval' | 'daily' | 'weekdays' | 'weekly' | 'cron';
const kinds: { value: Kind; label: MessageKey }[] = [
	{ value: 'hourly', label: 'Every hour' },
	{ value: 'interval', label: 'Every few hours' },
	{ value: 'daily', label: 'Daily' },
	{ value: 'weekdays', label: 'Weekdays' },
	{ value: 'weekly', label: 'Weekly' },
	{ value: 'cron', label: 'Cron' },
];
const allDays: Weekday[] = [1, 2, 3, 4, 5, 6, 7];
const workDays: Weekday[] = [1, 2, 3, 4, 5];
const same = (a: readonly number[], b: readonly number[]) =>
	a.length === b.length && b.every((day) => a.includes(day));
function kindOf(rule: ScheduleRule): Kind | null {
	if (rule.kind === 'once') return null;
	if (rule.kind !== 'weekly') return rule.kind;
	return same(rule.days, allDays) ? 'daily' : same(rule.days, workDays) ? 'weekdays' : 'weekly';
}
const firstTimes = (rule: ScheduleRule) => (rule.kind === 'weekly' ? rule.times : ['09:00']);
/** The default of a kind, keeping the times the person already chose. */
function ruleFor(kind: Kind, from: ScheduleRule, today: Weekday): ScheduleRule {
	switch (kind) {
		case 'hourly':
			return { kind: 'hourly', minute: 0 };
		case 'interval':
			return { kind: 'interval', hours: 2, between: { from: '09:00', to: '19:00' } };
		case 'daily':
			return { kind: 'weekly', days: allDays, times: firstTimes(from) };
		case 'weekdays':
			return { kind: 'weekly', days: workDays, times: firstTimes(from) };
		case 'weekly':
			return {
				kind: 'weekly',
				days: from.kind === 'weekly' && !same(from.days, allDays) ? from.days : [today],
				times: firstTimes(from),
			};
		case 'cron':
			return { kind: 'cron', expr: '0 9 * * 1-5' };
	}
}
const dayLetters: Record<Locale, string[]> = {
	en: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
	uk: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'],
};
const pad = (n: number) => String(n).padStart(2, '0');
function zones(current: string) {
	const list =
		(Intl as typeof Intl & { supportedValuesOf?(key: string): string[] }).supportedValuesOf?.(
			'timeZone'
		) ?? [];
	return list.includes(current) ? list : [current, ...list];
}
const cronProblem: Record<string, MessageKey> = {
	fields: 'Cron needs 5 fields: minute, hour, day, month, weekday.',
	range: 'A cron field is out of range.',
	syntax: 'Use numbers, *, lists, ranges and steps.',
};

/**
 * spec/notifications-slack-notes-and-schedules#schedules: one editor for the sheet's popover and the schedule screen's column —
 * Once | Repeat, the rule's own fields, the time zone, the rule in words with the next three slots, «If missed» and «In
 * Tasks». Rows are M (rule 16). `onChange` reports the timing and whether it can be saved.
 */
export function ScheduleEditor({
	locale,
	value,
	onChange,
	now = Date.now(),
	allowOnce = true,
}: {
	locale: Locale;
	value: ScheduleTiming;
	onChange(value: ScheduleTiming, valid: boolean): void;
	now?: number;
	/** The schedule screen keeps a repeating schedule repeating; the sheet's «Later» is a once. */ allowOnce?: boolean;
}) {
	const { rule, timeZone } = value;
	const [cronDraft, setCronDraft] = useState(rule.kind === 'cron' ? rule.expr : '');
	const kind = kindOf(rule),
		today = useMemo(() => {
			const day = zonedDay(now, timeZone);
			return (((new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay() + 6) % 7) + 1) as Weekday;
		}, [now, timeZone]);
	const cronError = kind === 'cron' ? parseCron(cronDraft) : null;
	const problem: MessageKey | null =
		typeof cronError === 'string'
			? cronProblem[cronError]!
			: rule.kind === 'weekly' && !rule.days.length
				? 'Choose at least one day.'
				: rule.kind === 'once' && Date.parse(rule.at) <= now
					? 'This time has passed.'
					: null;
	const emit = (next: Partial<ScheduleTiming>) => {
		const merged = { ...value, ...next },
			bad =
				(merged.rule.kind === 'weekly' &&
					(!merged.rule.days.length || !merged.rule.times.length)) ||
				(merged.rule.kind === 'once' && Date.parse(merged.rule.at) <= now) ||
				(merged.rule.kind === 'cron' && typeof parseCron(merged.rule.expr) === 'string');
		onChange(merged, !bad);
	};
	const setRule = (next: ScheduleRule) => emit({ rule: next });
	const upcoming = problem ? [] : upcomingRuns(rule, timeZone, now, 3);
	const onceDay = rule.kind === 'once' ? zonedDay(Date.parse(rule.at), timeZone) : null;
	const setOnce = (y: number, m: number, d: number, minute: number) =>
		setRule({ kind: 'once', at: new Date(zonedInstant(y, m, d, minute, timeZone)).toISOString() });
	const quick = (key: 'in30' | 'in1' | 'in3' | 'tonight' | 'tomorrow') => {
		if (key.startsWith('in')) {
			const minutes = key === 'in30' ? 30 : key === 'in1' ? 60 : 180;
			setRule({
				kind: 'once',
				at: new Date(Math.ceil((now + minutes * 60_000) / 60_000) * 60_000).toISOString(),
			});
			return;
		}
		const day = zonedDay(now, timeZone);
		if (key === 'tonight') setOnce(day.y, day.m, day.d, 22 * 60);
		else {
			const next = new Date(Date.UTC(day.y, day.m - 1, day.d + 1));
			setOnce(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 9 * 60);
		}
	};
	const row = (label: MessageKey, control: ReactNode, id?: string) => (
		<div className={s.row} data-size="m" key={label}>
			<span className={s.label} id={id}>
				{t(locale, label)}
			</span>
			<div className={s.control}>{control}</div>
		</div>
	);
	const time = (label: string, value: string, onTime: (next: string) => void) => (
		<TextInput
			className={s.time}
			type="time"
			aria-label={label}
			value={value}
			onChange={(event) => {
				if (isClockTime(event.currentTarget.value)) onTime(event.currentTarget.value);
			}}
		/>
	);
	return (
		<div className={s.editor} data-schedule-editor>
			{allowOnce && (
				<Segments
					size="m"
					stretch
					label={t(locale, 'Schedule')}
					options={[
						{ value: 'once', label: t(locale, 'Once') },
						{ value: 'repeat', label: t(locale, 'Repeat (schedule)') },
					]}
					value={rule.kind === 'once' ? 'once' : 'repeat'}
					onChange={(mode) => {
						if (mode === 'once' && rule.kind !== 'once')
							setRule({
								kind: 'once',
								at: new Date(Math.ceil((now + 3_600_000) / 60_000) * 60_000).toISOString(),
							});
						if (mode === 'repeat' && rule.kind === 'once')
							setRule(ruleFor('weekdays', rule, today));
					}}
				/>
			)}
			{rule.kind === 'once' && onceDay ? (
				<>
					{row(
						'Quick',
						<div className={s.chips}>
							{(
								[
									['in30', 'In 30 min'],
									['in1', 'In 1 h'],
									['in3', 'In 3 h'],
									['tonight', 'Tonight 22:00'],
									['tomorrow', 'Tomorrow 09:00'],
								] as const
							).map(([key, label]) => (
								<Button key={key} size="s" onClick={() => quick(key)}>
									{t(locale, label)}
								</Button>
							))}
						</div>
					)}
					{row(
						'Date',
						<TextInput
							className={s.wide}
							type="date"
							aria-label={t(locale, 'Date')}
							value={`${onceDay.y}-${pad(onceDay.m)}-${pad(onceDay.d)}`}
							onChange={(event) => {
								const [y, m, d] = event.currentTarget.value.split('-').map(Number);
								if (y && m && d) setOnce(y, m, d, onceDay.minute);
							}}
						/>
					)}
					{row(
						'Time',
						time(
							t(locale, 'Time'),
							`${pad(Math.floor(onceDay.minute / 60))}:${pad(onceDay.minute % 60)}`,
							(next) => setOnce(onceDay.y, onceDay.m, onceDay.d, clockMinutes(next))
						)
					)}
				</>
			) : (
				<>
					{row(
						'Repeat (field)',
						<Popup
							label={t(locale, 'Repeat (field)')}
							options={kinds.map((item) => ({ value: item.value, label: t(locale, item.label) }))}
							value={kind ?? 'weekdays'}
							onChange={(next) => {
								const nextRule = ruleFor(next as Kind, rule, today);
								if (nextRule.kind === 'cron') setCronDraft(nextRule.expr);
								setRule(nextRule);
							}}
						/>
					)}
					{rule.kind === 'weekly' && (
						<>
							{row(
								'Days',
								<div className={s.days} role="group" aria-label={t(locale, 'Days')}>
									{allDays.map((day, index) => (
										<Button
											key={day}
											size="m"
											className={s.day}
											aria-pressed={rule.days.includes(day)}
											title={new Intl.DateTimeFormat(locale, {
												weekday: 'long',
												timeZone: 'UTC',
											}).format(Date.UTC(2026, 10, 1 + day))}
											onClick={() =>
												setRule({
													...rule,
													days: rule.days.includes(day)
														? rule.days.filter((item) => item !== day)
														: [...rule.days, day].sort((a, b) => a - b),
												})
											}>
											{dayLetters[locale][index]}
										</Button>
									))}
								</div>
							)}
							{row(
								'At',
								<div className={s.times}>
									{rule.times.map((at, index) => (
										<span key={index} className={s.timeItem}>
											{time(t(locale, 'At'), at, (next) =>
												setRule({
													...rule,
													times: [
														...new Set(rule.times.map((item, i) => (i === index ? next : item))),
													],
												})
											)}
											{rule.times.length > 1 && (
												<Button
													size="m"
													variant="ghost"
													aria-label={t(locale, 'Remove the time')}
													onClick={() =>
														setRule({ ...rule, times: rule.times.filter((_, i) => i !== index) })
													}>
													<Glyph name="close" size={12} />
												</Button>
											)}
										</span>
									))}
									{rule.times.length < 12 && (
										<Button
											size="m"
											variant="ghost"
											onClick={() => {
												const last = clockMinutes(rule.times[rule.times.length - 1] ?? '09:00'),
													next = Math.min(last + 6 * 60, 23 * 60 + 59);
												const at = `${pad(Math.floor(next / 60))}:${pad(next % 60)}`;
												if (!rule.times.includes(at))
													setRule({ ...rule, times: [...rule.times, at] });
											}}>
											{t(locale, 'Add time')}
										</Button>
									)}
								</div>
							)}
						</>
					)}
					{rule.kind === 'interval' && (
						<>
							{row(
								'Every',
								<Stepper
									size="m"
									label={t(locale, 'Every')}
									value={rule.hours}
									min={1}
									max={12}
									onChange={(hours) => setRule({ ...rule, hours })}
									increaseLabel="+1"
									decreaseLabel="−1"
								/>
							)}
							{row(
								'Between',
								<div className={s.times}>
									{time(t(locale, 'Between'), rule.between?.from ?? '09:00', (from) =>
										setRule({ ...rule, between: { from, to: rule.between?.to ?? '19:00' } })
									)}
									<span className={s.dash}>–</span>
									{time(t(locale, 'Between'), rule.between?.to ?? '19:00', (to) =>
										setRule({ ...rule, between: { from: rule.between?.from ?? '09:00', to } })
									)}
									<Switch
										label={t(locale, 'Between')}
										checked={!!rule.between}
										onChange={(on: boolean) => {
											const { between: _drop, ...rest } = rule;
											setRule(on ? { ...rest, between: { from: '09:00', to: '19:00' } } : rest);
										}}
									/>
								</div>
							)}
						</>
					)}
					{rule.kind === 'hourly' &&
						row(
							'At minute',
							<Stepper
								size="m"
								label={t(locale, 'At minute')}
								value={rule.minute}
								min={0}
								max={59}
								onChange={(minute) => setRule({ kind: 'hourly', minute })}
								increaseLabel="+1"
								decreaseLabel="−1"
							/>
						)}
					{rule.kind === 'cron' && (
						<>
							{row(
								'Cron',
								<TextInput
									className={s.wide}
									spellCheck={false}
									aria-label="Cron"
									aria-invalid={typeof cronError === 'string'}
									data-mono
									value={cronDraft}
									onChange={(event) => {
										const expr = event.currentTarget.value;
										setCronDraft(expr);
										if (typeof parseCron(expr) !== 'string') setRule({ kind: 'cron', expr });
										else onChange(value, false);
									}}
								/>
							)}
							<p
								className={typeof cronError === 'string' ? s.error : s.hint}
								role={typeof cronError === 'string' ? 'alert' : undefined}>
								{t(
									locale,
									typeof cronError === 'string'
										? cronProblem[cronError]!
										: 'minute · hour · day · month · weekday'
								)}
							</p>
						</>
					)}
				</>
			)}
			{problem && problem !== cronProblem[cronError as string] && (
				<p className={s.error} role="alert">
					{t(locale, problem)}
				</p>
			)}
			{row(
				'Time zone',
				<Popup
					label={t(locale, 'Time zone')}
					options={zones(timeZone).map((zone) => ({
						value: zone,
						label: zone,
						tail: zoneOffsetLabel(zone, now),
					}))}
					value={timeZone}
					displayValue={
						<span className={s.zone}>
							{timeZone}
							<small>{zoneOffsetLabel(timeZone, now)}</small>
						</span>
					}
					search={{
						placeholder: t(locale, 'Search time zones'),
						empty: t(locale, 'No time zones match'),
						clear: t(locale, 'Clear the field'),
					}}
					onChange={(zone) => emit({ timeZone: zone })}
				/>
			)}
			<div className={s.summary} data-bad={problem ? true : undefined} aria-live="polite">
				<b>
					<Glyph
						name={problem ? 'toast-error' : rule.kind === 'once' ? 'clock' : 'schedule'}
						size={13}
					/>
					{problem ? t(locale, 'No runs (schedule)') : describeRule(locale, rule, timeZone)}
				</b>
				{upcoming.length > 0 && (
					<small>
						{t(locale, 'Next: {list}').replace(
							'{list}',
							upcoming.map((at) => formatSlot(locale, at, timeZone)).join(' · ')
						)}
					</small>
				)}
			</div>
			<hr className={s.separator} />
			{row(
				'If missed',
				<Segments
					size="m"
					stretch
					label={t(locale, 'If missed')}
					options={[
						{
							value: 'catch-up',
							label: t(locale, 'Catch up'),
							hint: t(locale, 'Catches up once on wake or start, if the slot was within 24 h.'),
						},
						{
							value: 'skip',
							label: t(locale, 'Skip'),
							hint: t(locale, 'Only writes «Skipped» to the history.'),
						},
						{
							value: 'ask',
							label: t(locale, 'Ask (missed)'),
							hint: t(locale, 'Asks in Notifications: run once or skip.'),
						},
					]}
					value={value.missed}
					onChange={(missed) => emit({ missed: missed as ScheduleMissed })}
				/>
			)}
			{rule.kind !== 'once' &&
				row(
					'In Tasks',
					<Segments
						size="m"
						stretch
						label={t(locale, 'In Tasks')}
						options={[
							{ value: 'needs-you', label: t(locale, 'When they need you') },
							{ value: 'always', label: t(locale, 'Always') },
						]}
						value={value.inTasks}
						onChange={(inTasks) => emit({ inTasks: inTasks as ScheduleInTasks })}
					/>
				)}
		</div>
	);
}
