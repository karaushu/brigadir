import { shortcutHint } from './ui/shortcut-hint';
import { promptDisplayText } from '@brigadir/core';
import { RelayChips } from './RelayChips';
import { QuotaButton } from './Quota';
import type {
	RelayDraft,
	RelaySelection,
	CrewLibrary,
	CrewTemplate,
	CrewSpec,
	ScopeChoice,
} from '@brigadir/core';
import {
	resolveCrew,
	templateLookup,
	defaultCrewTemplateId,
	composeCrewId,
	foremanTemplateId,
} from '@brigadir/core';
import { CrewRoster, crewLabel, crewTemplateTail, crewModel } from './Crew';
import { CrewEditor } from './CrewEditor';
import {
	agentOptionKind,
	catalogOptions,
	orderAgentOptions,
	selectOption,
	soloRoleChecks,
	soloRoleTemplates,
	specAgents,
	type AgentOption,
	type ProviderCatalog,
} from '@brigadir/core';
import { TextInput } from './ui/Input';
import { PromptEditor, type PromptEditorHandle } from './PromptEditor';
import { useSlashCatalog } from './use-slash-catalog';
import { slashEntries } from '@brigadir/core';
import type { MentionOption } from './prompt-mentions';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
	suggestedBranch,
	validBranch,
	t,
	attachmentTotalLimit,
	type TaskLaunch,
	type AgentTask,
	type Locale,
	type AttachmentOwner,
	type PromptAttachment,
	type TaskSheet,
	type TaskProposal,
} from '@brigadir/core';
import { Button, Chip, IconButton, Popup, PopupMarks, Segments, Switch } from './ui/Controls';
import { PopupClose } from './ui/PopupClose';
import { SheetBranches, type SheetSwitches } from './SheetBranches';
import { commitFirst } from './BranchPicker';
import { Glyph } from './ui/Glyph';
import { OptionIcon, optionChoices } from './ui/OptionIcon';
import { Popover } from './ui/Popover';
import { ScheduleEditor, type ScheduleTiming } from './ui/ScheduleEditor';
import { describeRule, type Schedule } from '@brigadir/core';
import { useWorkspace } from './store';
import styles from './NewTask.module.css';
import { SkeletonText, Spinner } from './ui/Loading';

/** spec/notifications-slack-notes-and-schedules#schedules: the sheet's «When» — now, once later, or on repeat; a schedule is made in the zone of this computer. */
type When = 'now' | 'later' | 'repeat';
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function initialTiming(when: When, now = Date.now()): ScheduleTiming {
	return {
		rule:
			when === 'later'
				? {
						kind: 'once',
						at: new Date(Math.ceil((now + 3_600_000) / 60_000) * 60_000).toISOString(),
					}
				: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] },
		timeZone: localZone(),
		missed: 'catch-up',
		inTasks: 'needs-you',
	};
}

/** spec/tasks#sheet-rail: a git ref in a list is mono 11.5, as in the field. */
const refStyle = { fontFamily: 'var(--mono-family)', fontSize: 'var(--text-11-5)' };
export function NewTask({
	projectId,
	projectName,
	locale,
	close,
	created,
	backlog: initialBacklog = false,
	editing,
	relaySource,
	duplicateSource,
	proposal,
	note,
	when: initialWhen = 'now',
	scheduled,
}: {
	/** spec/notifications-slack-notes-and-schedules#schedules: `New schedule…` and a task's `Repeat…` open the sheet on Repeat. */ when?: When;
	/** The sheet made a schedule instead of a task. */ scheduled?(schedule: Schedule): void;
	projectId: string;
	projectName: string;
	locale: Locale;
	backlog?: boolean;
	editing?: AgentTask;
	relaySource?: AgentTask;
	duplicateSource?: AgentTask;
	/** spec/tasks#agent-created-tasks: `Відкрити в аркуші…` on a proposed task's card. */ proposal?: {
		source: AgentTask;
		proposal: TaskProposal;
	};
	/** spec/notifications-slack-notes-and-schedules#notes: a task from a note — the text and title from it, the whole note as context, its banner. */ note?: {
		id: string;
		title: string;
		prompt: string;
		name: string;
		range: string | null;
	};
	close(): void;
	created(task: AgentTask): Promise<void>;
}) {
	const [relay, setRelay] = useState<RelayDraft | null>(null),
		[selection, setSelection] = useState<RelaySelection>({
			summary: true,
			diff: true,
			fullPatch: false,
		}),
		[summaryPending, setSummaryPending] = useState(false);
	const relayId = useRef<string | null>(null),
		loadRevision = useRef(0);
	const [transport, setTransport] = useState<'gui' | 'terminal'>('gui');
	const [text, setText] = useState(
		editing?.prompt ?? duplicateSource?.prompt ?? duplicateSource?.title ?? note?.prompt ?? ''
	);
	const [backlog, setBacklog] = useState(initialBacklog || !!editing);
	const schedulesModule = useWorkspace((state) => state.appearance.modules.schedules);
	const [when, setWhen] = useState<When>(initialWhen),
		[timing, setTiming] = useState<ScheduleTiming>(() => {
			const proposed = proposal?.proposal.schedule;
			return proposed
				? {
						rule: proposed.rule,
						timeZone: proposed.timeZone,
						missed: proposed.missed,
						inTasks: 'needs-you',
					}
				: initialTiming(initialWhen === 'now' ? 'repeat' : initialWhen);
		}),
		[timingValid, setTimingValid] = useState(true),
		[timingOpen, setTimingOpen] = useState(false);
	const whenField = useRef<HTMLButtonElement>(null);
	const scheduling = when !== 'now';
	const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
	// spec/settings-modules-and-onboarding#settings-keys: a provider turned off in Settings ▸ Agents is not offered for a new task; an edited or continued task keeps its own.
	const [enabledProviders, setEnabledProviders] = useState<Record<'claude' | 'codex', boolean>>({
		claude: true,
		codex: true,
	});
	// spec/tasks#sheet-rail: the type decides the second row; Brigadir shows the crew by name and defaults to worktree isolation (spec/crew#task-type).
	const [taskType, setTaskType] = useState<'agent' | 'brigadir'>(
		editing?.crew || duplicateSource?.crew ? 'brigadir' : 'agent'
	);
	const [library, setLibrary] = useState<CrewLibrary | null>(null),
		[crewTemplateId, setCrewTemplateId] = useState<string>(
			editing?.crew?.templateId ?? duplicateSource?.crew?.templateId ?? composeCrewId
		);
	// spec/tasks#sheet-role: the template a solo agent works as; an edited or duplicated task opens with its own.
	const [roleId, setRoleId] = useState<string | null>(
		editing?.agentRole?.templateId ?? duplicateSource?.agentRole?.templateId ?? null
	);
	// spec/tasks#sheet-rail «Налаштувати…»: edits go to the task, not the library, until «Зберегти як шаблон».
	const [oneOff, setOneOff] = useState<CrewTemplate | null>(null),
		[editorOpen, setEditorOpen] = useState(false),
		[catalogs, setCatalogs] = useState<Record<string, ProviderCatalog | null>>({});
	// spec/tasks#sheet-model: an optional manual title beats the auto one, and the model choice starts the session.
	// spec/tasks#backlog-edit: a title the person typed comes back into the field; one made from the text (or «New task») does not.
	const manualTitle = (task: AgentTask) => {
		const text = task.prompt ?? '';
		return task.title !== text &&
			task.title !== text.trim().slice(0, 80) &&
			task.title !== promptDisplayText(text).trim().slice(0, 80) &&
			task.title !== t(locale, 'New task')
			? task.title
			: '';
	};
	const [name, setName] = useState(
		editing
			? manualTitle(editing)
			: duplicateSource
				? manualTitle(duplicateSource)
				: (note?.name ?? '')
	);
	// spec/agents-and-providers#catalog: a pick is kept with the provider (and every other option with the model) it was made for, so a switch falls back to the catalog without an effect.
	const [modelPick, setModelPick] = useState<{ provider: string; value: string } | null>(null),
		[picks, setPicks] = useState<
			Record<string, { provider: string; model: string; value: string }>
		>({});
	const [refs, setRefs] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [ready, setReady] = useState(false),
		[loading, setLoading] = useState(true),
		[settingsError, setSettingsError] = useState(false);
	const mounted = useRef(false),
		prompt = useRef<PromptEditorHandle>(null),
		form = useRef<HTMLFormElement>(null);
	const [error, setError] = useState('');
	const [launch, setLaunch] = useState<TaskLaunch | null>(null),
		[expanded, setExpanded] = useState(!!duplicateSource),
		[branchEdited, setBranchEdited] = useState(
			!!editing?.launch?.branch && !editing.launch.branchAuto
		);
	const draftId = useRef(crypto.randomUUID());
	// spec/git#main-tree-branches: branches to switch to before the start, per repo; never remembered for the project.
	const [switches, setSwitches] = useState<SheetSwitches>(() =>
		Object.fromEntries((editing?.launch?.switches ?? []).map((item) => [item.scopeId, item]))
	);
	// spec/git#pull: repos left on their branch pull before the start unless turned off here; an edited task keeps its own choice.
	const [pullOff, setPullOff] = useState<ReadonlySet<string>>(
		() =>
			new Set(
				editing?.launch?.isolation === 'in-place' && editing.launch.pull
					? editing.launch.scopes
							.filter((scope) => scope.selected && !editing.launch!.pull!.includes(scope.id))
							.map((scope) => scope.id)
					: []
			)
	);
	// spec/tasks#backlog-edit: a new task's attachments wait in the sheet's draft; an edited task keeps them as its own from the first one.
	const owner = useRef<AttachmentOwner>(
		editing
			? { projectId: editing.projectId, id: editing.id }
			: { projectId, id: draftId.current, draft: true }
	).current;
	const [attachments, setAttachments] = useState<PromptAttachment[]>(editing?.attachments ?? []),
		[attachError, setAttachError] = useState(''),
		[dropOver, setDropOver] = useState(false),
		[attaching, setAttaching] = useState(false);
	const attachmentsRef = useRef(attachments);
	attachmentsRef.current = attachments;
	const draftUsed = useRef(false),
		adopted = useRef(false),
		noteAttached = useRef(false);
	// spec/git#agent-branch-names: an empty field is an auto name — the agent names the branch at preparation, the name from the text holds its place.
	const branch = branchEdited ? (launch?.branch ?? '') : '';
	const dialog = useRef<HTMLDialogElement>(null);
	// spec/crew#compose: «the foreman composes» is the foreman alone; the editor sets its model, and agents added there make it a one-off crew.
	const composing = crewTemplateId === composeCrewId;
	const crewTemplate: CrewTemplate | undefined =
		oneOff ??
		(composing
			? {
					schemaVersion: 1,
					id: composeCrewId,
					name: 'Crew',
					builtin: true,
					root: { id: 'root', name: 'Foreman', template: foremanTemplateId },
				}
			: (library?.crews.find((item) => item.id === crewTemplateId) ?? library?.crews[0]));
	const crewSpec: CrewSpec | null = (() => {
		if (!library || !crewTemplate) return null;
		try {
			return resolveCrew(crewTemplate, {
				lookup: templateLookup(library.agents),
				defaultProvider: provider,
			});
		} catch {
			return null;
		}
	})();
	useEffect(() => {
		const wanted = taskType === 'brigadir' ? (['claude', 'codex'] as const) : [provider];
		for (const p of wanted)
			if (!(p in catalogs))
				void window.brigadir.readProviderCatalog(p).then(
					(catalog) => setCatalogs((current) => ({ ...current, [p]: catalog })),
					() => setCatalogs((current) => ({ ...current, [p]: null }))
				);
	}, [taskType, provider]);
	// spec/tasks#sheet-base-ref: the project's own branches; a ref the settings remember stays in the list even when it is gone.
	useEffect(() => {
		let active = true;
		void window.brigadir.readBaseRefs(projectId).then(
			(value) => {
				if (active) setRefs(value);
			},
			() => {}
		);
		return () => {
			active = false;
		};
	}, [projectId]);
	// A model id missing from the provider catalog is shown in amber, never silently replaced.
	// spec/agents-and-providers#catalog: each value is checked against the options of the agent's own model (effort differs per model).
	const unavailable = crewSpec
		? specAgents(crewSpec.root).filter((agent) => {
				const catalog = catalogs[agent.provider];
				if (!catalog) return false;
				const configOptions = agent.requestedChoices.configOptions ?? {},
					options = catalogOptions(
						catalog,
						configOptions[selectOption(catalog.options, 'model')?.id ?? '']
					);
				return Object.entries(configOptions).some(([id, value]) => {
					const option = options.find((item) => item.id === id);
					return (
						option?.kind === 'select' && !option.choices.some((choice) => choice.value === value)
					);
				});
			})
		: [];
	const modelOption = selectOption(catalogs[provider]?.options ?? [], 'model');
	const models = modelOption?.choices ?? [];
	// spec/agents-and-providers#catalog: the list is the provider's catalog and its first entry is chosen; spec/agents-and-providers#transport: a Codex id never lands on a Claude task.
	const model =
		modelPick?.provider === provider && models.some((choice) => choice.value === modelPick.value)
			? modelPick.value
			: (models[0]?.value ?? '');
	// spec/agents-and-providers#catalog: every select the provider shows for the chosen model (effort, mode, fast, …),
	// in the composer's order; each keeps the provider's own value until the person picks one.
	const launchSelects = orderAgentOptions(catalogOptions(catalogs[provider], model)).filter(
		(option): option is Extract<AgentOption, { kind: 'select' }> =>
			option.kind === 'select' && agentOptionKind(option) !== 'model' && option.choices.length > 0
	);
	// An on/off option (Fast mode) is a segmented toggle like «Transport», On first, not a popup.
	const isToggle = (option: Extract<AgentOption, { kind: 'select' }>) =>
		agentOptionKind(option) === 'fast' &&
		option.choices.length === 2 &&
		option.choices.some((choice) => /\b(on|true)\b/i.test(`${choice.value} ${choice.name}`));
	const toggleChoices = (option: Extract<AgentOption, { kind: 'select' }>) =>
		[...option.choices].sort(
			(a, b) =>
				Number(/\b(on|true)\b/i.test(`${b.value} ${b.name}`)) -
				Number(/\b(on|true)\b/i.test(`${a.value} ${a.name}`))
		);
	const picked = (option: Extract<AgentOption, { kind: 'select' }>) => {
		const pick = picks[option.id];
		return pick &&
			pick.provider === provider &&
			pick.model === model &&
			option.choices.some((choice) => choice.value === pick.value)
			? pick.value
			: null;
	};
	// spec/tasks#sheet-model: asking the agent takes a moment on a cold workspace — the chip waits in place.
	const askingModels = !(provider in catalogs);
	// spec/tasks#backlog-edit: the edit sheet is the new task sheet — name, model, effort and the rest until the task starts. A relay keeps its source's.
	const canName = !relay;
	const canAttach = !relaySource;
	// spec/tasks#backlog-edit: the edited task's model and options come back once the provider's catalog is there.
	// spec/tasks#agent-created-tasks: a proposed task brings its source's model and options the same way.
	const [proposalSeed, setProposalSeed] = useState<{
			provider: 'claude' | 'codex';
			launchOptions: { id: string; value: string | boolean }[];
		} | null>(null),
		// spec/tasks#sheet-role: a role with a provider brings its model and effort the same way, over the task's own.
		[roleSeed, setRoleSeed] = useState<typeof proposalSeed>(null),
		seedTask = roleSeed ?? editing ?? proposalSeed;
	const seeded = useRef(!editing && !proposal);
	const roles = soloRoleTemplates(library?.agents ?? []),
		role = roles.find((item) => item.id === roleId),
		// A role whose template is gone stays chosen by the name the task keeps.
		goneRole =
			roleId && library && !role && editing?.agentRole?.templateId === roleId ? editing : undefined,
		// A duplicate of a task whose template is gone opens with no role.
		chosenRole = role || goneRole || !library ? roleId : null,
		canRole = taskType === 'agent' && !relay && !scheduling,
		// spec/tasks#sheet-role: a checker runs in the GUI.
		checking =
			canRole && (role ? soloRoleChecks(role) : !!goneRole && goneRole.readOnlyAgent === true),
		sheetTransport = checking ? 'gui' : transport;
	function pickRole(id: string | null) {
		setRoleId(id);
		const template = roles.find((item) => item.id === id);
		if (!template?.provider || !enabledProviders[template.provider]) return;
		seeded.current = false;
		setProvider(template.provider);
		setRoleSeed({
			provider: template.provider,
			launchOptions: Object.entries(template.choices?.configOptions ?? {}).map(([key, value]) => ({
				id: key,
				value,
			})),
		});
	}
	useEffect(() => {
		if (seeded.current || !seedTask || provider !== seedTask.provider || !catalogs[provider])
			return;
		seeded.current = true;
		const chosen = seedTask.launchOptions ?? [],
			modelId = selectOption(catalogs[provider]!.options, 'model')?.id,
			choices = selectOption(catalogs[provider]!.options, 'model')?.choices ?? [];
		const pickedModel = chosen.find(
			(option) =>
				option.id === modelId &&
				typeof option.value === 'string' &&
				choices.some((choice) => choice.value === option.value)
		)?.value as string | undefined;
		if (pickedModel) setModelPick({ provider, value: pickedModel });
		const modelValue = pickedModel ?? choices[0]?.value ?? '';
		setPicks(
			Object.fromEntries(
				chosen
					.filter((option) => option.id !== modelId && typeof option.value === 'string')
					.map((option) => [
						option.id,
						{ provider, model: modelValue, value: option.value as string },
					])
			)
		);
	}, [catalogs, provider, proposalSeed, roleSeed]);
	function addAttachments(added: PromptAttachment[]) {
		if (!added.length) return;
		const next = [...attachmentsRef.current, ...added];
		if (
			next.length > 10 ||
			next.reduce((sum, item) => sum + item.bytes, 0) > attachmentTotalLimit
		) {
			setAttachError(t(locale, 'The files could not be attached. Check the attachment limits.'));
			return;
		}
		attachmentsRef.current = next;
		setAttachments(next);
	}
	async function attach(
		work: () => Promise<PromptAttachment[]>,
		failure:
			| 'The files could not be attached. Check the attachment limits.'
			| 'The image could not be attached. Check the attachment limits.'
	) {
		setAttachError('');
		if (!editing) draftUsed.current = true;
		try {
			addAttachments(await work());
		} catch {
			setAttachError(t(locale, failure));
		}
	}
	const pasteFiles = ({ files, text }: { files: File[]; text: string }) => {
		void attach(async () => {
			// spec/composer#paste: a Finder copy shows its files and no text; a picture on the clipboard is a file without a path and goes on to main.
			if (!text && files.length) {
				const added = await window.brigadir.attachDroppedFiles(owner, files);
				if (added.length) return added;
			}
			const image = await window.brigadir.pasteAttachment(owner, 'Pasted image');
			if (!image && text) prompt.current?.insertText(text);
			return image ? [image] : [];
		}, 'The image could not be attached. Check the attachment limits.');
	};
	async function openAttachMenu(button: HTMLElement) {
		const box = button.getBoundingClientRect(),
			choice = await window.brigadir.sheetAttachMenu(box.left, box.bottom + 4).catch(() => null);
		if (choice === 'files') {
			setAttaching(true);
			await attach(
				() => window.brigadir.pickAttachments(owner),
				'The files could not be attached. Check the attachment limits.'
			);
			setAttaching(false);
		}
		if (choice === 'markdown') {
			setAttachError('');
			try {
				const file = await window.brigadir.readMarkdownDescription();
				if (file) prompt.current?.insertText(file.text);
			} catch {
				setAttachError(t(locale, 'The .md file could not be read.'));
			}
		}
	}
	// spec/tasks#backlog-edit: Finder files over the left column show the composer's drop zone; the rail and the footer take no drop.
	const dropHandlers = canAttach
		? {
				onDragOver(event: React.DragEvent) {
					if (!event.dataTransfer.types.includes('Files')) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = 'copy';
					setDropOver(true);
				},
				onDragLeave(event: React.DragEvent) {
					const next = event.relatedTarget;
					if (!(next instanceof Node && event.currentTarget.contains(next))) setDropOver(false);
				},
				onDrop(event: React.DragEvent) {
					if (!event.dataTransfer.types.includes('Files')) return;
					event.preventDefault();
					setDropOver(false);
					const files = Array.from(event.dataTransfer.files);
					if (files.length)
						void attach(
							() => window.brigadir.attachDroppedFiles(owner, files),
							'The files could not be attached. Check the attachment limits.'
						);
				},
			}
		: {};
	const chooseType = (type: 'agent' | 'brigadir') => {
		setTaskType(type);
		if (type === 'brigadir' && launch && launch.isolation !== 'worktree' && !editing)
			setLaunch({ ...launch, isolation: 'worktree' });
	};
	async function loadDefaults() {
		const revision = ++loadRevision.current;
		setLoading(true);
		setSettingsError(false);
		try {
			const [{ settings }, defaults, templates] = await Promise.all([
				window.brigadir.readSettings(),
				window.brigadir.readLaunchSettings(projectId),
				window.brigadir.readTemplates(),
			]);
			const draft = relaySource ? await window.brigadir.prepareRelay(relaySource) : null;
			if (proposal) draftUsed.current = true;
			const proposed = proposal
				? await window.brigadir.draftProposedTask(proposal.source, proposal.proposal.id, owner)
				: null;
			if (!mounted.current || revision !== loadRevision.current) {
				if (draft) void window.brigadir.discardRelay(draft.id);
				return;
			}
			if (draft) {
				relayId.current = draft.id;
				setRelay(draft);
			}
			if (note && !noteAttached.current) {
				noteAttached.current = true;
				draftUsed.current = true;
				try {
					const context = await window.brigadir.attachNote(owner, note.id);
					if (mounted.current && revision === loadRevision.current) {
						attachmentsRef.current = [...attachmentsRef.current, context];
						setAttachments(attachmentsRef.current);
					}
				} catch {
					// The note's text is in the prompt anyway; the sheet works without the context.
				}
			}
			if (proposed) {
				setText(proposed.prompt);
				if (proposed.title) setName(proposed.title);
				attachmentsRef.current = proposed.attachments;
				setAttachments(proposed.attachments);
				setProposalSeed({ provider: proposed.provider, launchOptions: proposed.options });
			}
			setLibrary(templates);
			// spec/pull-requests-and-ci#review-crew: a remembered crew that left the library (a deleted or hidden built-in) starts without a crew.
			const known = (id: string | undefined) =>
				id === composeCrewId || templates.crews.some((item) => item.id === id);
			const kept = editing?.crew?.templateId ?? duplicateSource?.crew?.templateId;
			if (!editing?.crew && !duplicateSource?.crew) {
				if (defaults.crewTemplateId && known(defaults.crewTemplateId))
					setCrewTemplateId(defaults.crewTemplateId);
			} else if (kept && !known(kept)) setCrewTemplateId(composeCrewId);
			setLaunch(
				proposed?.launch ??
					draft?.launch ??
					editing?.launch ??
					(duplicateSource?.launch
						? { ...duplicateSource.launch, branch: '' }
						: { ...defaults, branch: '' })
			);
			setEnabledProviders(settings.agents.enabled);
			setProvider(
				proposed?.provider ??
					draft?.source.provider ??
					editing?.provider ??
					duplicateSource?.provider ??
					settings.agents.provider
			);
			setTransport(
				proposed?.transport ??
					draft?.source.transport ??
					editing?.transport ??
					duplicateSource?.transport ??
					settings.agents.transport
			);
			setReady(true);
		} catch {
			if (mounted.current) setSettingsError(true);
		} finally {
			if (mounted.current) setLoading(false);
		}
	}
	useEffect(() => {
		mounted.current = true;
		void loadDefaults();
		const previous = document.activeElement;
		const element = dialog.current;
		element?.showModal();
		return () => {
			mounted.current = false;
			loadRevision.current++;
			if (relayId.current) void window.brigadir.discardRelay(relayId.current).catch(() => {});
			if (draftUsed.current && !adopted.current)
				void window.brigadir.discardAttachmentDraft(owner).catch(() => {});
			element?.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);
	// Focus only after React has enabled the fieldset in the committed DOM — and not over a field the person already
	// focused in that frame: otherwise the frame after `ready` pulls the caret out of «Task name» mid-typing.
	useEffect(() => {
		if (!ready) return;
		const before = document.activeElement;
		const frame = requestAnimationFrame(() => {
			if (document.activeElement === before) prompt.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [ready]);
	async function submit(startNow = false, toBacklog = false) {
		const backlog = initialBacklogOr(toBacklog);
		if (busy || !ready || !launch || (summaryPending && selection.summary && !backlog && !startNow))
			return;
		if (launch.isolation === 'worktree' && branchEdited && !validBranch(branch)) {
			setError(t(locale, 'Enter a valid ASCII branch name.'));
			return;
		}
		setBusy(true);
		setError('');
		try {
			if (scheduling && !editing && !relay) {
				// spec/notifications-slack-notes-and-schedules#schedules: the blank — this sheet's arguments to `task:create`; every run takes an auto branch of its own.
				const { branchAuto: _a, switches: _s, pull: _p, ...base } = launch;
				const choices = [
					...(model && modelOption ? [{ id: modelOption.id, value: model }] : []),
					...launchSelects.flatMap((option) => {
						const value = picked(option);
						return value ? [{ id: option.id, value }] : [];
					}),
				];
				const crewProvider =
					taskType === 'brigadir' ? (crewSpec?.root.provider ?? provider) : provider;
				const schedule = await window.brigadir.createSchedule(projectId, {
					name: (
						name.trim() ||
						promptDisplayText(text).trim().split('\n')[0] ||
						t(locale, 'New task')
					).slice(0, 120),
					timeZone: timing.timeZone,
					rule: timing.rule,
					missed: timing.missed,
					inTasks: timing.inTasks,
					task: {
						prompt: text,
						provider: crewProvider,
						transport: taskType === 'brigadir' ? 'gui' : transport,
						launch: { ...base, branch: '' },
						...(taskType === 'brigadir'
							? {
									crew: composing
										? { compose: true as const, ...(oneOff ? { template: oneOff } : {}) }
										: oneOff
											? { template: oneOff }
											: { templateId: crewTemplateId },
								}
							: {}),
						...(choices.length ? { options: choices } : {}),
					},
				});
				scheduled?.(schedule);
				close();
				return;
			}
			const { branchAuto: _auto, switches: _switches, pull: _pull, ...rest } = launch,
				chosenSwitches = launch.isolation === 'in-place' ? Object.values(switches) : [],
				pulls =
					launch.isolation === 'in-place'
						? rest.scopes
								.filter(
									(scope) =>
										scope.selected &&
										scope.kind !== 'folder' &&
										scope.kind !== 'external' &&
										!pullOff.has(scope.id) &&
										!switches[scope.id]
								)
								.map((scope) => scope.id)
						: [],
				chosen = {
					...rest,
					...(chosenSwitches.length ? { switches: chosenSwitches } : {}),
					...(pulls.length ? { pull: pulls } : {}),
				},
				options = branchEdited
					? { ...chosen, branch }
					: {
							...chosen,
							branch: suggestedBranch(name, text, editing?.id ?? draftId.current),
							branchAuto: true,
						};
			const crewProvider =
				taskType === 'brigadir' ? (crewSpec?.root.provider ?? provider) : provider;
			const choices = [
				...(model && modelOption ? [{ id: modelOption.id, value: model }] : []),
				...launchSelects.flatMap((option) => {
					const value = picked(option);
					return value ? [{ id: option.id, value }] : [];
				}),
			];
			const ids = attachments.map((item) => item.id);
			const sheet: TaskSheet = {
				...(name.trim() ? { name: name.trim() } : {}),
				...(choices.length ? { options: choices } : {}),
				...(!editing && ids.length ? { attachments: ids, draftId: draftId.current } : {}),
				// spec/tasks#sheet-role: a new task names its role; the edit says what it is now, unless its template is gone.
				...(canRole && (editing ? !goneRole : chosenRole) ? { role: chosenRole } : {}),
			};
			// spec/tasks#backlog-edit: the edit sends the whole sheet — an emptied name gives the title back to the text, the list is the task's.
			if (!editing && ids.length) adopted.current = true;
			const task = relay
				? await window.brigadir.createRelayTask({
						draftId: relay.id,
						text,
						provider,
						transport,
						backlog,
						launch: options,
						selection,
					})
				: editing
					? await window.brigadir.editBacklogTask(
							editing,
							text,
							provider,
							sheetTransport,
							options,
							{
								...sheet,
								attachments: ids,
							}
						)
					: await window.brigadir.createTask(
							projectId,
							text,
							crewProvider,
							taskType === 'brigadir' ? 'gui' : sheetTransport,
							backlog,
							options,
							taskType === 'brigadir'
								? composing
									? { compose: true, ...(oneOff ? { template: oneOff } : {}) }
									: oneOff
										? { template: oneOff }
										: { templateId: crewTemplateId }
								: undefined,
							Object.keys(sheet).length ? sheet : undefined
						);
			if (proposal)
				await window.brigadir
					.adoptProposedTask(proposal.source, proposal.proposal.id, task)
					.catch(() => {});
			await created(task);
			// One launch path (spec/projects-and-board#project-screen rule 6): main starts the agent and delivers the stored prompt, now or when a slot frees (spec/tasks#launch-sheet).
			// spec/tasks#backlog-edit: «Почати задачу» in the edit sheet saves and starts the same way.
			try {
				if (!backlog || startNow) await window.brigadir.startSession(task);
			} catch {
				/* Startup failures are journaled and shown in the selected task. */
			}
		} catch (error) {
			adopted.current = false;
			setError(String(error));
			setBusy(false);
		}
	}
	function initialBacklogOr(toBacklog: boolean) {
		return backlog || toBacklog;
	}
	// The editor is a second modal above the sheet: the sheet stays mounted, so its dialog stays open and its draft survives.
	// spec/tasks#sheet-layout: the «Бригада» group of the `@` menu is only for the «Бригадир» type. The token is the node's English name.
	const crewMentions: MentionOption[] =
		taskType === 'brigadir' && crewSpec
			? specAgents(crewSpec.root).map((agent, index) => ({
					kind: 'crew',
					token: agent.name.replace(/\s+/g, '-'),
					label: crewLabel(locale, agent.name),
					icon: index === 0 ? 'helmet' : 'person',
					...(crewModel(agent) ? { tail: crewModel(agent)! } : {}),
				}))
			: [];
	// spec/composer#slash-menu: `/` in the sheet is the same list as the task composer's before the agent starts: the agent's disk and our MCP tools.
	const [slashOpen, setSlashOpen] = useState(false),
		slashProvider = taskType === 'brigadir' ? (crewSpec?.root.provider ?? provider) : provider;
	const slashCatalog = useSlashCatalog(
		{ projectId, provider: slashProvider, crew: taskType === 'brigadir' },
		slashOpen
	);
	const slash = { ...slashEntries({ catalog: slashCatalog, agent: null }), onOpen: setSlashOpen };
	// spec/tasks#sheet-layout: two columns. The task text on the left, the parameter rail on the right; no disclosure strip.
	const scopeChips = launch?.scopes ?? [];
	const toggleScope = (id: string) => {
		if (!launch) return;
		setLaunch({
			...launch,
			scopes: launch.scopes.map((scope) =>
				scope.id === id ? { ...scope, selected: !scope.selected } : scope
			),
		});
	};
	// spec/notifications-slack-notes-and-schedules#message-classes T*: a failed add is a line in the sheet under the chips (a toast would stay under the modal sheet);
	// the next attempt or closing the sheet clears it.
	const [folderError, setFolderError] = useState(false);
	// spec/tasks#worktree-preparation: the folder just added carries an accent ring
	// that fades after ~2 s.
	const [freshScope, setFreshScope] = useState<string | null>(null);
	useEffect(() => {
		if (!freshScope) return;
		const timer = window.setTimeout(() => setFreshScope(null), 2000);
		return () => window.clearTimeout(timer);
	}, [freshScope]);
	async function addFolder() {
		if (!launch) return;
		setFolderError(false);
		let added: ScopeChoice | null;
		try {
			added = await window.brigadir.addProjectFolder(
				projectId,
				launch.scopes.map((scope) => scope.name)
			);
		} catch {
			setFolderError(true);
			return;
		}
		if (!added) return;
		setFreshScope(added.id);
		setLaunch((current) =>
			current && current.scopes.some((scope) => scope.id === added.id)
				? current
				: current
					? { ...current, scopes: [...current.scopes, added] }
					: current
		);
	}
	// spec/tasks#sheet-rail: every list of the sheet ticks its value; a closed popup hovers whole.
	return (
		<PopupMarks.Provider value>
			<dialog
				ref={dialog}
				className={styles.sheet}
				aria-label={t(locale, editing ? 'Edit task' : 'New task')}
				onCancel={(event) => {
					event.preventDefault();
					if (!busy) close();
				}}>
				<form
					ref={form}
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}>
					<fieldset disabled={busy || !ready} className={styles.body}>
						<header className={styles.heading} data-size="l">
							{canName ? (
								<TextInput
									size="l"
									id="new-task-title"
									className={styles.name}
									aria-label={t(locale, 'Task name')}
									placeholder={t(locale, 'Task name (optional)')}
									value={name}
									onChange={(event) => setName(event.target.value)}
								/>
							) : (
								<h1 id="new-task-title" className={styles.name}>
									{t(locale, editing ? 'Edit task' : 'New task')}
								</h1>
							)}
							<span className={styles.project} title={projectName}>
								{projectName}
							</span>
							<div className={styles.type}>
								<Segments
									label={t(locale, 'Task type')}
									value={taskType}
									options={[
										{
											value: 'agent',
											label: t(locale, 'Agent'),
											icon: <Glyph name="person" size={13} />,
										},
										{
											value: 'brigadir',
											label: t(locale, 'Brigadir'),
											icon: <Glyph name="helmet" size={13} />,
										},
									]}
									onChange={(value) => chooseType(value as 'agent' | 'brigadir')}
								/>
							</div>
							<PopupClose locale={locale} close={close} />
						</header>
						<div className={styles.columns}>
							<div
								className={styles.left}
								data-drop-over={dropOver || undefined}
								{...dropHandlers}
								onMouseDown={(event) => {
									// spec/tasks#sheet-rail: the text does not fill the column; its empty rest still puts the caret in it.
									if (event.target !== event.currentTarget || busy || !ready) return;
									event.preventDefault();
									prompt.current?.focus();
								}}>
								{relay && (
									<div className={styles.relay}>
										<Glyph name="relay" size={12} />
										<span>
											{t(locale, 'Continuation of')} <strong>{relay.source.title}</strong>
										</span>
									</div>
								)}
								{note && (
									<div className={styles.relay} data-note-source>
										<Glyph name="note" size={12} />
										<span>
											{t(locale, 'From the note')} <strong>{note.title}</strong>
											{note.range ? ` · ${note.range}` : ''}
										</span>
									</div>
								)}
								{proposal && (
									<div className={styles.relay} data-proposal-source>
										<Glyph name="task-new" size={12} />
										<span>
											{t(locale, 'Proposed in')} <strong>{proposal.source.title}</strong>
										</span>
									</div>
								)}
								<PromptEditor
									ref={prompt}
									value={text}
									onChange={setText}
									locale={locale}
									ariaLabel={t(locale, 'Message')}
									placeholder={t(locale, 'Write a message… (optional)')}
									crew={crewMentions}
									slash={slash}
									searchFiles={(query) => window.brigadir.searchProjectFiles(projectId, query)}
									onSubmit={() => form.current?.requestSubmit()}
									disabled={busy || !ready}
									{...(canAttach
										? {
												attachments: {
													owner,
													items: attachments,
													onRemove: (id) =>
														setAttachments((current) => current.filter((item) => item.id !== id)),
													onPaste: pasteFiles,
												},
											}
										: {})}
								/>
								<div className={styles.mentionHint} data-attachable={canAttach || undefined}>
									{canAttach && (
										<IconButton
											size="s"
											className={styles.attach}
											label={t(locale, 'Attach files')}
											// spec/tasks#sheet-rail: the «+» tooltip is the name, and the limits on a line under it.
											hint={`${t(locale, 'Attach files')}\n${t(locale, 'Up to 10 files, 8 MB total; images up to 4 MB.')}`}
											disabled={busy || !ready || attaching}
											onClick={(event) => {
												void openAttachMenu(event.currentTarget);
											}}>
											<Glyph name="plus" size={14} />
										</IconButton>
									)}
									<span className={styles.hintGroup}>
										<span aria-hidden="true" className={styles.at}>
											@
										</span>
										<span>{t(locale, 'file, agent or someone from the crew')}</span>
									</span>
									{canAttach && (
										<>
											<span aria-hidden="true">·</span>
											<span className={styles.hintGroup}>
												<Glyph name="image" size={11} />
												<span>{shortcutHint(locale, '⌘V or drag: images and files')}</span>
											</span>
										</>
									)}
								</div>
								{attachError && (
									<p role="alert" className={styles.attachError}>
										{attachError}
									</p>
								)}
								{/* spec/composer#paste: the composer's drop zone over the text column, below the sheet's header. */}
								{canAttach && (
									<div className={styles.dropZone} aria-hidden="true">
										<div>
											<span>
												<Glyph name="drop" size={14} />
												{t(locale, 'Release to attach')}
											</span>
											<small>{t(locale, 'Up to 10 files, 8 MB together; images up to 4 MB')}</small>
										</div>
									</div>
								)}
								{relay && (
									<RelayChips
										draft={relay}
										selection={selection}
										setSelection={setSelection}
										locale={locale}
										onPending={setSummaryPending}
									/>
								)}
							</div>
							<aside className={styles.rail} aria-label={t(locale, 'Launch options')} data-size="m">
								{/* spec/notifications-slack-notes-and-schedules#schedules: first in the rail — Now · Later · Repeat; the rule opens the editor. */}
								{schedulesModule && !editing && !relay && (
									<div className={styles.group} data-when-row>
										<span className={styles.railLabel}>{t(locale, 'When')}</span>
										<Segments
											label={t(locale, 'When')}
											options={[
												{ value: 'now', label: t(locale, 'Now (when)') },
												{ value: 'later', label: t(locale, 'Later') },
												{ value: 'repeat', label: t(locale, 'Repeat (schedule)') },
											]}
											value={when}
											onChange={(value) => {
												const next = value as When;
												setWhen(next);
												if (
													next !== 'now' &&
													(next === 'later') !== (timing.rule.kind === 'once')
												) {
													setTiming(initialTiming(next));
													setTimingValid(true);
												}
												if (next !== 'now') setBacklog(false);
											}}
										/>
										{scheduling && (
											<>
												<Button
													ref={whenField}
													className={styles.whenField}
													aria-haspopup="dialog"
													aria-expanded={timingOpen}
													opensPopover
													data-invalid={!timingValid || undefined}
													onClick={() => setTimingOpen(true)}>
													<Glyph name={when === 'later' ? 'clock' : 'schedule'} size={13} />
													<span>{describeRule(locale, timing.rule, timing.timeZone)}</span>
													<Glyph name="chevron-down" size={9} />
												</Button>
												{when !== 'later' && (
													<p className={styles.crewHint}>
														{t(locale, 'Each run starts a new task.')}
													</p>
												)}
												<Popover
													open={timingOpen}
													onClose={() => setTimingOpen(false)}
													anchor={whenField}
													label={t(locale, 'Schedule')}
													locale={locale}
													side="right"
													width={340}
													overflow="visible">
													<ScheduleEditor
														locale={locale}
														value={timing}
														allowOnce
														onChange={(next, valid) => {
															setTiming(next);
															setTimingValid(valid);
															setWhen(next.rule.kind === 'once' ? 'later' : 'repeat');
														}}
													/>
												</Popover>
											</>
										)}
									</div>
								)}
								{/* spec/tasks#relay: the relay's parameters come from the source task — the rail says where from. */}
								{relay && (
									<p className={styles.inherited}>
										{t(locale, 'As in')} {relay.source.title}
									</p>
								)}
								{taskType === 'brigadir' ? (
									<div className={styles.group} data-crew-row>
										<div className={styles.railLabelRow} data-size="s">
											<span className={styles.railLabel}>{t(locale, 'Crew')}</span>
											<QuotaButton locale={locale} placement="below" />
										</div>
										{/* spec/crew-templates-and-editor#editor-inspector: the chosen crew is ticked. */}
										<PopupMarks.Provider value>
											<Popup
												label={t(locale, 'Crew')}
												align="end"
												value={
													composing ? composeCrewId : oneOff ? 'one-off' : (crewTemplate?.id ?? '')
												}
												{...(oneOff && !composing
													? {
															displayValue: `${crewLabel(locale, oneOff.name)} · ${t(locale, 'own')}`,
														}
													: !composing && crewTemplate?.builtin
														? // The empty slot of a built-in stays in the list; the closed popup shows the name alone.
															{ icon: false }
														: {})}
												groups={{ templates: { label: t(locale, 'Crew templates') } }}
												options={[
													{
														value: composeCrewId,
														label: t(locale, 'Foreman composes'),
														icon: (
															<span className={styles.crewGlyph}>
																<Glyph name="generate" size={11} />
															</span>
														),
													},
													// spec/crew-templates-and-editor#editor-inspector: one column of names, a built-in keeps the slot empty.
													...(library?.crews ?? []).map((item) => ({
														value: item.id,
														label: crewLabel(locale, item.name),
														icon: (
															<span className={styles.crewGlyph}>
																{item.builtin ? null : <Glyph name="edit" size={10} />}
															</span>
														),
														tail: crewTemplateTail(locale, item),
														group: 'templates',
													})),
												]}
												onChange={(value) => {
													setOneOff(null);
													setCrewTemplateId(value);
												}}
												disabled={!library}
											/>
										</PopupMarks.Provider>
										<Button
											disabled={!library || !crewTemplate}
											onClick={() => setEditorOpen(true)}>
											{t(locale, 'Set up…')}
										</Button>
										{crewSpec && (
											<div className={styles.crewRoster}>
												<CrewRoster
													spec={crewSpec}
													locale={locale}
													unavailable={unavailable.map((agent) => agent.id)}
												/>
											</div>
										)}
										{unavailable.map((agent) => (
											<p key={agent.id} className={styles.crewWarning} role="status">
												<Glyph name="review-warning" size={11} />
												{t(
													locale,
													'Model «{model}» is unavailable in {provider} — {agent} starts with the provider default.'
												)
													.replace('{model}', crewModel(agent) ?? '')
													.replace('{provider}', agent.provider === 'claude' ? 'Claude' : 'Codex')
													.replace('{agent}', crewLabel(locale, agent.name))}
											</p>
										))}
									</div>
								) : (
									<>
										{/* spec/tasks#sheet-role: the template the agent works as; «No role» is an agent with no role text. */}
										{canRole && (
											<div className={styles.group} data-role-row>
												<span className={styles.railLabel}>{t(locale, 'Role')}</span>
												<Popup
													align="end"
													label={t(locale, 'Role')}
													value={chosenRole ?? ''}
													options={[
														{
															value: '',
															label: t(locale, 'No role'),
															icon: <Glyph name="person" size={13} />,
														},
														...roles.map((item) => ({
															value: item.id,
															label: crewLabel(locale, item.name),
															icon: (
																<Glyph name={soloRoleChecks(item) ? 'review' : 'code'} size={13} />
															),
														})),
														...(goneRole?.agentRole
															? [
																	{
																		value: goneRole.agentRole.templateId,
																		label: crewLabel(locale, goneRole.agentRole.name),
																		icon: (
																			<Glyph
																				name={goneRole.readOnlyAgent ? 'review' : 'code'}
																				size={13}
																			/>
																		),
																	},
																]
															: []),
													]}
													onChange={(value) => pickRole(value || null)}
												/>
											</div>
										)}
										<div className={styles.group}>
											<div className={styles.railLabelRow} data-size="s">
												<span className={styles.railLabel}>{t(locale, 'Agent')}</span>
												<QuotaButton locale={locale} placement="below" />
											</div>
											<Popup
												align="end"
												label={t(locale, 'Agent')}
												value={provider}
												options={[
													{
														value: 'claude',
														label: t(locale, 'Claude'),
														icon: <Glyph name="claude" />,
													},
													{
														value: 'codex',
														label: t(locale, 'Codex'),
														icon: <Glyph name="openai" />,
													},
												].filter(
													(option) =>
														enabledProviders[option.value as 'claude' | 'codex'] ||
														option.value === provider
												)}
												onChange={(value) => setProvider(value as 'claude' | 'codex')}
											/>
											{canName && askingModels && (
												<Popup
													disabled
													align="end"
													label={t(locale, 'Model')}
													value=""
													displayValue={<Spinner size={10} />}
													options={[]}
													onChange={() => {}}
												/>
											)}
											{canName && models.length > 0 && (
												<Popup
													align="end"
													label={t(locale, 'Model')}
													value={model}
													options={models.map((choice) => ({
														value: choice.value,
														label: choice.name,
													}))}
													onChange={(value) => setModelPick({ provider, value })}
												/>
											)}
											{/* spec/agents-and-providers#catalog: effort, mode and the model's other options — the same popup as the model, with an icon in the button and in the list. */}
											{canName &&
												models.length > 0 &&
												launchSelects
													.filter((option) => !isToggle(option))
													.map((option) => {
														const kind = agentOptionKind(option),
															value = picked(option) ?? option.value,
															choice =
																option.choices.find((item) => item.value === value)?.name ?? value;
														return (
															<Popup
																key={option.id}
																align="end"
																label={
																	kind === 'effort'
																		? t(locale, 'Effort')
																		: kind === 'mode'
																			? t(locale, 'Mode')
																			: option.name
																}
																value={value}
																{...(kind === 'effort' || kind === 'mode'
																	? {}
																	: { displayValue: `${option.name} · ${choice}` })}
																options={optionChoices(kind, option.choices)}
																onChange={(next) =>
																	setPicks((current) => ({
																		...current,
																		[option.id]: { provider, model, value: next },
																	}))
																}
															/>
														);
													})}
										</div>
										{canName &&
											models.length > 0 &&
											launchSelects.filter(isToggle).map((option) => (
												<div key={option.id} className={styles.group} data-sheet-toggle={option.id}>
													<span className={styles.railLabel}>{option.name}</span>
													<Segments
														label={option.name}
														value={picked(option) ?? option.value}
														options={toggleChoices(option).map((choice) => ({
															value: choice.value,
															label: choice.name,
															icon: (
																<OptionIcon kind="fast" choice={choice} choices={option.choices} />
															),
														}))}
														onChange={(next) =>
															setPicks((current) => ({
																...current,
																[option.id]: { provider, model, value: next },
															}))
														}
													/>
												</div>
											))}
										{!checking && (
											<div className={styles.group}>
												<span className={styles.railLabel}>{t(locale, 'Transport')}</span>
												<Segments
													label={t(locale, 'Transport')}
													value={transport}
													options={[
														{ value: 'gui', label: 'GUI' },
														{ value: 'terminal', label: 'CLI' },
													]}
													onChange={(value) => setTransport(value as 'gui' | 'terminal')}
												/>
											</div>
										)}
									</>
								)}
								{launch && (
									<fieldset disabled={!!editing?.preparation} className={styles.settings}>
										<div className={styles.group}>
											<span className={styles.railLabel}>{t(locale, 'Isolation')}</span>
											<Segments
												label={t(locale, 'Isolation')}
												value={launch.isolation}
												options={[
													{ value: 'in-place', label: t(locale, 'No isolation') },
													{ value: 'worktree', label: t(locale, 'Worktree') },
												]}
												onChange={(value) =>
													setLaunch({ ...launch, isolation: value as TaskLaunch['isolation'] })
												}
											/>
											{/* spec/tasks#sheet-layout: the branch and base ref do not disappear but dim — the rail does not jump. */}
											{/* spec/tasks#isolation: worktree fields exist only for worktree — without isolation they are absent; they come and go by collapsing. */}
											<div
												className={styles.worktree}
												data-open={launch.isolation === 'worktree'}
												inert={launch.isolation !== 'worktree'}
												aria-hidden={launch.isolation !== 'worktree'}>
												<div className={styles.worktreeBody}>
													<TextInput
														className={styles.ref}
														aria-label={t(locale, 'Branch name')}
														placeholder={t(locale, 'brigadir/auto')}
														value={branch}
														onChange={(event) => {
															setBranchEdited(!!event.target.value);
															setLaunch({ ...launch, branch: event.target.value });
														}}
													/>
													<div className={styles.fromRow}>
														<span>{t(locale, 'from')}</span>
														<Popup
															align="end"
															search={{
																placeholder: t(locale, 'Search branches'),
																empty: t(locale, 'No branches match'),
																clear: t(locale, 'Clear the field'),
															}}
															label={t(locale, 'Base ref')}
															value={launch.baseRef}
															options={[
																...(refs.includes(launch.baseRef) ? [] : [launch.baseRef]),
																...refs,
															].map((ref) => ({ value: ref, label: ref, labelStyle: refStyle }))}
															onChange={(value) => setLaunch({ ...launch, baseRef: value })}
														/>
													</div>
													<TextInput
														className={`${styles.ref} ${styles.setupCommand}`}
														aria-label={t(locale, 'Setup command')}
														placeholder={t(locale, 'Setup command')}
														value={launch.setupCommand}
														onChange={(event) =>
															setLaunch({ ...launch, setupCommand: event.target.value })
														}
													/>
													{/* spec/git#worktree-env: starts from Settings ▸ Editor ▸ Git; the choice belongs to this task. */}
													<label className={styles.envRow} data-copy-env data-size="s">
														<Switch
															label={t(locale, 'Copy .env')}
															checked={launch.copyEnvFiles === true}
															onChange={(copyEnvFiles) => setLaunch({ ...launch, copyEnvFiles })}
														/>
														<span>{t(locale, 'Copy .env')}</span>
													</label>
												</div>
											</div>
											{launch.isolation === 'worktree' &&
												!launch.scopes.some((scope) => scope.name === '.') && (
													<p role="alert" className={styles.caption}>
														{t(locale, 'A Git repository is required for worktree isolation.')}
													</p>
												)}
											{/* spec/git#main-tree-branches: without isolation, the branch of each git repo of the task stands in place of the worktree fields; it collapses with the same motion. */}
											<div
												className={styles.worktree}
												data-open={launch.isolation === 'in-place'}
												inert={launch.isolation !== 'in-place'}
												aria-hidden={launch.isolation !== 'in-place'}>
												<div className={styles.worktreeBody}>
													{launch.isolation === 'in-place' && (
														<SheetBranches
															projectId={projectId}
															projectName={projectName}
															locale={locale}
															scopes={launch.scopes.filter(
																(scope) =>
																	scope.selected &&
																	scope.kind !== 'folder' &&
																	scope.kind !== 'external'
															)}
															value={switches}
															onChange={setSwitches}
															pullOff={pullOff}
															onPullOff={(id, off) =>
																setPullOff((current) => {
																	const next = new Set(current);
																	if (off) next.add(id);
																	else next.delete(id);
																	return next;
																})
															}
															onCommitFirst={(scopeId) => {
																const scope = launch.scopes.find((item) => item.id === scopeId);
																void submit(false, true).then(() =>
																	commitFirst({
																		projectId,
																		scopeId,
																		name: scope?.name === '.' ? projectName : (scope?.name ?? ''),
																	})
																);
															}}
														/>
													)}
												</div>
											</div>
										</div>
										{!!scopeChips.length && (
											<div className={styles.group}>
												<span className={styles.railLabel}>{t(locale, 'Repos and folders')}</span>
												<div className={styles.chips}>
													{scopeChips.map((scope) => (
														<Chip
															key={scope.id}
															tone={scope.selected ? 'selected' : 'normal'}
															fresh={scope.id === freshScope}
															aria-pressed={scope.selected}
															aria-label={`${scope.selected ? t(locale, 'Remove from the task…') : t(locale, 'Add to the task')} · ${scope.name === '.' ? projectName : scope.name}`}
															onClick={() => toggleScope(scope.id)}>
															<Glyph
																name={
																	scope.kind === 'folder' || scope.kind === 'external'
																		? 'folder'
																		: scope.selected
																			? 'close'
																			: 'plus'
																}
																size={10}
															/>
															<code>{scope.name === '.' ? projectName : scope.name}</code>
															{scope.kind === 'folder' && <small>{t(locale, 'no git')}</small>}
														</Chip>
													))}
													{/* spec/tasks#sheet-rail: a chip of the row, dashed. */}
													<Chip
														className={styles.addFolder}
														onClick={() => {
															void addFolder();
														}}>
														<Glyph name="folder-plus" size={10} />
														{t(locale, 'Add folder…')}
													</Chip>
												</div>
												{folderError && (
													<p className={styles.fieldError} role="alert">
														{t(locale, 'The folder could not be added.')}
													</p>
												)}
											</div>
										)}
										<p className={styles.caption}>
											{t(locale, 'Launch settings are saved for this project.')}
										</p>
									</fieldset>
								)}
							</aside>
						</div>
						{error && (
							<div className={styles.error} role="alert">
								{t(locale, 'The request failed.')} {error}
							</div>
						)}
					</fieldset>
					{loading && (
						<div className={styles.loading}>
							<SkeletonText lines={2} />
						</div>
					)}
					{settingsError && (
						<div className={`${styles.error} ${styles.loadError}`}>
							<p role="alert">{t(locale, 'The settings could not be loaded.')}</p>
							<Button
								onClick={() => {
									void loadDefaults();
								}}>
								{t(locale, 'Retry')}
							</Button>
						</div>
					)}
					{/* spec/tasks#sheet-footer: the backlog is a toggle. The plus puts the task there, the cross takes it out; the label is the same in both states. */}
					<footer className={styles.footer} data-size="m">
						{!editing && !scheduling && (
							<Button
								className={styles.backlog}
								aria-pressed={backlog}
								disabled={busy}
								onClick={() => setBacklog((value) => !value)}>
								<Glyph name={backlog ? 'close' : 'plus'} size={11} />
								{t(locale, 'Add to backlog')}
							</Button>
						)}
						{/* spec/tasks#backlog-edit: in the edit sheet «Почати задачу» stands where the backlog toggle is; it saves and starts. */}
						{editing && (
							<Button
								className={styles.startNow}
								data-start-now
								disabled={
									busy ||
									!ready ||
									(launch?.isolation === 'worktree' &&
										((branchEdited && !validBranch(branch)) ||
											!launch.scopes.some((scope) => scope.name === '.')))
								}
								onClick={() => {
									void submit(true);
								}}>
								<Glyph name="resume" size={11} />
								{t(locale, 'Start task')}
							</Button>
						)}
						<Button onClick={close} disabled={busy}>
							{t(locale, 'Cancel')}
						</Button>
						<Button
							appearance="primary"
							type="submit"
							disabled={
								busy ||
								!ready ||
								(summaryPending && selection.summary && !backlog && !scheduling) ||
								(scheduling && (!timingValid || !text.trim())) ||
								(launch?.isolation === 'worktree' &&
									((branchEdited && !validBranch(branch)) ||
										!launch.scopes.some((scope) => scope.name === '.')))
							}>
							{t(
								locale,
								scheduling ? 'Schedule (verb)' : backlog ? 'Save' : busy ? 'Starting…' : 'Start'
							)}
						</Button>
					</footer>
				</form>
			</dialog>
			{editorOpen && library && crewTemplate && (
				<CrewEditor
					key={crewTemplate.id}
					template={oneOff ?? crewTemplate}
					library={library}
					locale={locale}
					oneOff
					close={() => setEditorOpen(false)}
					done={(template) => {
						if (composing && template.root.agents?.length) setCrewTemplateId(defaultCrewTemplateId);
						setOneOff(template);
						setEditorOpen(false);
					}}
					libraryChanged={(value) => {
						setLibrary(value);
					}}
				/>
			)}
		</PopupMarks.Provider>
	);
}
