import { t, type AppModule, type AppSettings, type Locale } from '@brigadir/core';
import { Choice, Switch } from './ui/Controls';
import { ModalDialog } from './ui/ModalDialog';
import { SettingsOption, SettingsRow, SettingsSection } from './SettingsForm';
import { moduleNames } from './ModuleList';
import { RemoteSettings, type RemoteDialog, type RemotePart } from './RemoteSettings';
import { SlackSettings } from './SlackSettings';
import formStyles from './LayoutSettings.module.css';
import s from './ModuleSettings.module.css';

/** spec/settings-modules-and-onboarding#module-settings-popup: the modules that have settings of their own; the others have no settings button. */
export const modulesWithSettings: readonly AppModule[] = [
	'browser',
	'pullRequests',
	'remoteAccess',
	'slack',
];
/** Which module's popup is open, with a remote access dialog or part to show first (a toast, the chip's menu). */
export type ModuleSettingsTarget = {
	module: AppModule;
	remoteDialog?: RemoteDialog;
	remotePart?: RemotePart;
};

/**
 * spec/settings-modules-and-onboarding#module-settings-popup (rule 17): Settings ▸ Modules ▸ ⚙ — one popup for every module with settings: the module's name, `Esc` (rule 14),
 * its settings on the Settings form (spec/appearance#interface-font). A module that is off has no popup; Esc goes back to Modules.
 */
export function ModuleSettingsDialog({
	target,
	settings,
	locale,
	busy,
	update,
	close,
}: {
	target: ModuleSettingsTarget;
	settings: AppSettings;
	locale: Locale;
	busy: boolean;
	update(patch: Partial<AppSettings>): void;
	close(): void;
}) {
	const module = target.module;
	return (
		<ModalDialog
			title={t(locale, moduleNames[module])}
			locale={locale}
			width={600}
			top={56}
			close={close}
			data-module-settings={module}>
			<div className={s.page}>
				{module === 'browser' ? (
					// spec/browser-and-simulator#background: without it, acting on a site other than a local page asks `Act on <domain>`.
					<SettingsSection label={t(locale, 'Browser')} disabled={busy}>
						<SettingsOption
							title={t(locale, 'Agents can act on any site without confirmation')}
							detail={t(locale, 'No permission card for actions. Local pages never ask.')}>
							<Choice
								type="checkbox"
								label={t(locale, 'Agents can act on any site without confirmation')}
								checked={settings.agents.browserActAnywhere}
								disabled={busy}
								onChange={(event) => {
									update({
										agents: { ...settings.agents, browserActAnywhere: event.currentTarget.checked },
									});
								}}
							/>
						</SettingsOption>
					</SettingsSection>
				) : module === 'pullRequests' ? (
					// spec/appearance#evolution-redesign: the review of a PR writes the agent summary by itself on its first open.
					<SettingsSection label={t(locale, 'Pull requests (module)')} disabled={busy}>
						<SettingsRow label={t(locale, 'PR summary')}>
							<label className={formStyles.inline}>
								<Switch
									label={t(locale, 'Summarize a PR when its review opens')}
									checked={settings.agents.prSummary}
									disabled={busy}
									onChange={(prSummary) => {
										update({ agents: { ...settings.agents, prSummary } });
									}}
								/>
								<span>{t(locale, 'Summarize a PR when its review opens')}</span>
							</label>
						</SettingsRow>
					</SettingsSection>
				) : module === 'remoteAccess' ? (
					// spec/remote-access-and-mobile#module-and-settings, spec/remote-access-and-mobile#remote-button: everything the Remote tab had, its dialogs and two parts included.
					<RemoteSettings locale={locale} open={target.remoteDialog} part={target.remotePart} />
				) : module === 'slack' ? (
					// spec/notifications-slack-notes-and-schedules#slack: the bot, where its messages go and which events.
					<SlackSettings locale={locale} settings={settings} busy={busy} update={update} />
				) : null}
			</div>
		</ModalDialog>
	);
}
