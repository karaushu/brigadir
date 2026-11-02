import {
	bundledFonts,
	codeFontSize,
	fontFamilyChoice,
	systemFontFamily,
	systemMonoFamily,
	codeThemes,
	terminalScrollSpeed,
	terminalFontWeights,
	type TerminalFontWeight,
	interfaceFontSize,
	chatFontSize,
	chatFontStep,
	shownChatSize,
	textSurfaces,
	t,
	type AppSettings,
	type Locale,
	type SurfaceFont,
} from '@brigadir/core';
import { useWorkspace } from './store';
import { Popup, Switch, Button, Stepper } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { SettingsRow, SettingsSection } from './SettingsForm';
import styles from './LayoutSettings.module.css';
export function TypographySettings({
	settings,
	locale,
	busy,
	update,
	reload,
}: {
	settings: AppSettings;
	locale: Locale;
	busy: boolean;
	update(patch: Partial<AppSettings>): Promise<void>;
	reload(): void;
}) {
	const catalog = useWorkspace((state) => state.appearance.fonts);
	const size = (
		label: string,
		value: number,
		min: number,
		max: number,
		onChange: (value: number) => void,
		step = 1
	) => (
		<Stepper
			label={label}
			value={value}
			min={min}
			max={max}
			step={step}
			disabled={busy}
			onChange={onChange}
			increaseLabel={`${label} · ${t(locale, 'Increase')}`}
			decreaseLabel={`${label} · ${t(locale, 'Decrease')}`}
		/>
	);
	const chatTitle = t(locale, 'Chat');
	const interfaceTitle = t(locale, 'Interface'),
		ui = settings.interfaceFont,
		saveInterface = (patch: Partial<AppSettings['interfaceFont']>) => {
			void update({ interfaceFont: { ...ui, ...patch } });
		};
	// spec/appearance#evolution-redesign: Geist is the default and the OS font a choice of its own; a family the person picked before stays.
	const uiChoice = fontFamilyChoice(ui.family, 'sans'),
		uiMissing = Boolean(
			uiChoice.kind === 'installed' &&
			catalog &&
			!catalog.fonts.some((item) => item.family === ui.family)
		);
	const label = (choice: ReturnType<typeof fontFamilyChoice>) =>
		choice.kind === 'system'
			? t(locale, choice.name === systemFontFamily ? 'System font' : 'System mono')
			: choice.name;
	/** The bundled family is drawn from the app, never from an installed copy of the same name. */
	const installedOnly = (family: string) =>
		family !== bundledFonts.sans && family !== bundledFonts.mono;
	return (
		<>
			{/* spec/appearance#interface-font: the interface font scales every UI text; the three code surfaces keep their own fonts below. */}
			<SettingsSection
				title={interfaceTitle}
				warning={uiMissing}
				footnote={
					uiMissing ? t(locale, 'This font is unavailable. Using the system font.') : undefined
				}>
				<SettingsRow label={t(locale, 'Font')} wide>
					<Popup
						label={`${interfaceTitle} · ${t(locale, 'Font')}`}
						disabled={busy || !catalog}
						value={ui.family ?? ''}
						displayValue={label(uiChoice)}
						search={{
							placeholder: t(locale, 'Search fonts'),
							empty: t(locale, 'No fonts match'),
							clear: t(locale, 'Clear the field'),
						}}
						options={[
							{ value: '', label: bundledFonts.sans },
							{ value: systemFontFamily, label: t(locale, 'System font') },
							...(catalog?.fonts ?? [])
								.filter((item) => installedOnly(item.family))
								.map((item) => ({ value: item.family, label: item.family })),
						]}
						onChange={(family) => saveInterface({ family: family || null })}
					/>
				</SettingsRow>
				<SettingsRow label={t(locale, 'Size')}>
					{size(
						`${interfaceTitle} · ${t(locale, 'Size')}`,
						ui.size,
						interfaceFontSize.min,
						interfaceFontSize.max,
						(size) => saveInterface({ size })
					)}
				</SettingsRow>
			</SettingsSection>
			{/* spec/appearance#chat-text-size: the chat's text size apart from the interface; null follows it, `Match interface` returns there. */}
			<SettingsSection title={chatTitle}>
				<SettingsRow label={t(locale, 'Size')}>
					<div className={styles.inline}>
						{size(
							`${chatTitle} · ${t(locale, 'Size')}`,
							shownChatSize(settings.chatFont, ui),
							chatFontSize.min,
							chatFontSize.max,
							(value) => {
								void update({ chatFont: { size: chatFontStep(value) } });
							},
							chatFontSize.step
						)}
						{settings.chatFont.size !== null && (
							<Button
								variant="ghost"
								disabled={busy}
								onClick={() => {
									void update({ chatFont: { size: null } });
								}}>
								{t(locale, 'Match interface')}
							</Button>
						)}
					</div>
				</SettingsRow>
			</SettingsSection>
			{!catalog && (
				<div className={styles.note}>
					<Glyph name="settings-notice" size={15} />
					<span>{t(locale, 'Installed fonts could not be loaded.')}</span>
					<Button onClick={reload}>{t(locale, 'Retry')}</Button>
				</div>
			)}
			{textSurfaces.map((surface) => {
				const font = settings.typography[surface],
					title = t(
						locale,
						surface === 'terminal' ? 'Terminal' : surface === 'diff' ? 'Diff' : 'Editor'
					);
				const save = (patch: Partial<SurfaceFont>) => {
					void update({ typography: { ...settings.typography, [surface]: { ...font, ...patch } } });
				};
				const monoFonts = (catalog?.fonts ?? []).filter(
						(item) => item.mono && installedOnly(item.family)
					),
					choice = fontFamilyChoice(font.family, 'mono'),
					missing = Boolean(
						choice.kind === 'installed' &&
						catalog &&
						!monoFonts.some((item) => item.family === font.family)
					),
					partial =
						catalog?.fonts.find((item) => item.family === font.family)?.boxDrawing === false;
				const warning = missing
					? t(locale, 'This font is unavailable. Using system mono.')
					: partial
						? t(locale, 'This font does not include every box-drawing character.')
						: null;
				return (
					<SettingsSection
						key={surface}
						title={title}
						label={`${title} · ${t(locale, 'Typography')}`}
						warning={Boolean(warning)}
						footnote={warning ?? undefined}>
						<SettingsRow label={t(locale, 'Font')} wide>
							<Popup
								label={`${title} · ${t(locale, 'Font')}`}
								disabled={busy || !catalog}
								value={font.family ?? ''}
								displayValue={label(choice)}
								options={[
									{ value: '', label: bundledFonts.mono },
									{ value: systemMonoFamily, label: t(locale, 'System mono') },
									...monoFonts.map((item) => ({ value: item.family, label: item.family })),
								]}
								onChange={(family) => save({ family: family || null })}
							/>
						</SettingsRow>
						<SettingsRow label={t(locale, 'Size')}>
							{size(
								`${title} · ${t(locale, 'Size')}`,
								font.size,
								codeFontSize.min,
								codeFontSize.max,
								(size) => save({ size })
							)}
						</SettingsRow>
						{surface !== 'terminal' && (
							<>
								<SettingsRow label={t(locale, 'Line height')}>
									{size(
										`${title} · ${t(locale, 'Line height')}`,
										font.lineHeight,
										1,
										2,
										(lineHeight) => save({ lineHeight }),
										0.1
									)}
								</SettingsRow>
								<SettingsRow label={t(locale, 'Ligatures')}>
									<Switch
										label={`${title} · ${t(locale, 'Ligatures')}`}
										checked={font.ligatures}
										disabled={busy}
										onChange={(ligatures) => save({ ligatures })}
									/>
								</SettingsRow>
							</>
						)}
						{/* spec/terminal-and-cli-agents#render-and-theme: the weight a native terminal profile sets; bold text keeps 700. */}
						{surface === 'terminal' && (
							<SettingsRow label={t(locale, 'Font weight')} wide>
								<Popup
									label={`${title} · ${t(locale, 'Font weight')}`}
									disabled={busy}
									value={String(settings.terminal.fontWeight)}
									options={terminalFontWeights.map((weight) => ({
										value: String(weight),
										label: t(
											locale,
											weight === 300
												? 'Light weight'
												: weight === 400
													? 'Regular'
													: weight === 500
														? 'Medium'
														: 'Semibold'
										),
									}))}
									onChange={(value) => {
										void update({
											terminal: {
												...settings.terminal,
												fontWeight: Number(value) as TerminalFontWeight,
											},
										});
									}}
								/>
							</SettingsRow>
						)}
						{/* spec/terminal-and-cli-agents#wheel: 1 is a native terminal, one line per line-height of wheel or trackpad travel. */}
						{surface === 'terminal' && (
							<SettingsRow label={t(locale, 'Scroll speed')}>
								{size(
									`${title} · ${t(locale, 'Scroll speed')}`,
									settings.terminal.scrollSpeed,
									terminalScrollSpeed.min,
									terminalScrollSpeed.max,
									(scrollSpeed) => {
										void update({ terminal: { ...settings.terminal, scrollSpeed } });
									},
									0.1
								)}
							</SettingsRow>
						)}
						{/* spec/settings-modules-and-onboarding#settings-keys: syntax colours only, shared by the editor and the diff. */}
						{surface === 'editor' && (
							<SettingsRow label={t(locale, 'Code theme')} wide>
								<Popup
									label={t(locale, 'Code theme')}
									disabled={busy}
									value={settings.editor.codeTheme}
									options={codeThemes.map((value) => ({
										value,
										label: t(
											locale,
											value === 'brigadir'
												? 'Brigadir'
												: value === 'vscode'
													? 'VS Code'
													: 'IntelliJ'
										),
									}))}
									onChange={(codeTheme) => {
										void update({
											editor: {
												...settings.editor,
												codeTheme: codeTheme as AppSettings['editor']['codeTheme'],
											},
										});
									}}
								/>
							</SettingsRow>
						)}
						{/* spec/editor-code-intelligence#font-styles: bold keywords and italic comments, a switch of its own under the code theme; no caption (spec/settings-modules-and-onboarding#no-captions). */}
						{surface === 'editor' && (
							<SettingsRow label={t(locale, 'Font styles')}>
								<Switch
									label={t(locale, 'Font styles')}
									checked={settings.editor.syntaxStyles}
									disabled={busy}
									onChange={(syntaxStyles) => {
										void update({ editor: { ...settings.editor, syntaxStyles } });
									}}
								/>
							</SettingsRow>
						)}
					</SettingsSection>
				);
			})}
		</>
	);
}
