import { t, type Locale, type SessionEvent } from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import service from './Crew.module.css';
import styles from './SimulatorPanel.module.css';
/** spec/browser-and-simulator#sim-chat-row: the device the task's lease moved to, with its Metro port; a start past low memory says so. Not a control. */
export function SimulatorDeviceRow({
	event,
	locale,
}: {
	event: Extract<SessionEvent, { kind: 'simulator.device' }>;
	locale: Locale;
}) {
	return (
		<div className={service.service} data-simulator-device>
			<Glyph name="simulator" size={12} />
			<span className={service.label}>
				{t(locale, 'Device')} · {event.device}
				{event.lowMemory ? (
					<>
						{' · '}
						<span className={styles.lowMemory}>{t(locale, 'started with low memory')}</span>
						{' · '}
						{t(locale, 'by you')}
					</>
				) : (
					event.metroPort !== null && ` · Metro :${event.metroPort}`
				)}
			</span>
		</div>
	);
}
