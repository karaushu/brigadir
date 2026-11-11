import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import {
	actionChoice,
	agentProviders,
	crewLabel,
	modelDisplayName,
	noteLineCount,
	selectOption,
	t,
	type CrewLibrary,
	type HelperRun,
	type Locale,
	type ProjectReviewNotes,
} from '@brigadir/core';
import {
	saveActionAgent,
	saveActionCrew,
	useHelperSettings,
	useProviderCatalogs,
} from './HelperAgent';
import { PromptEditor, type PromptEditorHandle } from './PromptEditor';
import { useWorkspace } from './store';
import { Button, Popup, Segments } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { TextArea } from './ui/Input';
import { Spinner } from './ui/Loading';
import { ModalDialog } from './ui/ModalDialog';
import { RememberCheck } from './ui/RememberCheck';
import styles from './ReviewLaunch.module.css';

/** spec/pull-requests-and-ci#review-launch: what the person chose for one review. */
export type ReviewChoice = {
	where: 'quick' | 'worktree';
	/** The agent of this review; null — the action's own agent, else the Default agent. */
	agent: HelperRun | null;
	/** A library crew instead of one agent; excludes `agent`. */
	crew: string | null;
	/** The person's instructions as typed; empty — none. */
	notes: string;
};
/** spec/pull-requests-and-ci#review-launch: who opens the dialog and what starts the review; `start` answers whether the task started. */
export type ReviewLaunchRequest = {
	projectId: string;
	scopeId: string;
	number: number;
	title: string;
	/** spec/appearance#evolution-redesign: from the review modal it is «agent suggestions in review», its own row of Customize per action. */
	action: 'review' | 'reviewSuggestions';
	start(choice: ReviewChoice): Promise<boolean>;
};

type LaunchStore = {
	launch: ReviewLaunchRequest | null;
	/** spec/pull-requests-and-ci#review-notes: the project whose notes are edited; `over` — opened from the launch dialog, which stays under it. */
	notes: { projectId: string } | null;
	openLaunch(request: ReviewLaunchRequest): void;
	closeLaunch(): void;
	openNotes(projectId: string): void;
	closeNotes(): void;
};
export const useReviewLaunch = create<LaunchStore>((set) => ({
	launch: null,
	notes: null,
	openLaunch: (launch) => set({ launch }),
	closeLaunch: () => set({ launch: null }),
	openNotes: (projectId) => set({ notes: { projectId } }),
	closeNotes: () => set({ notes: null }),
}));
export const openReviewLaunch = (request: ReviewLaunchRequest) =>
	useReviewLaunch.getState().openLaunch(request);
export const openReviewNotes = (projectId: string) =>
	useReviewLaunch.getState().openNotes(projectId);

/** spec/pull-requests-and-ci#review-launch: the instructions of a PR wait here until its review starts or the window reloads. */
const drafts = new Map<string, string>();
const draftKey = (request: Pick<ReviewLaunchRequest, 'projectId' | 'scopeId' | 'number'>) =>
	`${request.projectId}·${request.scopeId}·${request.number}`;

/** The dialogs of the window: the review launch and the project's review notes, one of each at a time. */
export function ReviewLaunchHost({ locale }: { locale: Locale }) {
	const launch = useReviewLaunch((state) => state.launch),
		notes = useReviewLaunch((state) => state.notes);
	return (
		<>
			{launch && (
				<ReviewLaunchDialog
					key={draftKey(launch)}
					request={launch}
					locale={locale}
					close={() => useReviewLaunch.getState().closeLaunch()}
				/>
			)}
			{notes && (
				<ReviewNotesDialog
					key={notes.projectId}
					projectId={notes.projectId}
					locale={locale}
					close={() => useReviewLaunch.getState().closeNotes()}
				/>
			)}
		</>
	);
}

function ReviewLaunchDialog({
	request,
	locale,
	close,
}: {
	request: ReviewLaunchRequest;
	locale: Locale;
	close(): void;
}) {
	const key = draftKey(request);
	const [text, setText] = useState(() => drafts.get(key) ?? ''),
		[where, setWhere] = useState<'quick' | 'worktree'>(
			() => useWorkspace.getState().appearance.reviewWhere ?? 'quick'
		),
		[busy, setBusy] = useState(false),
		[failed, setFailed] = useState(false);
	const editor = useRef<PromptEditorHandle>(null),
		form = useRef<HTMLFormElement>(null);
	const project = useWorkspace((state) =>
		state.workspace?.projects.find((item) => item.id === request.projectId)
	);
	const settings = useHelperSettings(),
		catalogs = useProviderCatalogs(settings?.enabled ?? null),
		[library, setLibrary] = useState<CrewLibrary | null>(null),
		[agent, setAgent] = useState<HelperRun | null>(null),
		[crew, setCrew] = useState<string | null>(null),
		[segment, setSegment] = useState<'agent' | 'crew' | null>(null),
		[remember, setRemember] = useState(false);
	useEffect(() => {
		let live = true;
		void window.brigadir.readTemplates().then(
			(value) => live && setLibrary(value),
			() => live && setLibrary({ agents: [], crews: [], issues: [], hiddenCrews: [] })
		);
		return () => {
			live = false;
		};
	}, []);
	useEffect(() => {
		// The focus lands in the field once its editor exists (ModalDialog focuses itself first).
		const frame = requestAnimationFrame(() => editor.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, []);
	const write = (value: string) => {
		setText(value);
		if (value) drafts.set(key, value);
		else drafts.delete(key);
	};
	const agents = settings
		? agentProviders
				.filter((provider) => settings.enabled[provider])
				.flatMap((provider) => {
					const catalog = catalogs[provider],
						model = catalog ? selectOption(catalog.options, 'model') : undefined;
					return (model?.choices ?? [])
						.filter((choice) => choice.value !== 'default')
						.map((choice) => ({
							provider,
							model: choice.value,
							name: modelDisplayName(choice.name, provider),
							default: provider === settings.defaultProvider && choice.value === model!.value,
						}));
				})
		: [];
	// The one-time choice, else the action's own agent or crew of Settings; none — the Default agent (spec/pull-requests-and-ci#review-crew).
	const own = settings
			? actionChoice(request.action, null, settings.actionAgents, settings.enabled, catalogs).run
			: null,
		ownCrew = settings?.actionCrews[request.action] ?? null,
		chosenCrew = crew ?? (agent ? null : (ownCrew?.templateId ?? null)),
		chosen = chosenCrew ? null : (agent ?? own),
		shown = segment ?? (chosenCrew ? 'crew' : 'agent'),
		fallback = agents.find((item) => item.default),
		isDefault = (pick: HelperRun | null) =>
			!pick || (pick.provider === fallback?.provider && pick.model === fallback.model);
	const crews = library?.crews ?? [];
	const rememberPick = (pick: HelperRun | null) => {
		if (isDefault(pick) && ownCrew) void saveActionCrew(request.action, null).catch(() => {});
		void saveActionAgent(
			request.action,
			isDefault(pick)
				? null
				: {
						provider: pick!.provider,
						model: pick!.model,
						name:
							agents.find((item) => item.provider === pick!.provider && item.model === pick!.model)
								?.name ?? null,
						effort: pick!.effort,
					}
		).catch(() => {});
	};
	const rememberCrew = (id: string) => {
		const template = crews.find((item) => item.id === id);
		if (template)
			void saveActionCrew(request.action, { templateId: template.id, name: template.name }).catch(
				() => {}
			);
	};
	const chooseAgent = (value: string) => {
		const item = agents.find((entry) => `${entry.provider}:${entry.model}` === value) ?? null,
			pick = item ? { provider: item.provider, model: item.model, effort: null } : null;
		setCrew(null);
		// Over a remembered agent or crew the Default agent for one review is named explicitly, else the setting would win.
		setAgent(pick && isDefault(pick) && !(own || ownCrew) ? null : (pick ?? null));
		if (remember) rememberPick(pick);
	};
	const chooseCrew = (id: string) => {
		setAgent(null);
		setCrew(id);
		if (remember) rememberCrew(id);
	};
	const agentValue = chosen
		? `${chosen.provider}:${chosen.model}`
		: fallback
			? `${fallback.provider}:${fallback.model}`
			: '';
	const crewValue = chosenCrew ?? crews[0]?.id ?? '';
	async function start() {
		if (busy) return;
		setBusy(true);
		setFailed(false);
		// A crew picked by switching the segment without opening the list is the first one.
		const pickedCrew = shown === 'crew' ? (crew ?? (chosenCrew ? null : crewValue || null)) : null;
		const ok = await request
			.start({
				where,
				agent: shown === 'crew' ? null : agent,
				crew: pickedCrew,
				notes: text,
			})
			.catch(() => false);
		setBusy(false);
		if (!ok) {
			setFailed(true);
			return;
		}
		drafts.delete(key);
		close();
	}
	const notes = project?.reviewNotes;
	const caption =
		where === 'quick'
			? t(locale, 'In the main tree, the branch stays')
			: t(locale, 'Branch {branch}, dependencies can be installed and run').replace(
					'{branch}',
					`pr-${request.number}-review`
				);
	return (
		<ModalDialog
			title={t(locale, 'Review with an agent')}
			note={`#${request.number} · ${request.title}`}
			locale={locale}
			width={520}
			close={close}
			data-review-launch
			onKeyDown={(event) => {
				if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
					event.preventDefault();
					void start();
				}
			}}
			footer={
				<>
					<Button onClick={close}>{t(locale, 'Cancel')}</Button>
					<Button
						appearance="primary"
						disabled={busy}
						aria-busy={busy}
						title="⌘↩"
						onClick={() => void start()}>
						{busy && <Spinner />}
						{t(locale, busy ? 'Starting…' : failed ? 'Retry' : 'Start review')}
					</Button>
				</>
			}>
			<form
				ref={form}
				className={styles.form}
				onSubmit={(event) => {
					event.preventDefault();
					void start();
				}}>
				<PromptEditor
					ref={editor}
					value={text}
					onChange={write}
					locale={locale}
					ariaLabel={t(locale, 'Notes for the reviewer')}
					placeholder={t(
						locale,
						shown === 'crew'
							? 'What should the reviewers look at? (optional)'
							: 'What should the reviewer look at? (optional)'
					)}
					crew={[]}
					searchFiles={(query) => window.brigadir.searchProjectFiles(request.projectId, query)}
					onSubmit={() => void start()}
					disabled={busy}
				/>
				<p className={styles.hint}>
					<span aria-hidden="true">@</span>
					{t(locale, 'file or folder')}
				</p>
				{notes && (
					<div className={styles.project} data-size="s" data-review-notes-row>
						<Glyph name={notes.source === 'file' ? 'file' : 'list-bullets'} size={12} />
						<span>
							<b>{t(locale, 'Project review notes')}</b> ·{' '}
							{notes.source === 'file'
								? 'REVIEW.md'
								: noteLineCount(
										locale,
										notes.text.split('\n').filter((line) => line.trim()).length
									)}
						</span>
						<Button
							variant="ghost"
							onClick={() => useReviewLaunch.getState().openNotes(request.projectId)}>
							{t(locale, 'Edit…')}
						</Button>
					</div>
				)}
				<div className={styles.grid} data-size="s">
					<span className={styles.label}>{t(locale, 'Where the agent works')}</span>
					<Segments
						label={t(locale, 'Where the agent reviews')}
						value={where}
						disabled={busy}
						onChange={(value) => setWhere(value as 'quick' | 'worktree')}
						options={[
							{ value: 'quick', label: t(locale, 'Quickly') },
							{ value: 'worktree', label: t(locale, 'In a worktree') },
						]}
					/>
					<span className={styles.caption}>{caption}</span>
					<span className={styles.label}>{t(locale, 'Who reviews')}</span>
					<div className={styles.who}>
						<Segments
							label={t(locale, 'Agent · Crew')}
							value={shown}
							disabled={busy}
							onChange={(value) => setSegment(value as 'agent' | 'crew')}
							options={[
								{ value: 'agent', label: t(locale, 'Agent') },
								{ value: 'crew', label: t(locale, 'Crew') },
							]}
						/>
						{shown === 'agent' ? (
							<Popup
								label={t(locale, 'Agent')}
								value={agentValue}
								disabled={busy || !agents.length}
								icon={
									<Glyph
										name={
											(chosen?.provider ?? fallback?.provider) === 'codex' ? 'openai' : 'claude'
										}
										size={12}
									/>
								}
								onChange={chooseAgent}
								options={agents.map((item) => ({
									value: `${item.provider}:${item.model}`,
									label: item.name,
									icon: <Glyph name={item.provider === 'codex' ? 'openai' : 'claude'} size={12} />,
									...(item.default ? { tail: t(locale, 'Default agent') } : {}),
								}))}
							/>
						) : (
							<Popup
								label={t(locale, 'Crew')}
								value={crewValue}
								disabled={busy || !crews.length}
								displayValue={crews.length ? undefined : t(locale, 'No crews')}
								icon={<Glyph name="helmet" size={12} />}
								onChange={chooseCrew}
								options={crews.map((item) => ({
									value: item.id,
									label: `${crewLabel(locale, item.name)} · ${(item.root.agents ?? [])
										.map((member) => crewLabel(locale, member.name))
										.join(' · ')}`,
									icon: <Glyph name="helmet" size={12} />,
								}))}
							/>
						)}
					</div>
					{shown === 'crew' && (
						<span className={styles.caption}>
							{t(locale, 'The foreman passes your notes to each reviewer')}
						</span>
					)}
				</div>
				<div className={styles.remember}>
					<RememberCheck
						label={t(
							locale,
							request.action === 'review'
								? 'Remember for reviews with an agent'
								: 'Remember for agent suggestions in review'
						)}
						checked={remember}
						onChange={(checked) => {
							setRemember(checked);
							if (!checked) return;
							if (shown === 'crew' && (crew ?? crewValue)) rememberCrew(crew ?? crewValue);
							else if (agent) rememberPick(agent);
						}}
					/>
				</div>
				{failed && (
					<p className={styles.error} role="alert">
						{t(locale, 'Could not start the review task.')}
					</p>
				)}
			</form>
		</ModalDialog>
	);
}

/** spec/pull-requests-and-ci#review-notes: the project's review notes — its own text, or REVIEW.md in the repo. */
function ReviewNotesDialog({
	projectId,
	locale,
	close,
}: {
	projectId: string;
	locale: Locale;
	close(): void;
}) {
	const project = useWorkspace((state) =>
		state.workspace?.projects.find((item) => item.id === projectId)
	);
	const saved = project?.reviewNotes;
	const [source, setSource] = useState<'text' | 'file'>(saved?.source ?? 'text'),
		[text, setText] = useState(saved?.source === 'text' ? saved.text : ''),
		[busy, setBusy] = useState(false),
		[failed, setFailed] = useState(false);
	const field = useRef<HTMLTextAreaElement>(null);
	async function save() {
		setBusy(true);
		setFailed(false);
		const notes: ProjectReviewNotes | null =
			source === 'file' ? { source: 'file' } : text.trim() ? { source: 'text', text } : null;
		try {
			await window.brigadir.setProjectReviewNotes(projectId, notes);
			await useWorkspace.getState().load();
			close();
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
		}
	}
	return (
		<ModalDialog
			title={t(locale, 'Review notes')}
			note={project?.name}
			locale={locale}
			width={520}
			close={close}
			initialFocus={field}
			data-review-notes
			onKeyDown={(event) => {
				if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
					event.preventDefault();
					void save();
				}
			}}
			footer={
				<>
					<Button onClick={close}>{t(locale, 'Cancel')}</Button>
					<Button appearance="primary" disabled={busy} onClick={() => void save()}>
						{t(locale, 'Save')}
					</Button>
				</>
			}>
			<p className={styles.note}>
				{t(locale, 'Every review with an agent in this project gets these notes.')}
			</p>
			<div data-size="s" className={styles.source}>
				<Segments
					label={t(locale, 'Review notes')}
					value={source}
					onChange={(value) => setSource(value as 'text' | 'file')}
					options={[
						{ value: 'text', label: t(locale, 'In the project') },
						{ value: 'file', label: t(locale, 'REVIEW.md in the repo') },
					]}
				/>
			</div>
			{source === 'text' ? (
				<TextArea
					ref={field}
					className={styles.notes}
					aria-label={t(locale, 'Review notes text')}
					value={text}
					maxLength={16000}
					onChange={(event) => setText(event.currentTarget.value)}
				/>
			) : (
				<>
					<div className={styles.file}>
						<Glyph name="file" size={12} />
						<span>REVIEW.md</span>
					</div>
					<p className={styles.note}>{t(locale, 'The agent reads it at the PR base.')}</p>
				</>
			)}
			{failed && (
				<p className={styles.error} role="alert">
					{t(locale, 'Could not save the review notes.')}
				</p>
			)}
		</ModalDialog>
	);
}
