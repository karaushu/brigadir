import { useEffect, useRef, useState } from 'react';
import {
	estimatedTokens,
	formatTokenCount,
	t,
	type Locale,
	type RelayDraft,
	type RelaySelection,
} from '@brigadir/core';
import { Choice, IconButton, Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { GenerateButton } from './ui/GenerateButton';
import styles from './RelayChips.module.css';
export function RelayChips({
	draft,
	selection,
	setSelection,
	locale,
	onPending,
}: {
	draft: RelayDraft;
	selection: RelaySelection;
	setSelection(value: RelaySelection): void;
	locale: Locale;
	onPending(value: boolean): void;
}) {
	const [summary, setSummary] = useState(draft.summary),
		[pending, setPending] = useState(false),
		[failed, setFailed] = useState(false),
		[preview, setPreview] = useState<'summary' | 'diff' | null>(null),
		mounted = useRef(false),
		running = useRef(false);
	async function generate() {
		if (running.current) return;
		running.current = true;
		setPending(true);
		onPending(true);
		setFailed(false);
		try {
			const text = await window.brigadir.summarizeRelay(draft.id);
			if (mounted.current) setSummary(text);
		} catch {
			if (mounted.current) setFailed(true);
		} finally {
			running.current = false;
			if (mounted.current) {
				setPending(false);
				onPending(false);
			}
		}
	}
	// The sheet is opened only by the person's explicit continuation action (spec/tasks#relay).
	useEffect(() => {
		mounted.current = true;
		if (!draft.summary) void generate();
		return () => {
			mounted.current = false;
		};
	}, [draft.id]);
	const diff = draft.diff.stat + (selection.fullPatch ? `\n${draft.diff.patch}` : ''),
		tokens =
			(selection.summary ? estimatedTokens(summary ?? '') : 0) +
			(selection.diff ? estimatedTokens(diff) : 0);
	return (
		<div className={styles.root}>
			<div className={styles.chips} data-size="s">
				{selection.summary && (
					<span className={styles.chip} data-failed={failed} data-open={preview === 'summary'}>
						<Button
							variant="ghost"
							aria-expanded={preview === 'summary'}
							onClick={() => setPreview((value) => (value === 'summary' ? null : 'summary'))}
							title={draft.source.title}>
							<Glyph name="relay-summary" size={12} />
							{t(locale, 'Task summary')}
							<small>
								{pending
									? t(locale, 'Generating summary…')
									: `≈ ${formatTokenCount(estimatedTokens(summary ?? ''))}`}
							</small>
						</Button>
						<IconButton
							label={t(locale, 'Remove summary')}
							onClick={(event) => {
								event.currentTarget
									.closest('form')
									?.querySelector<HTMLElement>('[data-prompt]')
									?.focus();
								setSelection({ ...selection, summary: false });
								void window.brigadir.stopRelaySummary(draft.id).catch(() => {});
								if (preview === 'summary') setPreview(null);
							}}>
							<Glyph name="close" size={10} />
						</IconButton>
					</span>
				)}
				{selection.diff && (
					<span className={styles.chip} data-open={preview === 'diff'}>
						<Button
							variant="ghost"
							aria-expanded={preview === 'diff'}
							onClick={() => setPreview((value) => (value === 'diff' ? null : 'diff'))}
							title={draft.source.title}>
							<Glyph name="relay-diff" size={12} />
							{t(locale, 'Task diff')}
							<small>≈ {formatTokenCount(estimatedTokens(diff))}</small>
						</Button>
						<IconButton
							label={t(locale, 'Remove diff')}
							onClick={(event) => {
								event.currentTarget
									.closest('form')
									?.querySelector<HTMLElement>('[data-prompt]')
									?.focus();
								setSelection({ ...selection, diff: false });
								if (preview === 'diff') setPreview(null);
							}}>
							<Glyph name="close" size={10} />
						</IconButton>
					</span>
				)}
				{selection.diff && (
					<label className={styles.full}>
						<Choice
							type="checkbox"
							label={t(locale, 'Full patch')}
							checked={selection.fullPatch}
							onChange={(event) => setSelection({ ...selection, fullPatch: event.target.checked })}
						/>
						{t(locale, 'Full patch')}
					</label>
				)}
			</div>
			<p className={styles.hint}>
				≈ {formatTokenCount(tokens)} {t(locale, 'tokens')}
			</p>
			{selection.summary && failed && (
				<p className={styles.warning} data-size="s" role="status">
					{t(locale, 'The summary could not be generated. You can start without it.')}{' '}
					<GenerateButton
						label={t(locale, 'Generate again')}
						onClick={() => {
							void generate();
						}}
					/>
				</p>
			)}
			{selection.diff && selection.fullPatch && draft.diff.truncated && (
				<p className={styles.warning}>
					{t(locale, 'The patch was shortened to fit the attachment limit.')}
				</p>
			)}
			<div
				className={styles.preview}
				data-open={preview !== null}
				inert={preview === null}
				aria-hidden={preview === null}>
				<div>
					<pre>
						{preview === 'summary'
							? (summary ??
								t(
									locale,
									pending
										? 'Generating summary…'
										: 'The summary could not be generated. You can start without it.'
								))
							: diff}
					</pre>
				</div>
			</div>
		</div>
	);
}
