import { useMemo } from 'react';
import type { AgentTask, Locale } from '@brigadir/core';
import { markdown, MarkdownBlock } from './MarkdownBlock';
import styles from './QuestionText.module.css';

/** spec/chat-turns-plans-and-questions#question-card: the agent's question in its card as the chat's Markdown — code, lists, emphasis and file links. */
export function QuestionText({
	id,
	text,
	task,
	locale,
	revision = 0,
}: {
	id: string;
	text: string;
	task: AgentTask;
	locale: Locale;
	revision?: number;
}) {
	const tokens = useMemo(() => markdown.parse(text, {}), [text]),
		html = useMemo(() => markdown.renderer.render(tokens, markdown.options, {}), [tokens]);
	return (
		<MarkdownBlock
			rowId={`question/${id}`}
			html={html}
			tokens={tokens}
			locale={locale}
			task={task}
			revision={revision}
			className={styles.text}
		/>
	);
}
