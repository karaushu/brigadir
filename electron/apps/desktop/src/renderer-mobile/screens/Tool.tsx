/**
 * spec/remote-access-and-mobile#phone-task-tools: the task's tools under its chat — Changes and a file's diff, the pull request, the files and
 * one file, the terminal.
 */
import { t, type Locale } from '@brigadir/core';
import { BackButton, NavBar } from '../ui/Nav';
import { back, type Tool as ToolName } from '../router';
import { useMobile } from '../store';
import { ChangeDiff, ChangesList } from '../tools/Changes';
import { PullRequest } from '../tools/PullRequest';
import { Files } from '../tools/Files';
import { Code } from '../tools/Code';
import { Terminal } from '../tools/Terminal';
import s from './Screen.module.css';

export function Tool({
	projectId,
	taskId,
	tool,
	item,
	locale,
}: {
	projectId: string;
	taskId: string;
	tool: ToolName;
	item: string | undefined;
	locale: Locale;
}) {
	const workspace = useMobile((state) => state.workspace);
	const task = workspace?.tasks.find(
		(entry) => entry.id === taskId && entry.projectId === projectId
	);
	if (!task)
		return (
			<div className={s.screen} data-screen="tool" data-tool={tool}>
				<NavBar left={<BackButton label={t(locale, 'Chat')} locale={locale} onClick={back} />} />
				<p className={s.empty}>{workspace ? t(locale, 'The task is gone.') : ''}</p>
			</div>
		);
	switch (tool) {
		case 'changes':
			return item ? (
				<ChangeDiff task={task} fileId={item} locale={locale} />
			) : (
				<ChangesList task={task} locale={locale} />
			);
		case 'pr':
			return <PullRequest task={task} locale={locale} />;
		case 'files':
			return <Files task={task} folder={item ?? null} locale={locale} />;
		case 'file':
			return item ? <Code task={task} fileId={item} locale={locale} /> : null;
		case 'terminal':
			return <Terminal task={task} locale={locale} />;
	}
}
