import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
	addCrewAgent,
	addCrewCheck,
	branchAsCrewTemplate,
	crewAgentRole,
	crewAgents,
	crewDepth,
	crewIssues,
	crewIssueText,
	crewName,
	crewParent,
	crewRecommendedDepth,
	crewSummary,
	crewSummaryLimit,
	findCrewAgent,
	foremanTemplateId,
	developerTemplateId,
	reviewerTemplateId,
	removeCrewAgent,
	removeCrewCheck,
	renameCrewAgent,
	templateLookup,
	updateCrewAgent,
	agentOptionKind,
	catalogOptions,
	selectOption,
	crewAgentCountLabel,
	crewLevelCountLabel,
	subordinateCount,
	t,
	type AgentOption,
	type AgentProvider,
	type AgentTemplate,
	type CrewAgent,
	type CrewLibrary,
	type CrewTemplate,
	type Locale,
	type ProviderCatalog,
} from '@brigadir/core';
import { crewLabel } from './Crew';
import { Glyph } from './ui/Glyph';
import { effortOptions } from './ui/EffortIcon';
import { optionChoices } from './ui/OptionIcon';
import { Button, Chip, IconButton, Popup, PopupMarks, Segments } from './ui/Controls';
import { TextArea, TextInput } from './ui/Input';
import { PopupClose } from './ui/PopupClose';
import styles from './CrewEditor.module.css';
import { MenuItem, MenuPopover, MenuSeparator } from './ui/Popover';
/** Crew tree geometry (spec/crew-templates-and-editor#crew-editor): root 180×34, nodes 104×54, 10 px between nodes, 100 px between levels. */
const NODE_W = 104,
	NODE_H = 54,
	ROOT_W = 180,
	ROOT_H = 34,
	GAP = 10,
	LEVEL = 100,
	TOP = 8,
	ROOT_BUS = 30;
type Placed = {
	agent: CrewAgent;
	x: number;
	y: number;
	w: number;
	h: number;
	depth: number;
	parent: CrewAgent | null;
	slot?: boolean;
};
function layout(root: CrewAgent): { nodes: Placed[]; width: number; height: number } {
	const nodes: Placed[] = [];
	// A subtree is as wide as its children row; a root row also holds the «+ Agent» slot.
	const width = (agent: CrewAgent, isRoot: boolean): number => {
		const children = agent.agents ?? [];
		const own = isRoot ? ROOT_W : NODE_W;
		const row =
			children.reduce((sum, child) => sum + width(child, false), 0) +
			(children.length - 1) * GAP +
			(isRoot ? GAP + NODE_W : 0);
		return Math.max(own, row);
	};
	const place = (
		agent: CrewAgent,
		x: number,
		depth: number,
		parent: CrewAgent | null,
		isRoot: boolean
	) => {
		const total = width(agent, isRoot),
			own = isRoot ? ROOT_W : NODE_W,
			h = isRoot ? ROOT_H : NODE_H;
		nodes.push({
			agent,
			x: x + (total - own) / 2,
			y: TOP + (isRoot ? 0 : ROOT_H + ROOT_BUS + 28 + (depth - 1) * LEVEL),
			w: own,
			h,
			depth,
			parent,
		});
		const children = agent.agents ?? [];
		const rowWidth =
			children.reduce((sum, child) => sum + width(child, false), 0) +
			(children.length - 1) * GAP +
			(isRoot ? GAP + NODE_W : 0);
		let cursor = x + (total - rowWidth) / 2;
		for (const child of children) {
			const w = width(child, false);
			place(child, cursor, depth + 1, agent, false);
			cursor += w + GAP;
		}
		if (isRoot)
			nodes.push({
				agent: { id: '+slot', name: '+', template: null },
				x: cursor,
				y: TOP + ROOT_H + ROOT_BUS + 28,
				w: NODE_W,
				h: NODE_H,
				depth: 1,
				parent: agent,
				slot: true,
			});
	};
	place(root, 4, 0, null, true);
	return {
		nodes,
		width: Math.max(...nodes.map((node) => node.x + node.w)) + 4,
		height: Math.max(...nodes.map((node) => node.y + node.h)) + 40,
	};
}
export type CrewEditorProps = {
	template: CrewTemplate;
	library: CrewLibrary;
	locale: Locale;
	oneOff: boolean;
	/** spec/crew#compose: the crew of a running foreman — the foreman's own settings stay. */ rootLocked?: boolean;
	close(): void;
	done(template: CrewTemplate): void;
	libraryChanged(library: CrewLibrary): void;
};
/** spec/crew-templates-and-editor#crew-editor: the crew as a tree on the left, one node's fields on the right. */
export function CrewEditor({
	template: initial,
	library: initialLibrary,
	locale,
	oneOff,
	rootLocked = false,
	close,
	done,
	libraryChanged,
}: CrewEditorProps) {
	const dialog = useRef<HTMLDialogElement>(null),
		nameInput = useRef<HTMLInputElement>(null);
	const [template, setTemplate] = useState<CrewTemplate>(initial),
		[library, setLibrary] = useState(initialLibrary);
	const [selected, setSelected] = useState<string | null>(
			initial.root.agents?.[0]?.id ?? initial.root.id
		),
		[focusName, setFocusName] = useState(false);
	const addAnchor = useRef<HTMLElement | null>(null),
		checkAnchor = useRef<HTMLElement | null>(null);
	const [addTarget, setAddTarget] = useState<string | null>(null),
		[addFrom, setAddFrom] = useState<'tree' | 'inspector'>('tree'),
		[checkTarget, setCheckTarget] = useState<string | null>(null),
		[dragging, setDragging] = useState<string | null>(null),
		[dropTarget, setDropTarget] = useState<string | null>(null),
		[hover, setHover] = useState<string | null>(null);
	const [catalogs, setCatalogs] = useState<Record<string, ProviderCatalog | null>>({}),
		[error, setError] = useState(''),
		[busy, setBusy] = useState(false),
		[instructionsOpen, setInstructionsOpen] = useState(false);
	// spec/agents-and-providers#catalog: the library's built-ins carry the person's provider, model and effort.
	const lookup = useMemo(() => templateLookup(library.agents), [library]);
	const issues = useMemo(() => crewIssues(template, lookup), [template, lookup]);
	const placed = useMemo(() => layout(template.root), [template]);
	const agent = selected ? findCrewAgent(template.root, selected) : null,
		parent = agent ? crewParent(template.root, agent.id) : null,
		isRoot = agent?.id === template.root.id;
	const resolvedTemplate = agent && agent.template ? lookup(agent.template) : undefined;
	const provider: AgentProvider = agent?.provider ?? resolvedTemplate?.provider ?? 'claude';
	useEffect(() => {
		const node = dialog.current!;
		node.showModal();
		const previous = document.activeElement;
		return () => {
			node.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);
	useEffect(() => {
		for (const p of ['claude', 'codex'] as const)
			if (!(p in catalogs))
				void window.brigadir.readProviderCatalog(p).then(
					(catalog) => setCatalogs((current) => ({ ...current, [p]: catalog })),
					() => setCatalogs((current) => ({ ...current, [p]: null }))
				);
	}, []);
	useLayoutEffect(() => {
		if (focusName) {
			nameInput.current?.focus();
			nameInput.current?.select();
			setFocusName(false);
		}
	}, [focusName]);
	const catalog = catalogs[provider] ?? null;
	const change = (next: CrewTemplate) => {
		setTemplate(next);
		setError('');
	};
	const effective = (key: string): { value: string | boolean | undefined; own: boolean } => {
		const own = agent?.choices?.configOptions?.[key];
		if (own !== undefined) return { value: own, own: true };
		return { value: resolvedTemplate?.choices?.configOptions?.[key], own: false };
	};
	const setChoice = (key: string, value: string | boolean | undefined) => {
		if (!agent) return;
		const options = { ...agent.choices?.configOptions };
		if (value === undefined) delete options[key];
		else options[key] = value;
		// spec/agents-and-providers#catalog: a new model keeps its node's effort only when that model has the level.
		const effortId = effortOption?.id,
			dropEffort =
				key === modelOption?.id &&
				!!effortId &&
				options[effortId] !== undefined &&
				!selectOption(catalogOptions(catalog, value), 'effort')?.choices.some(
					(choice) => choice.value === options[effortId]
				);
		if (dropEffort) delete options[effortId!];
		const choices: import('@brigadir/core').CrewChoices = {
			...agent.choices,
			configOptions: options,
		};
		if (!Object.keys(options).length) delete choices.configOptions;
		const names = { ...agent.choiceNames };
		if (dropEffort) delete names[effortId!];
		const option = catalogOptions(catalog, modelOption ? options[modelOption.id] : undefined).find(
			(item) => item.id === key
		);
		if (option?.kind === 'select' && typeof value === 'string')
			names[key] = option.choices.find((choice) => choice.value === value)?.name ?? value;
		else delete names[key];
		change(
			updateCrewAgent(template, agent.id, {
				choices: Object.keys(choices).length ? choices : undefined,
				choiceNames: Object.keys(names).length ? names : undefined,
			})
		);
	};
	const modelOption: AgentOption | undefined = selectOption(catalog?.options ?? [], 'model'),
		modeOption = catalog?.options.find(
			(option) => agentOptionKind(option) === 'mode' && option.kind === 'select'
		);
	// spec/agents-and-providers#catalog: the effort levels of the node's model, not of the catalog's default one.
	const effortOption: AgentOption | undefined = selectOption(
		catalogOptions(catalog, modelOption ? effective(modelOption.id).value : undefined),
		'effort'
	);
	const choiceLabel = (key: string, fallbackNames: Record<string, string> | undefined) => {
		const { value } = effective(key);
		if (value === undefined) return null;
		const option = catalog?.options.find((item) => item.id === key);
		return option?.kind === 'select'
			? (option.choices.find((choice) => choice.value === value)?.name ?? String(value))
			: (agent?.choiceNames?.[key] ?? fallbackNames?.[key] ?? String(value));
	};
	const addAgent = (parentId: string, templateId: string | null) => {
		const source = templateId ? lookup(templateId) : undefined;
		const id = crypto.randomUUID();
		change(
			addCrewAgent(template, parentId, {
				id,
				name: source ? crewLabel(locale, source.name) : t(locale, 'Agent'),
				template: templateId,
			})
		);
		setSelected(id);
		setAddTarget(null);
		setFocusName(true);
	};
	const remove = (id: string) => {
		const next = removeCrewAgent(template, id);
		change(next);
		setSelected(crewParent(template.root, id)?.id ?? next.root.id);
	};
	const templateItems = (parentId: string) => (
		<>
			{[developerTemplateId, reviewerTemplateId, foremanTemplateId].map((id) => {
				const item = lookup(id)!;
				return (
					<MenuItem
						key={id}
						icon={
							<Glyph
								name={
									id === foremanTemplateId
										? 'helmet'
										: item.provider === 'codex'
											? 'openai'
											: 'claude'
								}
								size={12}
							/>
						}
						tail={id === foremanTemplateId ? t(locale, 'For a branch') : undefined}
						onSelect={() => addAgent(parentId, id)}>
						{crewLabel(locale, item.name)}
					</MenuItem>
				);
			})}
			{library.agents.some((item) => !item.builtin) && <MenuSeparator />}
			{library.agents
				.filter((item) => !item.builtin)
				.map((item) => (
					<MenuItem
						key={item.id}
						icon={<Glyph name={item.provider === 'codex' ? 'openai' : 'claude'} size={12} />}
						tail={
							<>
								<Glyph name="edit" size={11} /> {item.choiceNames?.model ?? ''}
							</>
						}
						onSelect={() => addAgent(parentId, item.id)}>
						{item.name}
					</MenuItem>
				))}
			<MenuSeparator />
			<MenuItem
				icon={<span className={styles.menuSpace} />}
				onSelect={() => addAgent(parentId, null)}>
				{t(locale, 'Empty agent…')}
			</MenuItem>
		</>
	);
	const providerGlyph = (node: CrewAgent): ReactNode => {
		const role = crewAgentRole(node, lookup, node.id === template.root.id);
		if (role === 'foreman') return <Glyph name="helmet" size={11} />;
		const p =
			node.provider ?? (node.template ? lookup(node.template)?.provider : undefined) ?? 'claude';
		return <Glyph name={p === 'codex' ? 'openai' : 'claude'} size={11} />;
	};
	const nodeModel = (node: CrewAgent) => {
		const source = node.template ? lookup(node.template) : undefined;
		const key = Object.keys({
			...source?.choices?.configOptions,
			...node.choices?.configOptions,
		}).find((id) => /model/i.test(id));
		return key ? (node.choiceNames?.[key] ?? source?.choiceNames?.[key] ?? '') : '';
	};
	const dropCheck = (from: string, to: string) => {
		if (from === to) return;
		const source = findCrewAgent(template.root, from),
			target = findCrewAgent(template.root, to);
		if (!source || !target) return;
		const sourceRole = crewAgentRole(source, lookup),
			targetRole = crewAgentRole(target, lookup);
		try {
			if (sourceRole === 'reviewer' && targetRole === 'developer')
				change(addCrewCheck(template, to, from));
			else if (sourceRole === 'developer' && targetRole === 'reviewer')
				change(addCrewCheck(template, from, to));
			else setError(t(locale, 'The plan does not match the crew.'));
		} catch {
			// spec/notifications-slack-notes-and-schedules#message-classes: addCrewCheck refuses only agents of different parents here (`from === to` returned above).
			setError(t(locale, 'Could not add the check: the agents are under different leads.'));
		}
	};
	async function saveCrew() {
		setBusy(true);
		setError('');
		try {
			const stored = {
				...template,
				id:
					template.builtin ||
					(oneOff &&
						template.id === initial.id &&
						library.crews.find((item) => item.id === template.id)?.builtin)
						? crypto.randomUUID()
						: template.id,
				builtin: false,
			};
			const next = await window.brigadir.saveCrewTemplate(stored);
			setLibrary(next);
			libraryChanged(next);
			setTemplate(stored);
		} catch {
			setError(t(locale, 'The template could not be saved.'));
		} finally {
			setBusy(false);
		}
	}
	async function saveAgentTemplate() {
		if (!agent) return;
		setBusy(true);
		setError('');
		try {
			const source = agent.template ? lookup(agent.template) : undefined;
			const item: AgentTemplate = {
				id: crypto.randomUUID(),
				name: crewName(agent.name),
				role: crewAgentRole(agent, lookup),
				builtin: false,
				...(crewSummary(agent, lookup) ? { summary: crewSummary(agent, lookup) } : {}),
				instructions: [source?.instructions ?? '', agent.extraInstructions ?? '']
					.filter(Boolean)
					.join('\n\n'),
				...(agent.provider || source?.provider
					? { provider: agent.provider ?? source!.provider! }
					: {}),
				...(agent.choices || source?.choices
					? {
							choices: {
								...source?.choices,
								...agent.choices,
								configOptions: {
									...source?.choices?.configOptions,
									...agent.choices?.configOptions,
								},
							},
						}
					: {}),
				...(agent.choiceNames || source?.choiceNames
					? { choiceNames: { ...source?.choiceNames, ...agent.choiceNames } }
					: {}),
			};
			const next = await window.brigadir.saveAgentTemplate(item);
			setLibrary(next);
			libraryChanged(next);
			change(
				updateCrewAgent(template, agent.id, {
					template: item.id,
					extraInstructions: undefined,
					summary: undefined,
					provider: undefined,
					choices: undefined,
					choiceNames: undefined,
				})
			);
		} catch {
			setError(t(locale, 'The template could not be saved.'));
		} finally {
			setBusy(false);
		}
	}
	async function saveBranch() {
		if (!agent) return;
		setBusy(true);
		setError('');
		try {
			const branch = branchAsCrewTemplate(
				template,
				agent.id,
				crypto.randomUUID(),
				crewName(agent.name)
			);
			const next = await window.brigadir.saveCrewTemplate(branch);
			setLibrary(next);
			libraryChanged(next);
		} catch {
			setError(t(locale, 'The template could not be saved.'));
		} finally {
			setBusy(false);
		}
	}
	/** Amber dashed path from the checker down, across and up into the checked node (crew tree geometry). */
	// Every check edge gets its own lane below the row (6 px apart) and its × sits to the right of the target's drop, spaced per incoming edge: two edges never overlap their handles.
	const edgeList = useMemo(
		() =>
			placed.nodes.flatMap((target) =>
				(target.agent.checkedBy ?? []).map((checkerId, incoming) => ({
					checkerId,
					targetId: target.agent.id,
					incoming,
				}))
			),
		[placed]
	);
	const edgePath = (checkerId: string, targetId: string) => {
		const checker = placed.nodes.find((node) => node.agent.id === checkerId),
			target = placed.nodes.find((node) => node.agent.id === targetId);
		if (!checker || !target) return null;
		const index = edgeList.findIndex(
				(edge) => edge.checkerId === checkerId && edge.targetId === targetId
			),
			lane = index < 0 ? edgeList.length : index,
			incoming = index < 0 ? (target.agent.checkedBy?.length ?? 0) : edgeList[index]!.incoming;
		const y = Math.max(target.y, checker.y) + NODE_H + 30 + lane * 6,
			from = checker.x + checker.w / 2,
			to = target.x + target.w / 2 + 10;
		return {
			d: `M${from} ${checker.y + checker.h} V ${y} H ${to} V ${target.y + target.h + 2}`,
			mid: { x: to + Math.sign(from - to || 1) * (18 + incoming * 20), y },
			from,
			to,
		};
	};
	const previewEdge = (() => {
		if (!dragging || !dropTarget || dragging === dropTarget) return null;
		const source = findCrewAgent(template.root, dragging),
			target = findCrewAgent(template.root, dropTarget);
		if (
			!source ||
			!target ||
			crewParent(template.root, dragging) !== crewParent(template.root, dropTarget)
		)
			return null;
		const sourceRole = crewAgentRole(source, lookup),
			targetRole = crewAgentRole(target, lookup);
		if (sourceRole === 'reviewer' && targetRole === 'developer')
			return target.checkedBy?.includes(source.id) ? null : edgePath(source.id, target.id);
		if (sourceRole === 'developer' && targetRole === 'reviewer')
			return source.checkedBy?.includes(target.id) ? null : edgePath(target.id, source.id);
		return null;
	})();
	const depth = crewDepth(template.root),
		count = crewAgents(template.root).length - 1;
	const siblings = parent?.agents ?? [],
		reviewers = siblings.filter(
			(item) => item.id !== agent?.id && crewAgentRole(item, lookup) === 'reviewer'
		);
	const agentRole = agent ? crewAgentRole(agent, lookup, isRoot) : 'developer',
		isLead = !isRoot && agentRole === 'foreman';
	const depthWarning = depth > crewRecommendedDepth;
	return (
		<dialog
			ref={dialog}
			className={styles.dialog}
			aria-label={t(locale, 'Crew')}
			onCancel={(event) => {
				event.preventDefault();
				if (addTarget || checkTarget) {
					setAddTarget(null);
					setCheckTarget(null);
					return;
				}
				close();
			}}>
			<header className={styles.header} data-size="m">
				<span className={styles.title}>{t(locale, 'Crew')}</span>
				<TextInput
					aria-label={`${t(locale, 'Crew')} · ${t(locale, 'Name')}`}
					className={styles.crewName}
					value={crewLabel(locale, template.name)}
					maxLength={80}
					onChange={(event) => change({ ...template, name: event.target.value })}
				/>
				{oneOff && (
					<small className={styles.cap}>
						{t(locale, 'Crew').toLocaleLowerCase(locale)} ·{' '}
						{template.builtin
							? t(locale, 'built-in · read only').split(' · ')[0]
							: t(locale, 'own')}
					</small>
				)}
				<span className={styles.space} />
				<small className={styles.cap} data-crew-summary>
					{t(locale, 'Foreman').toLocaleLowerCase(locale)} + {crewAgentCountLabel(locale, count)} ·{' '}
					{crewLevelCountLabel(locale, depth)}
				</small>
				<PopupClose locale={locale} close={close} />
			</header>
			<div className={styles.body}>
				<div
					className={styles.tree}
					onPointerDown={(event) => {
						if (event.target === event.currentTarget) {
							setSelected(null);
							setAddTarget(null);
						}
					}}>
					<div
						className={styles.canvas}
						style={{ width: placed.width, height: placed.height + edgeList.length * 6 }}>
						<svg
							className={styles.wires}
							width={placed.width}
							height={placed.height + edgeList.length * 6}
							aria-hidden="true">
							<defs>
								<marker
									id="crew-arrow"
									markerWidth="7"
									markerHeight="7"
									refX="3.5"
									refY="6"
									orient="auto">
									<path d="M0,7 L3.5,0 L7,7 Z" fill="var(--amber)" />
								</marker>
							</defs>
							{placed.nodes
								.filter(
									(node) =>
										(node.agent.agents?.length || node.agent.id === template.root.id) && !node.slot
								)
								.map((node) => {
									const children = placed.nodes.filter((child) => child.parent === node.agent);
									if (!children.length) return null;
									const cx = node.x + node.w / 2,
										bottom = node.y + node.h,
										bus = children[0]!.y - 28,
										xs = children.map((child) => child.x + child.w / 2);
									const lead = node.agent.id !== template.root.id;
									return (
										<g
											key={node.agent.id}
											stroke={lead ? 'var(--accent)' : 'var(--fg3)'}
											fill="none"
											strokeWidth="1">
											<path d={`M${cx} ${bottom} V ${bus}`} />
											<path d={`M${Math.min(cx, ...xs)} ${bus} H ${Math.max(cx, ...xs)}`} />
											{children.map((child) => (
												<path
													key={child.agent.id}
													d={`M${child.x + child.w / 2} ${bus} V ${child.y}`}
													strokeDasharray={child.slot ? '3 3' : undefined}
												/>
											))}
										</g>
									);
								})}
							{placed.nodes.flatMap((target) =>
								(target.agent.checkedBy ?? []).map((checkerId) => {
									const edge = edgePath(checkerId, target.agent.id);
									return edge ? (
										<path
											key={`${checkerId}-${target.agent.id}`}
											d={edge.d}
											stroke="var(--amber)"
											strokeWidth="1.2"
											strokeDasharray="4 3"
											fill="none"
											markerEnd="url(#crew-arrow)"
										/>
									) : null;
								})
							)}
							{previewEdge && (
								<path
									data-crew-edge-preview
									d={previewEdge.d}
									stroke="var(--amber)"
									strokeWidth="1.2"
									strokeDasharray="4 3"
									fill="none"
									opacity=".45"
									markerEnd="url(#crew-arrow)"
								/>
							)}
						</svg>
						{placed.nodes.flatMap((target) =>
							(target.agent.checkedBy ?? []).map((checkerId) => {
								const edge = edgePath(checkerId, target.agent.id);
								if (!edge) return null;
								const checker = findCrewAgent(template.root, checkerId);
								return (
									<div
										key={`handle-${checkerId}-${target.agent.id}`}
										className={styles.edgeHit}
										style={{
											left: Math.min(edge.from, edge.to),
											top: edge.mid.y - 12,
											width: Math.abs(edge.to - edge.from),
										}}>
										<IconButton
											size="s"
											appearance="warning"
											variant="soft"
											className={styles.edgeRemove}
											data-crew-edge-remove={`${checkerId}-${target.agent.id}`}
											label={`${t(locale, 'Remove check')} · ${crewLabel(locale, checker?.name ?? '')} → ${crewLabel(locale, target.agent.name)}`}
											style={{
												left:
													Math.min(
														Math.max(edge.mid.x, Math.min(edge.from, edge.to) + 12),
														Math.max(edge.from, edge.to) - 12
													) -
													Math.min(edge.from, edge.to) -
													12,
											}}
											onClick={() => change(removeCrewCheck(template, target.agent.id, checkerId))}>
											<Glyph name="close" size={9} />
										</IconButton>
									</div>
								);
							})
						)}
						{placed.nodes.map((node) => {
							if (node.slot)
								return (
									<div key="slot" className={styles.slotWrap} style={{ left: node.x, top: node.y }}>
										<button
											type="button"
											className={styles.slot}
											data-crew-add-slot
											aria-haspopup="menu"
											aria-expanded={addTarget === template.root.id}
											onClick={(event) => {
												addAnchor.current = event.currentTarget;
												setAddFrom('tree');
												setAddTarget((current) =>
													current === template.root.id ? null : template.root.id
												);
											}}>
											<Glyph name="plus" size={12} />
											<span>{t(locale, 'Agent')}</span>
										</button>
									</div>
								);
							const role = crewAgentRole(node.agent, lookup, node.depth === 0),
								isSelected = selected === node.agent.id,
								source = node.agent.template ? lookup(node.agent.template) : undefined,
								children = node.agent.agents?.length ?? 0;
							const sub = [
								role === 'foreman' && node.depth > 0
									? crewLabel(locale, 'Foreman')
									: source
										? crewLabel(locale, source.name)
										: t(locale, 'Agent'),
								nodeModel(node.agent),
								role === 'foreman' && children ? subordinateCount(locale, children) : '',
							]
								.filter(Boolean)
								.join(' · ');
							return (
								<div
									key={node.agent.id}
									className={styles.nodeWrap}
									style={{
										left: node.x,
										top: node.y,
										width: node.w,
										height: node.h + (node.depth > 0 ? 26 : 0),
									}}
									onPointerEnter={() => setHover(node.agent.id)}
									onPointerLeave={() =>
										setHover((current) => (current === node.agent.id ? null : current))
									}>
									<button
										type="button"
										className={styles.node}
										data-crew-node={node.agent.id}
										data-root={node.depth === 0}
										data-role={role}
										data-selected={isSelected}
										data-dragging={dragging === node.agent.id}
										draggable={node.depth > 0}
										onDragStart={(event) => {
											setDragging(node.agent.id);
											event.dataTransfer.setData('text/plain', node.agent.id);
											event.dataTransfer.effectAllowed = 'link';
										}}
										onDragEnd={() => {
											setDragging(null);
											setDropTarget(null);
										}}
										onDragOver={(event) => {
											if (dragging && dragging !== node.agent.id && node.depth > 0) {
												event.preventDefault();
												event.dataTransfer.dropEffect = 'link';
												if (dropTarget !== node.agent.id) setDropTarget(node.agent.id);
											}
										}}
										onDragLeave={() =>
											setDropTarget((current) => (current === node.agent.id ? null : current))
										}
										onDrop={(event) => {
											event.preventDefault();
											const from = event.dataTransfer.getData('text/plain') || dragging;
											if (from) dropCheck(from, node.agent.id);
											setDragging(null);
											setDropTarget(null);
										}}
										onClick={() => {
											setSelected(node.agent.id);
											setAddTarget(null);
										}}
										title={crewName(node.agent.name)}>
										<span className={styles.nodeTitle}>
											{providerGlyph(node.agent)}
											<strong>{crewLabel(locale, node.agent.name)}</strong>
											{node.depth === 0 && (
												<>
													<span className={styles.space} />
													<Glyph
														name={
															(node.agent.provider ?? source?.provider ?? 'claude') === 'codex'
																? 'openai'
																: 'claude'
														}
														size={12}
													/>
													<code>{nodeModel(node.agent)}</code>
												</>
											)}
										</span>
										{node.depth > 0 && <span className={styles.nodeSub}>{sub}</span>}
									</button>
									{node.depth > 0 &&
										(hover === node.agent.id || isSelected || addTarget === node.agent.id) &&
										role !== 'reviewer' && (
											<IconButton
												size="s"
												appearance="primary"
												variant="soft"
												className={styles.addChild}
												data-crew-add-child={node.agent.id}
												label={`${t(locale, 'Subordinates')} · ${crewLabel(locale, node.agent.name)}`}
												aria-haspopup="menu"
												aria-expanded={addTarget === node.agent.id}
												onClick={(event) => {
													event.stopPropagation();
													addAnchor.current = event.currentTarget;
													setAddFrom('tree');
													setAddTarget((current) =>
														current === node.agent.id ? null : node.agent.id
													);
												}}>
												<Glyph name="plus" size={10} />
											</IconButton>
										)}
								</div>
							);
						})}
					</div>
					<div className={styles.legend}>
						<div className={styles.legendRow}>
							<span className={styles.legendSolid} />
							<span>{t(locale, 'delegates and accepts')}</span>
							<span className={styles.legendDashed} />
							<span>{t(locale, 'checks directly, up to 2 rounds, then up')}</span>
						</div>
						<small>
							{t(
								locale,
								'«+» under an agent adds a subordinate. Drag an agent onto an agent to add a check.'
							)}
						</small>
						{depthWarning && (
							<small className={styles.warn}>
								{t(
									locale,
									'A branch deeper than two levels. Each level is one more relay and one more context.'
								)}
							</small>
						)}
					</div>
				</div>
				{/* spec/crew-templates-and-editor#editor-inspector: in the model, effort, mode and agent template popups the chosen value is ticked. */}
				<PopupMarks.Provider value>
					<aside className={styles.inspector} data-crew-inspector data-size="m">
						{!agent ? (
							<p className={styles.hint}>{t(locale, 'Select an agent in the tree')}</p>
						) : isRoot && rootLocked ? (
							<p className={styles.hint} data-crew-root-locked>
								{t(locale, 'The foreman is already working: its settings stay.')}
							</p>
						) : (
							<>
								<div className={styles.row}>
									<TextInput
										ref={nameInput}
										aria-label={t(locale, 'Name')}
										className={styles.nameField}
										value={crewLabel(locale, agent.name)}
										maxLength={80}
										disabled={busy}
										onChange={(event) => {
											try {
												change(renameCrewAgent(template, agent.id, event.target.value || ' '));
											} catch {
												change({
													...template,
													root: mapName(template.root, agent.id, event.target.value),
												});
											}
										}}
										onKeyDown={(event) => {
											if (event.key === 'Escape' && !agent.name.trim() && !isRoot) {
												event.preventDefault();
												remove(agent.id);
											}
										}}
									/>
									<Popup
										align="end"
										label={t(locale, 'Agent templates')}
										disabled={busy || isLead || isRoot}
										value={agent.template ?? ''}
										{...(isLead || isRoot
											? {
													icon: <Glyph name="helmet" size={10} />,
													displayValue: crewLabel(locale, 'Foreman'),
												}
											: !resolvedTemplate || resolvedTemplate.builtin
												? // The empty slot of a built-in stays in the list; the closed popup shows the name alone.
													{ icon: false }
												: {})}
										options={[
											...library.agents
												.filter((item) => item.role !== 'foreman')
												.map((item) => ({
													value: item.id,
													label: crewLabel(locale, item.name),
													// spec/crew-templates-and-editor#editor-inspector: names stand in one column; a built-in keeps the edit glyph's slot empty.
													icon: item.builtin ? (
														<span className={styles.glyphSlot} />
													) : (
														<Glyph name="edit" size={10} />
													),
												})),
											{
												value: '',
												label: t(locale, 'Empty agent…'),
												icon: <span className={styles.glyphSlot} />,
											},
										]}
										onChange={(value) =>
											change(updateCrewAgent(template, agent.id, { template: value || null }))
										}
									/>
									{isLead && (
										<small className={styles.cap} title={t(locale, 'has subordinates')}>
											{t(locale, 'has subordinates')}
										</small>
									)}
								</div>
								<div className={styles.row}>
									<span className={styles.label}>{t(locale, 'Provider')}</span>
									<Segments
										label={t(locale, 'Provider')}
										value={provider}
										options={[
											{ value: 'claude', label: 'Claude', icon: <Glyph name="claude" size={11} /> },
											{ value: 'codex', label: 'Codex', icon: <Glyph name="openai" size={11} /> },
										]}
										onChange={(value) =>
											change(
												updateCrewAgent(template, agent.id, {
													provider:
														value === (resolvedTemplate?.provider ?? 'claude') && !agent.provider
															? undefined
															: (value as AgentProvider),
													choices: undefined,
													choiceNames: undefined,
												})
											)
										}
									/>
									{agent.provider && <small className={styles.cap}>{t(locale, 'own')}</small>}
								</div>
								<div className={styles.row}>
									<span className={styles.label}>{t(locale, 'Model')}</span>
									{modelOption ? (
										<Popup
											align="end"
											label={t(locale, 'Model')}
											disabled={busy}
											value={String(effective(modelOption.id).value ?? '')}
											displayValue={
												choiceLabel(modelOption.id, resolvedTemplate?.choiceNames) ??
												t(locale, 'from the catalog')
											}
											options={
												modelOption.kind === 'select'
													? modelOption.choices.map((choice) => ({
															value: choice.value,
															label: choice.name,
														}))
													: []
											}
											onChange={(value) => setChoice(modelOption.id, value)}
										/>
									) : (
										<span
											className={styles.dim}
											title={t(locale, 'the catalog appears after the first launch')}>
											{Object.values({
												...resolvedTemplate?.choiceNames,
												...agent.choiceNames,
											})[0] ?? t(locale, 'the catalog appears after the first launch')}
										</span>
									)}
									{modelOption && effective(modelOption.id).own && (
										<small className={styles.cap}>{t(locale, 'own')}</small>
									)}
								</div>
								{/* spec/agents-and-providers#catalog: effort is its own row, the same popup as the model, with the level's icon. */}
								{effortOption && (
									<div className={styles.row}>
										<span className={styles.label}>{t(locale, 'Effort')}</span>
										<Popup
											align="end"
											label={t(locale, 'Effort')}
											disabled={busy}
											value={String(effective(effortOption.id).value ?? '')}
											displayValue={
												choiceLabel(effortOption.id, resolvedTemplate?.choiceNames) ?? '—'
											}
											options={
												effortOption.kind === 'select' ? effortOptions(effortOption.choices) : []
											}
											onChange={(value) => setChoice(effortOption.id, value)}
										/>
										{effective(effortOption.id).own && (
											<small className={styles.cap}>{t(locale, 'own')}</small>
										)}
									</div>
								)}
								{modeOption && (
									<div className={styles.row}>
										<span className={styles.label}>{t(locale, 'Mode')}</span>
										<Popup
											align="end"
											label={t(locale, 'Mode')}
											disabled={busy}
											value={String(effective(modeOption.id).value ?? '')}
											displayValue={
												choiceLabel(modeOption.id, resolvedTemplate?.choiceNames) ??
												t(locale, 'from the catalog')
											}
											options={
												modeOption.kind === 'select'
													? optionChoices('mode', modeOption.choices)
													: []
											}
											onChange={(value) => setChoice(modeOption.id, value)}
										/>
									</div>
								)}
								{!isRoot && (
									<div className={styles.row}>
										<span className={styles.label}>{t(locale, 'Zone')}</span>
										<TextInput
											aria-label={t(locale, 'Zone')}
											className={styles.zone}
											placeholder={
												parent?.zone?.length || parent !== template.root
													? t(locale, 'parent zone')
													: t(locale, 'whole project · name folders')
											}
											value={(agent.zone ?? []).join(', ')}
											disabled={busy}
											onChange={(event) => {
												const zone = event.target.value
													.split(',')
													.map((item) => item.trim())
													.filter(Boolean);
												change(
													updateCrewAgent(template, agent.id, {
														zone: zone.length ? zone : undefined,
													})
												);
											}}
										/>
									</div>
								)}
								{/* spec/crew-templates-and-editor#roster: one line the parent reads in the crew roster; the template's line shows as the placeholder. */}
								{!isRoot && (
									<div className={styles.row}>
										<span className={styles.label}>{t(locale, 'Specialty')}</span>
										<TextInput
											aria-label={t(locale, 'Specialty')}
											className={styles.summary}
											placeholder={
												(agent.template ? lookup(agent.template)?.summary : undefined) ||
												t(locale, 'What the foreman reads about this agent. In English.')
											}
											maxLength={crewSummaryLimit}
											value={agent.summary ?? ''}
											disabled={busy}
											onChange={(event) =>
												change(
													updateCrewAgent(template, agent.id, {
														summary: event.target.value.replace(/[\r\n]+/g, ' ') || undefined,
													})
												)
											}
										/>
									</div>
								)}
								{!isRoot && agentRole !== 'reviewer' && (
									<div className={styles.row} data-align="start">
										<span className={styles.label}>{t(locale, 'Subordinates')}</span>
										<div className={styles.chips}>
											{(agent.agents ?? []).map((child) => (
												<Chip key={child.id} tone="selected" onClick={() => setSelected(child.id)}>
													{crewLabel(locale, child.name)}
												</Chip>
											))}
											{!agent.agents?.length && (
												<small className={styles.dim}>{t(locale, 'none')}</small>
											)}
											<span className={styles.chipMenuWrap}>
												<Chip
													square
													aria-label={`${t(locale, 'Subordinates')} · +`}
													aria-haspopup="menu"
													aria-expanded={addTarget === agent.id}
													onClick={(event) => {
														addAnchor.current = event.currentTarget;
														setAddFrom('inspector');
														setAddTarget((current) => (current === agent.id ? null : agent.id));
													}}>
													<Glyph name="plus" size={10} />
												</Chip>
											</span>
										</div>
									</div>
								)}
								{!isRoot && (
									<div className={styles.row} data-align="start">
										<span className={styles.label}>{t(locale, 'Checked by')}</span>
										<div className={styles.chips}>
											{(agent.checkedBy ?? []).map((id) => {
												const checker = siblings.find((item) => item.id === id);
												return (
													<Chip
														key={id}
														tone="warning"
														aria-label={`${t(locale, 'Remove check')} · ${checker ? crewLabel(locale, checker.name) : id}`}
														title={t(locale, 'Remove check')}
														onClick={() => change(removeCrewCheck(template, agent.id, id))}>
														{checker ? crewLabel(locale, checker.name) : id}
														<Glyph name="close" size={8} />
													</Chip>
												);
											})}
											{!agent.checkedBy?.length && (
												<small className={styles.dim}>
													{isLead
														? t(locale, 'nobody · the foreman accepts the branch')
														: t(locale, 'nobody')}
												</small>
											)}
											{agentRole === 'developer' &&
												reviewers.some((item) => !agent.checkedBy?.includes(item.id)) && (
													<span className={styles.chipMenuWrap}>
														<Chip
															square
															aria-label={`${t(locale, 'Checked by')} · +`}
															aria-haspopup="menu"
															aria-expanded={checkTarget === agent.id}
															onClick={(event) => {
																checkAnchor.current = event.currentTarget;
																setCheckTarget((current) => (current ? null : agent.id));
															}}>
															<Glyph name="plus" size={10} />
														</Chip>
													</span>
												)}
										</div>
									</div>
								)}
								{isLead && (
									<p className={styles.leadNote}>
										{t(
											locale,
											'Has subordinates: it gets the foreman tools in its zone: split, delegate, read reports and diffs, accept. It writes no code itself. Remove the subordinates and the template comes back.'
										)}
									</p>
								)}
								<hr className={styles.sep} />
								{(resolvedTemplate || isRoot || isLead) && (
									<details
										className={styles.instructions}
										open={instructionsOpen}
										onToggle={(event) => setInstructionsOpen(event.currentTarget.open)}>
										<summary>
											<Glyph name="tree-right" size={9} />
											<span>
												{t(locale, 'Template instructions «{name}»').replace(
													'{name}',
													crewLabel(
														locale,
														(isLead || isRoot ? lookup(foremanTemplateId) : resolvedTemplate)
															?.name ?? ''
													)
												)}
											</span>
											<small>· {t(locale, 'read only')}</small>
										</summary>
										<p>
											{(isLead || isRoot ? lookup(foremanTemplateId) : resolvedTemplate)
												?.instructions ||
												t(locale, 'Instructions here add to the briefing, they do not replace it.')}
										</p>
									</details>
								)}
								<div className={styles.row}>
									<span className={styles.group}>
										{t(locale, 'Additionally for {name}').replace(
											'{name}',
											crewLabel(locale, agent.name)
										)}
									</span>
									<span className={styles.space} />
									<small className={styles.cap}>
										{isRoot
											? t(locale, 'Instructions here add to the briefing, they do not replace it.')
											: t(locale, 'only this agent')}
									</small>
								</div>
								<TextArea
									rows={2}
									aria-label={t(locale, 'Additionally for {name}').replace(
										'{name}',
										crewLabel(locale, agent.name)
									)}
									className={styles.extra}
									placeholder={t(
										locale,
										'What this agent does differently from the template. In English.'
									)}
									value={agent.extraInstructions ?? ''}
									disabled={busy}
									onChange={(event) =>
										change(
											updateCrewAgent(template, agent.id, {
												extraInstructions: event.target.value || undefined,
											})
										)
									}
								/>
								{!isRoot && (
									<div className={styles.row}>
										<Button
											size="s"
											appearance="primary"
											variant="ghost"
											disabled={busy}
											onClick={() => {
												void (isLead ? saveBranch() : saveAgentTemplate());
											}}>
											{t(locale, isLead ? 'Save branch as template' : 'Save as agent template')}
										</Button>
										<span className={styles.space} />
										<Button
											size="s"
											appearance="danger"
											variant="ghost"
											disabled={busy}
											onClick={() => remove(agent.id)}>
											{t(
												locale,
												agent.agents?.length ? 'Remove with subordinates' : 'Remove agent'
											)}
										</Button>
									</div>
								)}
							</>
						)}
					</aside>
				</PopupMarks.Provider>
			</div>
			<footer className={styles.footer} data-size="m">
				{(issues.length > 0 || error) && (
					<span className={styles.issue} role="alert">
						{error || crewIssueText(locale, issues[0]!)}
					</span>
				)}
				<span className={styles.space} />
				<Button
					disabled={busy || issues.length > 0}
					onClick={() => {
						void saveCrew();
					}}>
					{t(locale, 'Save as crew template')}
				</Button>
				<Button disabled={busy} onClick={close}>
					{t(locale, 'Cancel')}
				</Button>
				<Button
					appearance="primary"
					disabled={busy || issues.length > 0}
					onClick={() => done(template)}>
					{t(locale, 'Done')}
				</Button>
			</footer>
			<MenuPopover
				open={addTarget !== null}
				onClose={() => setAddTarget(null)}
				anchor={addAnchor}
				label={t(locale, 'Agent templates')}
				locale={locale}
				width={260}>
				{addTarget && templateItems(addTarget)}
			</MenuPopover>
			<MenuPopover
				open={checkTarget !== null && !!agent}
				onClose={() => setCheckTarget(null)}
				anchor={checkAnchor}
				label={t(locale, 'Checked by')}
				locale={locale}>
				{agent &&
					reviewers
						.filter((item) => !agent.checkedBy?.includes(item.id))
						.map((item) => (
							<MenuItem
								key={item.id}
								icon={providerGlyph(item)}
								onSelect={() => change(addCrewCheck(template, agent.id, item.id))}>
								{crewLabel(locale, item.name)}
							</MenuItem>
						))}
			</MenuPopover>
		</dialog>
	);
}
/** Keeps typing responsive while a name is temporarily empty or duplicated; issues block Done. */
function mapName(root: CrewAgent, id: string, name: string): CrewAgent {
	return root.id === id
		? { ...root, name }
		: {
				...root,
				...(root.agents ? { agents: root.agents.map((child) => mapName(child, id, name)) } : {}),
			};
}
