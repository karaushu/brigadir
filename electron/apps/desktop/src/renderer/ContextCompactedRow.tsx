import { formatTokenCount, t, type Locale, type SessionEvent } from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import service from './Crew.module.css';
/** spec/chat#context-compacted: where the agent's context was cut to a summary; the sizes when the adapter gave both. Not a control. */
export function ContextCompactedRow({
	event,
	locale,
}: {
	event: Extract<SessionEvent, { kind: 'context.compacted' }>;
	locale: Locale;
}) {
	return (
		<div className={service.service} data-context-compacted>
			<Glyph name="collapse-all" size={12} />
			<span className={service.label}>
				{t(locale, 'Context compacted')}
				{event.before !== null && event.after !== null && (
					<span>
						{' · '}
						{formatTokenCount(event.before)} → {formatTokenCount(event.after)}
					</span>
				)}
			</span>
		</div>
	);
}
