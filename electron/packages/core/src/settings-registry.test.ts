import { describe, expect, it } from 'vitest';
import { defaultAppSettings, isAppSettings } from './settings';
import {
	changeSetting,
	findSettings,
	settingEdits,
	settingsRegistryText,
} from './settings-registry';

/** spec/settings-modules-and-onboarding#settings-registry */
describe('settings registry', () => {
	it('reads every entry and writes a value the Settings window would keep', () => {
		for (const edit of settingEdits) {
			const value = edit.get(defaultAppSettings);
			expect(isAppSettings(edit.set(defaultAppSettings, value)), edit.key).toBe(true);
		}
	});
	it('changes a setting and says what it was', () => {
		const change = changeSetting(defaultAppSettings, 'typography.editor.size', 13);
		expect(change).toMatchObject({ before: 12, after: 13, confirm: false });
		expect(change.settings.typography.editor.size).toBe(13);
		expect(change.place).toBe('Settings ▸ Appearance ▸ Editor ▸ Size');
		expect(changeSetting(defaultAppSettings, 'taskColumns', 'two').settings.taskColumns).toBe(
			'two'
		);
		expect(changeSetting(defaultAppSettings, 'interfaceFont.size', '14').after).toBe(14);
	});
	it('refuses what Settings would refuse, with a reason the agent can act on', () => {
		expect(() => changeSetting(defaultAppSettings, 'typography.editor.size', 40)).toThrow(
			'takes 8–24'
		);
		expect(() => changeSetting(defaultAppSettings, 'taskColumns', 'four')).toThrow(
			'"two" | "three"'
		);
		expect(() => changeSetting(defaultAppSettings, 'nope', 1)).toThrow('settings_find');
		// The default agent must be an enabled provider.
		const codexOff = {
			...defaultAppSettings,
			agents: { ...defaultAppSettings.agents, enabled: { claude: true, codex: false } },
		};
		expect(() => changeSetting(codexOff, 'agents.provider', 'codex')).toThrow('cannot be');
	});
	it('asks first before a module goes off or agents post without asking', () => {
		expect(changeSetting(defaultAppSettings, 'modules.browser', false).confirm).toBe(true);
		expect(changeSetting(defaultAppSettings, 'modules.simulator', true).confirm).toBe(false);
		expect(changeSetting(defaultAppSettings, 'agents.slackPostWithoutAsking', true).confirm).toBe(
			true
		);
	});
	it('finds settings in either language and lists them for the prompt', () => {
		expect(findSettings('code theme', defaultAppSettings, 'en').map((item) => item.key)).toContain(
			'editor.codeTheme'
		);
		expect(findSettings('Тема коду', defaultAppSettings, 'uk').map((item) => item.key)).toContain(
			'editor.codeTheme'
		);
		expect(
			findSettings('typography.diff', defaultAppSettings, 'en').map((item) => item.key)
		).toContain('typography.diff.size');
		const text = settingsRegistryText(defaultAppSettings);
		expect(text).toContain(
			'- taskColumns (Settings ▸ Appearance ▸ Task layout): "two" | "three"; now "three"'
		);
		expect(text).toContain(
			'modules.browser (Settings ▸ Modules ▸ browser): true | false; now true; asks the person first'
		);
	});
});
