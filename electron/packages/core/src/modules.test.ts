import { expect, it } from 'vitest';
import {
	withModuleDefaults,
	commandModule,
	defaultAppSettings,
	defaultKeymap,
	isAppModules,
	isAppSettings,
	keymapCommands,
	shortcutConflict,
	toolModule,
} from './index';
it('names the module of a tool and of a menu command (spec/settings-modules-and-onboarding#modules)', () => {
	expect(toolModule('browser_open')).toBe('browser');
	expect(toolModule('simulator_act')).toBe('simulator');
	expect(toolModule('pr_comment')).toBe('pullRequests');
	expect(toolModule('pr_comment_reply')).toBe('pullRequests');
	expect(toolModule('pr_state')).toBe('pullRequests');
	expect(toolModule('editor_state')).toBeNull();
	expect(toolModule('ask_user')).toBeNull();
	expect(toolModule('post_note')).toBeNull();
	expect(commandModule('browser')).toBe('browser');
	expect(commandModule('browser-reload')).toBe('browser');
	expect(commandModule('simulator-home')).toBe('simulator');
	expect(commandModule('pull-requests')).toBe('pullRequests');
	expect(commandModule('commands')).toBe('commands');
	expect(commandModule('command-run')).toBe('commands');
	expect(commandModule('terminal')).toBeNull();
	expect(commandModule('browsers')).toBeNull();
});
it('keeps the browser, pull requests, commands and remote access on and the simulator off by default, and settings carry all five', () => {
	expect(defaultAppSettings.modules).toEqual({
		browser: true,
		simulator: false,
		pullRequests: true,
		commands: true,
		remoteAccess: true,
		notes: true,
		schedules: true,
		slack: false,
	});
	expect(withModuleDefaults({ browser: false, simulator: true })).toEqual({
		browser: false,
		simulator: true,
		pullRequests: true,
		commands: true,
		remoteAccess: true,
		notes: true,
		schedules: true,
		slack: false,
	});
	expect(isAppModules({ browser: true })).toBe(false);
	expect(isAppModules({ browser: true, simulator: 1 })).toBe(false);
	const { modules: _, ...without } = defaultAppSettings;
	expect(isAppSettings(without)).toBe(false);
	expect(isAppSettings(defaultAppSettings)).toBe(true);
});
it('keeps the shortcuts of a module switched off free in the keymap', () => {
	expect(keymapCommands().some((command) => command.id === 'simulator-home')).toBe(false);
	expect(shortcutConflict(defaultKeymap, 'new-task', 'Shift+CmdOrCtrl+H')).toBeNull();
	expect(
		shortcutConflict(defaultKeymap, 'new-task', 'Shift+CmdOrCtrl+H', {
			browser: true,
			simulator: true,
			pullRequests: true,
			commands: true,
			remoteAccess: true,
			notes: true,
			schedules: true,
			slack: false,
		})
	).toEqual({ kind: 'command', commandId: 'simulator-home' });
	expect(
		keymapCommands({
			browser: true,
			simulator: false,
			pullRequests: false,
			commands: false,
			remoteAccess: true,
			notes: true,
			schedules: true,
			slack: false,
		}).some((command) => command.id === 'pull-requests' || command.id.startsWith('command'))
	).toBe(false);
});
