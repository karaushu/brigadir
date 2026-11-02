import { useEffect, useState, type ComponentProps } from 'react';
import {
	appModules,
	t,
	type AppModule,
	type AppModules,
	type Locale,
	type MessageKey,
	type SimulatorToolchain,
} from '@brigadir/core';
import { IconButton, Switch } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { ListCard, ListLead, ListRow } from './ui/ListCard';
import s from './ModuleList.module.css';
type GlyphName = ComponentProps<typeof Glyph>['name'];
/** spec/settings-modules-and-onboarding#intro-remote: each module's mark, name and second line — one list in the intro's Modules step and Settings ▸ Modules. */
const moduleRows: Record<AppModule, { glyph: GlyphName; name: MessageKey; detail: MessageKey }> = {
	browser: {
		glyph: 'browser',
		name: 'Browser',
		detail: 'Pages in the task window, for you and the agent.',
	},
	simulator: { glyph: 'simulator', name: 'Simulator', detail: 'iOS and Android' },
	pullRequests: {
		glyph: 'pr-branch',
		name: 'Pull requests (module)',
		detail: 'PR list and review from GitHub.',
	},
	commands: {
		glyph: 'command-play',
		name: 'Commands',
		detail: 'A button that runs project commands.',
	},
	remoteAccess: {
		glyph: 'remote',
		name: 'Remote access',
		detail: 'Control this machine from another computer.',
	},
	notes: { glyph: 'note', name: 'Notes', detail: 'Markdown notes with their own agent chat.' },
	schedules: {
		glyph: 'schedule',
		name: 'Scheduled tasks',
		detail: 'Run a task later or on repeat.',
	},
	slack: { glyph: 'slack', name: 'Slack', detail: 'Task and CI messages from your CI bot.' },
};
/** spec/settings-modules-and-onboarding#module-settings-popup: the ⚙ button's name and tooltip, for the modules that have settings. */
const settingsLabels: Partial<Record<AppModule, MessageKey>> = {
	browser: 'Browser settings',
	pullRequests: 'Pull request settings',
	remoteAccess: 'Remote access settings',
	slack: 'Slack settings',
};
/** A module's name as its row shows it — the title of its settings popup too (spec/settings-modules-and-onboarding#module-settings-popup). */
export const moduleNames = Object.fromEntries(
	appModules.map((module) => [module, moduleRows[module].name])
) as Record<AppModule, MessageKey>;
/**
 * spec/settings-modules-and-onboarding#intro-remote (rule 17): the modules as rows with a second line and a switch; the whole row toggles (rule 15). The
 * simulator row reads the tools found on this machine once it mounts (spec/settings-modules-and-onboarding#modules). `locked` keeps a module's switch
 * still, as remote access in a device's window (spec/remote-access-and-mobile#architecture); `onHover` lets the intro move its spotlight.
 * spec/settings-modules-and-onboarding#module-settings-popup: `onSettings` gives a module that is on a ⚙ before its switch — a nested button with its own hover that opens the
 * module's settings and never toggles the row; the intro passes none.
 */
export function ModuleList({
	locale,
	modules,
	onChange,
	disabled = false,
	locked = [],
	onHover,
	onSettings,
}: {
	locale: Locale;
	modules: AppModules;
	onChange(modules: AppModules): void;
	disabled?: boolean;
	locked?: AppModule[];
	onHover?(module: AppModule | null): void;
	onSettings?: Partial<Record<AppModule, () => void>>;
}) {
	const [toolchain, setToolchain] = useState<SimulatorToolchain | null>(null);
	useEffect(() => {
		let live = true;
		void window.brigadir.readSimulatorToolchain().then(
			(value) => {
				if (live) setToolchain(value);
			},
			() => {}
		);
		return () => {
			live = false;
		};
	}, []);
	return (
		<ListCard role="group" aria-label={t(locale, 'Modules')} data-module-list>
			{appModules.map((module) => {
				const row = moduleRows[module],
					name = t(locale, row.name),
					on = modules[module],
					still = disabled || locked.includes(module),
					toggle = (value: boolean) => onChange({ ...modules, [module]: value }),
					settings = on ? onSettings?.[module] : undefined;
				let detail = <>{t(locale, row.detail)}</>;
				if (module === 'simulator' && toolchain) {
					const found = [toolchain.xcode, toolchain.android].filter(Boolean).join(' · ');
					detail = (
						<>
							{t(locale, row.detail)} ·{' '}
							{found || (
								<span className={s.miss}>
									{t(locale, toolchain.ios ? 'Xcode not found' : 'Android SDK not found')}
								</span>
							)}
						</>
					);
				}
				return (
					<ListRow
						key={module}
						tall
						dim={!on}
						line={{ 'data-module': module }}
						lead={
							<ListLead>
								<Glyph name={row.glyph} size={16} />
							</ListLead>
						}
						title={name}
						detail={detail}
						onActivate={still ? undefined : () => toggle(!on)}
						onHover={onHover && ((inside) => onHover(inside ? module : null))}
						control={
							<span className={s.controls}>
								{settings && (
									<IconButton
										label={t(locale, settingsLabels[module] ?? 'Settings')}
										onClick={settings}
										data-module-settings-button={module}>
										<Glyph name="search-setting" />
									</IconButton>
								)}
								<Switch label={name} checked={on} disabled={still} onChange={toggle} />
							</span>
						}
					/>
				);
			})}
		</ListCard>
	);
}
