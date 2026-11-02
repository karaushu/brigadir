import { useEffect, useRef, useState } from 'react';
import { Glyph } from './ui/Glyph';
import {
	diffBases,
	editorTypingKeys,
	indentStyles,
	indentWidths,
	projectFormatters,
	t,
	type AppSettings,
	type DiffBase,
	type IndentStyle,
	type Locale,
	type ProjectFormatter,
	type ProjectFormatterInfo,
	type ProjectIndent,
} from '@brigadir/core';
import { Button, Choice, Popup, Segments, Switch } from './ui/Controls';
import { notifyFormattersChanged } from './editor-format';
import { SettingsOption, SettingsRow, SettingsSection } from './SettingsForm';
import styles from './LayoutSettings.module.css';
const typingLabels = {
	languageServers: 'Language servers',
	closeBrackets: 'Bracket pairs',
	closeTags: 'Closing tags',
	callParens: 'Call parentheses',
} as const;
const formatterLabels: Record<
	ProjectFormatter,
	'As default' | 'Automatic' | 'Prettier' | 'Language server' | 'Off'
> = {
	default: 'As default',
	auto: 'Automatic',
	prettier: 'Prettier',
	'language-server': 'Language server',
	off: 'Off',
};
const indentLabels: Record<IndentStyle, 'Automatic' | 'Tabs' | 'Spaces'> = {
	auto: 'Automatic',
	tabs: 'Tabs',
	spaces: 'Spaces',
};
/** spec/editor#indentation: what a project's Prettier or .editorconfig says, after the Prettier version: `tabs, width 4`, `.editorconfig: spaces, width 2`. */
function indentNote(locale: Locale, indent: ProjectIndent, tabWidth: number | 'auto') {
	const width =
		indent.useTabs === false
			? (indent.indentSize ?? indent.tabWidth)
			: (indent.tabWidth ?? indent.indentSize);
	// A number in Settings overrules the project's width of a tab on screen; the line says so (spec/editor#indentation).
	const own =
		tabWidth !== 'auto' &&
		indent.tabWidth !== undefined &&
		indent.tabWidth !== tabWidth &&
		indent.useTabs !== false;
	const parts = [
		...(indent.useTabs === undefined ? [] : [t(locale, indent.useTabs ? 'tabs' : 'spaces')]),
		...(own
			? [t(locale, 'width {n} · your setting').replace('{n}', String(tabWidth))]
			: width === undefined
				? []
				: [t(locale, 'width {n}').replace('{n}', String(width))]),
	];
	return (indent.source === 'editorconfig' ? '.editorconfig: ' : '') + parts.join(', ');
}
/** spec/editor-code-intelligence#editor-settings Settings ▸ Editor: the diff base (spec/diff-and-review#diff-base), code aids (spec/editor-code-intelligence#typing-help), Git (line author spec/editor#line-author, .env in worktrees spec/git#worktree-env), the global format-on-save switch and one choice per project. */
export function EditorSettings({
	settings,
	locale,
	busy,
	update,
}: {
	settings: AppSettings;
	locale: Locale;
	busy: boolean;
	update(patch: Partial<AppSettings>): Promise<void>;
}) {
	const [projects, setProjects] = useState<ProjectFormatterInfo[] | null>(null),
		[failed, setFailed] = useState(false),
		[saveFailed, setSaveFailed] = useState(false),
		[saving, setSaving] = useState(false),
		mounted = useRef(true);
	const load = () => {
		setFailed(false);
		void window.brigadir.readFormatters().then(
			(list) => {
				if (mounted.current) setProjects(list);
			},
			() => {
				if (mounted.current) setFailed(true);
			}
		);
	};
	useEffect(() => {
		mounted.current = true;
		load();
		return () => {
			mounted.current = false;
		};
	}, []);
	async function choose(projectId: string, formatter: ProjectFormatter) {
		setSaving(true);
		setSaveFailed(false);
		try {
			const list = await window.brigadir.setProjectFormatter(projectId, formatter);
			if (mounted.current) setProjects(list);
			notifyFormattersChanged();
		} catch {
			if (mounted.current) setSaveFailed(true);
		} finally {
			if (mounted.current) setSaving(false);
		}
	}
	const options = projectFormatters.map((value) => ({
		value,
		label: t(locale, formatterLabels[value]),
	}));
	const base = (value: DiffBase) =>
		value === 'task'
			? {
					title: t(locale, 'Task start'),
					detail: t(locale, 'What changed since the task started.'),
				}
			: {
					title: t(locale, 'Last commit'),
					detail: t(locale, 'What is not committed yet, as in git status.'),
				};
	return (
		<>
			<SettingsSection title={t(locale, 'Diff base')} role="radiogroup">
				{diffBases.map((value) => (
					<SettingsOption
						key={value}
						{...base(value)}
						icon={<Glyph name={value === 'task' ? 'base-task' : 'base-head'} size={14} />}>
						<Choice
							type="radio"
							name="diff-base"
							label={base(value).title}
							disabled={busy}
							checked={settings.editor.diffBase === value}
							onChange={() => {
								void update({ editor: { ...settings.editor, diffBase: value } });
							}}
						/>
					</SettingsOption>
				))}
			</SettingsSection>
			{/* spec/editor-code-intelligence#typing-help: without a language server completions have no kind, so call parentheses wait for one. */}
			<SettingsSection title={t(locale, 'Code')} disabled={busy}>
				{editorTypingKeys.map((key) => {
					const label = t(locale, typingLabels[key]),
						off = key === 'callParens' && !settings.editor.languageServers;
					return (
						<SettingsRow key={key} label={label}>
							<Switch
								label={label}
								checked={settings.editor[key]}
								disabled={busy || off}
								onChange={(value) => {
									void update({ editor: { ...settings.editor, [key]: value } });
								}}
							/>
						</SettingsRow>
					);
				})}
			</SettingsSection>
			{/* spec/editor#indentation: the project's Prettier or .editorconfig overrules these for its files; the Projects group says where that happens. */}
			<SettingsSection title={t(locale, 'Indentation')} disabled={busy}>
				<SettingsRow label={t(locale, 'Indent style')}>
					<Segments
						label={t(locale, 'Indent style')}
						value={settings.editor.indentStyle}
						disabled={busy}
						options={indentStyles.map((value) => ({
							value,
							label: t(locale, indentLabels[value]),
						}))}
						onChange={(value) => {
							void update({ editor: { ...settings.editor, indentStyle: value as IndentStyle } });
						}}
					/>
				</SettingsRow>
				<SettingsRow
					label={t(locale, 'Indent size')}
					inactive={settings.editor.indentStyle === 'tabs'}>
					<Segments
						label={t(locale, 'Indent size')}
						value={String(settings.editor.indentSize)}
						disabled={busy || settings.editor.indentStyle === 'tabs'}
						options={indentWidths.map((value) => ({ value: String(value), label: String(value) }))}
						onChange={(value) => {
							void update({ editor: { ...settings.editor, indentSize: Number(value) } });
						}}
					/>
				</SettingsRow>
				<SettingsRow label={t(locale, 'Tab width')}>
					<Segments
						label={t(locale, 'Tab width')}
						value={String(settings.editor.tabWidth)}
						disabled={busy}
						options={[
							{ value: 'auto', label: t(locale, 'Auto') },
							...indentWidths.map((value) => ({ value: String(value), label: String(value) })),
						]}
						onChange={(value) => {
							void update({
								editor: { ...settings.editor, tabWidth: value === 'auto' ? 'auto' : Number(value) },
							});
						}}
					/>
				</SettingsRow>
			</SettingsSection>
			{/* spec/editor#line-author: the line author after the caret line; Editor ▸ Show line author is the same switch. */}
			<SettingsSection title={t(locale, 'Git')} disabled={busy}>
				<SettingsRow label={t(locale, 'Line author')}>
					<Switch
						label={t(locale, 'Line author')}
						checked={settings.editor.lineAuthor}
						disabled={busy}
						onChange={(value) => {
							void update({ editor: { ...settings.editor, lineAuthor: value } });
						}}
					/>
				</SettingsRow>
				{/* spec/git#worktree-env: the default of «Copy .env» in the New task sheet. */}
				<SettingsRow
					label={t(locale, 'Copy .env')}
					hint={t(locale, 'Ignored .env files go into a new worktree.')}>
					<Switch
						label={t(locale, 'Copy .env')}
						checked={settings.agents.copyEnvFiles}
						disabled={busy}
						onChange={(copyEnvFiles) => {
							void update({ agents: { ...settings.agents, copyEnvFiles } });
						}}
					/>
				</SettingsRow>
			</SettingsSection>
			<SettingsSection title={t(locale, 'Formatting')} disabled={busy}>
				<SettingsRow label={t(locale, 'On save')}>
					<Switch
						label={t(locale, 'On save')}
						checked={settings.editor.format === 'auto'}
						disabled={busy}
						onChange={(value) => {
							void update({ editor: { ...settings.editor, format: value ? 'auto' : 'off' } }).then(
								notifyFormattersChanged
							);
						}}
					/>
				</SettingsRow>
			</SettingsSection>
			{projects && projects.length > 0 && (
				<SettingsSection
					title={t(locale, 'Projects')}
					disabled={busy || saving}
					warning={saveFailed}
					footnote={
						saveFailed ? (
							<span role="alert">{t(locale, 'Could not save the formatter.')}</span>
						) : undefined
					}>
					{projects.map((project) => (
						<SettingsRow
							key={project.projectId}
							label={project.name}
							hint={[
								project.prettier
									? t(locale, 'Prettier {version}').replace('{version}', project.prettier)
									: t(locale, 'Prettier not found'),
								...(project.indent
									? [indentNote(locale, project.indent, settings.editor.tabWidth)]
									: []),
							]
								.filter(Boolean)
								.join(' · ')}>
							<Popup
								label={t(locale, 'Formatter for {project}').replace('{project}', project.name)}
								disabled={busy || saving}
								value={project.formatter}
								options={options}
								onChange={(value) => {
									void choose(project.projectId, value as ProjectFormatter);
								}}
							/>
						</SettingsRow>
					))}
				</SettingsSection>
			)}
			{failed && !projects && (
				<div className={styles.loadError}>
					<p role="alert">{t(locale, 'The formatters could not be loaded.')}</p>
					<Button onClick={load}>{t(locale, 'Retry')}</Button>
				</div>
			)}
		</>
	);
}
