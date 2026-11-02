import { useEffect, useRef, useState } from 'react';
import {
	commitCount,
	localName,
	t,
	uncommittedCount,
	type BranchSwitchState,
	type LaunchSwitch,
	type Locale,
	type ScopeChoice,
} from '@brigadir/core';
import { BranchName } from './ui/BranchName';
import { Button, Popup, Segments, Switch } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { Popover } from './ui/Popover';
import { NewBranchForm, branchBases, branchTail, worktreeReason } from './BranchPicker';
import styles from './SheetBranches.module.css';
import { Spinner } from './ui/Loading';

const NEW = '\u0000new';
/** A chosen switch per repo; a repo left on its current branch has none. */
export type SheetSwitches = Record<string, LaunchSwitch>;

/**
 * spec/git#main-tree-branches: without isolation the sheet shows the current branch of each chosen git repo, and another one can be chosen;
 * the task switches to it at preparation. The list is the picker's (rule 17): groups, tails, the worktree reason.
 */
export function SheetBranches({
	projectId,
	projectName,
	scopes,
	locale,
	value,
	onChange,
	onCommitFirst,
	pullOff,
	onPullOff,
}: {
	projectId: string;
	projectName: string;
	scopes: ScopeChoice[];
	locale: Locale;
	value: SheetSwitches;
	onChange(next: SheetSwitches): void;
	onCommitFirst(scopeId: string): void;
	/** spec/git#pull: repos whose pull before the start the person turned off. */ pullOff: ReadonlySet<string>;
	onPullOff(scopeId: string, off: boolean): void;
}) {
	const [states, setStates] = useState<Record<string, BranchSwitchState | null>>({});
	const ids = scopes.map((scope) => scope.id).join();
	useEffect(() => {
		let active = true;
		for (const scope of scopes)
			if (!(scope.id in states)) {
				setStates((current) => ({ ...current, [scope.id]: null }));
				const load = (fetch: boolean) =>
					window.brigadir.readBranchSwitch(projectId, scope.id, fetch).then(
						(state) => {
							if (active) setStates((current) => ({ ...current, [scope.id]: state }));
						},
						() => {}
					);
				void load(false).then(() => load(true));
			}
		return () => {
			active = false;
		};
	}, [projectId, ids]);
	// A repo taken out of the task takes its switch with it.
	useEffect(() => {
		const kept = Object.fromEntries(
			Object.entries(value).filter(([id]) => scopes.some((scope) => scope.id === id))
		);
		if (Object.keys(kept).length !== Object.keys(value).length) onChange(kept);
	}, [ids]);
	if (!scopes.length) return null;
	return (
		<div className={styles.group} data-sheet-branches>
			<span className={styles.label}>{t(locale, 'Branch')}</span>
			{scopes.map((scope) => (
				<Row
					key={scope.id}
					scope={scope}
					name={scope.name === '.' ? projectName : scope.name}
					state={states[scope.id] ?? null}
					chosen={value[scope.id]}
					locale={locale}
					choose={(next) => {
						const { [scope.id]: _old, ...rest } = value;
						onChange(next ? { ...rest, [scope.id]: next } : rest);
					}}
					commitFirst={() => onCommitFirst(scope.id)}
					pull={!pullOff.has(scope.id)}
					setPull={(on) => onPullOff(scope.id, !on)}
				/>
			))}
		</div>
	);
}

function Row({
	scope,
	name,
	state,
	chosen,
	locale,
	choose,
	commitFirst,
	pull,
	setPull,
}: {
	scope: ScopeChoice;
	name: string;
	state: BranchSwitchState | null;
	chosen: LaunchSwitch | undefined;
	locale: Locale;
	choose(next: LaunchSwitch | null): void;
	commitFirst(): void;
	pull: boolean;
	setPull(on: boolean): void;
}) {
	const anchor = useRef<HTMLDivElement>(null),
		[creating, setCreating] = useState<{ name: string; base: string } | null>(null);
	const current = state?.current ?? null,
		held = state?.heldBy ?? null,
		branches = state?.branches ?? [];
	const target = chosen
		? chosen.create
			? chosen.branch
			: localName(
					branches.find((branch) => branch.name === chosen.branch) ?? {
						name: chosen.branch,
						remote: false,
					}
				)
		: current;
	const pulls =
		chosen && !chosen.create
			? (branches.find((branch) => branch.name === chosen.branch && !branch.remote)?.behind ?? 0)
			: 0;
	const options = [
		...branches.map((branch) => ({
			value: branch.name,
			label: branch.name,
			branch: true,
			group: branch.remote ? 'remote' : 'local',
			disabled: !!branch.worktree,
			...(branchTail(locale, branch) ? { tail: branchTail(locale, branch)! } : {}),
			...(branch.worktree ? { description: worktreeReason(locale, branch) } : {}),
		})),
		...(chosen?.create
			? [
					{
						value: chosen.branch,
						label: chosen.branch,
						branch: true,
						group: 'local',
						tail: t(locale, 'New branch'),
					},
				]
			: []),
		{ value: NEW, label: t(locale, 'New branch…'), icon: <Glyph name="plus" size={11} /> },
	];
	const pick = (value: string) => {
		if (value === NEW) {
			setCreating({
				name: '',
				base: branches.find((branch) => branch.current)?.upstream ?? current ?? 'main',
			});
			return;
		}
		if (value === current) {
			choose(null);
			return;
		}
		if (chosen?.create && value === chosen.branch) return;
		choose({ scopeId: scope.id, branch: value, ...(chosen?.dirty ? { dirty: chosen.dirty } : {}) });
	};
	const dirty = !!state?.dirty.length && !!chosen && !chosen.create;
	// spec/git#pull: staying on a branch that is behind origin — the start pulls it, unless the person turns it off.
	const behind = !chosen ? (branches.find((branch) => branch.current)?.behind ?? 0) : 0;
	const line = !chosen
		? null
		: chosen.create
			? t(locale, 'Before the start, {repo} switches to a new branch {to} from {from}.')
					.replace('{to}', chosen.branch)
					.replace('{from}', chosen.create.base)
			: pulls && !dirty
				? t(
						locale,
						'Before the start, {repo} switches from {from} to {to} and pulls {commits} from origin.'
					).replace('{commits}', commitCount(locale, pulls))
				: t(locale, 'Before the start, {repo} switches from {from} to {to}.');
	return (
		<div className={styles.repo} data-sheet-branch={scope.name}>
			<div ref={anchor} className={styles.row}>
				<span className={styles.repoName} title={name}>
					{name}
				</span>
				<div className={styles.popup} data-changed={!!chosen || undefined}>
					<Popup
						align="end"
						disabled={!state || !!held}
						label={t(locale, 'Branch of {repo}').replace('{repo}', name)}
						value={chosen?.branch ?? current ?? ''}
						displayValue={
							state ? target ? <BranchName name={target} /> : '—' : <Spinner size={10} />
						}
						search={{
							placeholder: t(locale, 'Search branches'),
							empty: t(locale, 'No branches match'),
							clear: t(locale, 'Clear the field'),
						}}
						groups={{
							local: { label: t(locale, 'Local branches') },
							remote: { label: t(locale, 'Remote branches') },
						}}
						options={options}
						onChange={pick}
					/>
				</div>
			</div>
			{held && (
				<p className={styles.line}>
					<Glyph name="scope-lock" size={11} />
					<span>
						{t(
							locale,
							'{repo} is held by the task {task}. You can change its branch here once it stops.'
						)
							.replace('{repo}', name)
							.replace('{task}', held.title)}
					</span>
				</p>
			)}
			{line && !held && (
				<p className={styles.line} data-switch-line>
					<Glyph name="sidebar-branch" size={11} />
					<span>
						{split(
							line
								.replace('{repo}', '\u0001')
								.replace('{from}', current ?? 'HEAD')
								.replace('{to}', '\u0002'),
							name,
							target ?? ''
						)}
					</span>
				</p>
			)}
			{behind > 0 && !held && (
				<div className={styles.pull} data-pull-line>
					<Glyph name="git-pull" size={11} />
					<span>
						{split(
							t(locale, 'Before the start, {repo} pulls {commits} from origin.')
								.replace('{repo}', '\u0001')
								.replace('{commits}', commitCount(locale, behind)),
							name,
							''
						)}
					</span>
					<Switch
						size="s"
						label={t(locale, 'Pull before the start')}
						checked={pull}
						onChange={setPull}
					/>
				</div>
			)}
			{dirty && !held && (
				<>
					<p className={styles.line} data-tone="amber">
						<Glyph name="review-warning" size={11} />
						<span>
							{split(
								t(locale, '{repo} has {changes}.')
									.replace('{repo}', '\u0001')
									.replace('{changes}', uncommittedCount(locale, state!.dirty.length)),
								name,
								''
							)}{' '}
							{t(locale, 'What to do with them before the start:')}
						</span>
					</p>
					{/* spec/tasks#sheet-rail: the choice is a row S, under its question. */}
					<div className={styles.dirtyRow} data-size="s">
						<Segments
							label={t(locale, 'What to do with them before the start:')}
							value={chosen!.dirty ?? 'stash'}
							options={[
								{ value: 'stash', label: t(locale, 'Stash') },
								{ value: 'carry', label: t(locale, 'Bring them') },
							]}
							onChange={(value) => choose({ ...chosen!, dirty: value as 'stash' | 'carry' })}
						/>
					</div>
					<div className={styles.commit} data-size="s">
						<Button
							size="s"
							variant="ghost"
							title={t(
								locale,
								'The task goes to the backlog with this branch, and the main tree opens on Changes.'
							)}
							onClick={commitFirst}>
							{t(locale, 'Commit first…')}
						</Button>
					</div>
				</>
			)}
			{creating && (
				<Popover
					open
					onClose={() => setCreating(null)}
					anchor={anchor}
					label={`${t(locale, 'New branch')} · ${name}`}
					locale={locale}
					width={300}
					align="end"
					initialFocus={(popover) => popover.querySelector('input')}>
					<NewBranchForm
						locale={locale}
						bases={branchBases(state)}
						name={creating.name}
						base={creating.base}
						action={t(locale, 'Create')}
						change={(name, base) => setCreating({ name, base })}
						cancel={() => setCreating(null)}
						submit={() => {
							choose({ scopeId: scope.id, branch: creating.name, create: { base: creating.base } });
							setCreating(null);
						}}
					/>
				</Popover>
			)}
		</div>
	);
}
/** The repo and the target in bold inside a translated sentence (\u0001 and \u0002 stand for them). */
function split(text: string, repo: string, target: string) {
	return text
		.split(/(\u0001|\u0002)/)
		.map((part, index) =>
			part === '\u0001' ? (
				<b key={index}>{repo}</b>
			) : part === '\u0002' ? (
				<b key={index}>{target}</b>
			) : (
				part
			)
		);
}
