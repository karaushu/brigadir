import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAppSettings, isAppSettings, settingsLocale } from '@brigadir/core';
import { Settings } from './settings';
it('serializes settings, snapshots caller values and preserves unreadable/future documents', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-'));
	try {
		const settings = new Settings(root);
		expect(await settings.read()).toEqual(defaultAppSettings);
		const first = { ...defaultAppSettings, appearance: 'dark', language: 'uk' } as const;
		const mutable = { ...first } as import('@brigadir/core').AppSettings;
		const saving = settings.save(mutable);
		mutable.appearance = 'light';
		await saving;
		expect(await settings.read()).toEqual(first);
		const value = { ...defaultAppSettings, appearance: 'light', language: 'en' } as const;
		await Promise.all([settings.save(value), settings.save(first)]);
		expect(await settings.read()).toEqual(first);
		expect(settings.isSaving).toBe(false);
		const path = join(root, 'settings.json');
		const original = await readFile(path, 'utf8');
		for (const invalid of [
			{},
			null,
			{ appearance: ['light'], language: 'uk' },
			{ appearance: 'dark', language: 'de' },
			{ ...first, extra: 1 },
			{ ...first, toolbarLabels: 'unknown' },
		]) {
			expect(isAppSettings(invalid)).toBe(false);
			expect(() => settings.save(invalid as any)).toThrow();
		}
		expect(await readFile(path, 'utf8')).toBe(original);
		for (const doc of [
			'{invalid',
			JSON.stringify({ schemaVersion: 99, settings: first }),
			JSON.stringify({ schemaVersion: 1, settings: { appearance: 'unknown', language: 'en' } }),
		]) {
			await writeFile(path, doc);
			await expect(settings.save(defaultAppSettings)).rejects.toThrow();
			expect(await readFile(path, 'utf8')).toBe(doc);
		}
		await writeFile(path, original);
		await settings.save(defaultAppSettings);
		expect(await settings.read()).toEqual(defaultAppSettings);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('resolves app language independently from the system and falls back to English', () => {
	expect(settingsLocale(defaultAppSettings, 'uk-UA')).toBe('uk');
	expect(settingsLocale(defaultAppSettings, 'ro-RO')).toBe('en');
	expect(settingsLocale({ ...defaultAppSettings, language: 'uk' }, 'en-US')).toBe('uk');
	expect(settingsLocale({ ...defaultAppSettings, language: 'en' }, 'uk-UA')).toBe('en');
});

it('reads legacy settings without rewriting them and persists toolbar labels independently', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-legacy-'));
	try {
		const path = join(root, 'settings.json'),
			legacy = JSON.stringify({
				schemaVersion: 1,
				settings: { appearance: 'dark', language: 'uk' },
			});
		await writeFile(path, legacy);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value).toEqual({
			...defaultAppSettings,
			appearance: 'dark',
			language: 'uk',
			toolbarLabels: 'icons',
			onboarding: { completedVersion: 1 },
		});
		expect(await readFile(path, 'utf8')).toBe(legacy);
		await settings.save({ ...value, toolbarLabels: 'labels' });
		expect(await new Settings(root).read()).toEqual({ ...value, toolbarLabels: 'labels' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('spec/task-window-workspace#two-columns: a file from before the layout choice reads three columns; two persists, another value is refused', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-columns-'));
	try {
		const path = join(root, 'settings.json'),
			{ taskColumns: _, ...older } = defaultAppSettings;
		await writeFile(path, JSON.stringify({ schemaVersion: 1, settings: older }));
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.taskColumns).toBe('three');
		await settings.save({ ...value, taskColumns: 'two' });
		expect((await new Settings(root).read()).taskColumns).toBe('two');
		expect(isAppSettings({ ...value, taskColumns: 'four' })).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('persists independent launch defaults and rejects malformed agent settings', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-agent-defaults-'));
	try {
		const settings = new Settings(root),
			path = join(root, 'settings.json');
		for (const provider of ['claude', 'codex'] as const)
			for (const transport of ['gui', 'terminal'] as const) {
				const value = {
					...structuredClone(defaultAppSettings),
					agents: { ...defaultAppSettings.agents, provider, transport, maxConcurrent: null },
				};
				await settings.save(value);
				expect((await new Settings(root).read()).agents).toEqual({
					...defaultAppSettings.agents,
					provider,
					transport,
					maxConcurrent: null,
				});
			}
		const original = await readFile(path, 'utf8');
		for (const agents of [
			null,
			{},
			{ provider: 'codex', transport: 'web', maxConcurrent: null },
			{ provider: 'other', transport: 'gui', maxConcurrent: null },
			{ provider: 'claude', transport: 'gui', maxConcurrent: null, extra: true },
			{ provider: 'claude', transport: 'gui', maxConcurrent: 0 },
			{ provider: 'claude', transport: 'gui', maxConcurrent: 100 },
			{ provider: 'claude', transport: 'gui', maxConcurrent: 2.5 },
			{ provider: 'claude', transport: 'gui' },
		]) {
			expect(isAppSettings({ ...defaultAppSettings, agents })).toBe(false);
			expect(() => settings.save({ ...defaultAppSettings, agents } as any)).toThrow();
		}
		expect(await readFile(path, 'utf8')).toBe(original);
		const first = await new Settings(join(root, 'fresh')).read();
		first.agents.provider = 'codex';
		expect((await new Settings(join(root, 'fresh')).read()).agents.provider).toBe('claude');
		const legacy = JSON.stringify({
			schemaVersion: 1,
			settings: { ...defaultAppSettings, agents: { provider: 'codex', transport: 'terminal' } },
		});
		await writeFile(path, legacy);
		expect((await new Settings(root).read()).agents).toEqual({
			...defaultAppSettings.agents,
			provider: 'codex',
			transport: 'terminal',
			maxConcurrent: null,
		});
		expect(await readFile(path, 'utf8')).toBe(legacy);
		await new Settings(root).save({
			...defaultAppSettings,
			agents: {
				...defaultAppSettings.agents,
				provider: 'claude',
				transport: 'gui',
				maxConcurrent: 4,
			},
		});
		expect((await new Settings(root).read()).agents.maxConcurrent).toBe(4);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('persists notification preferences, normalizes legacy documents and rejects unsafe sound names', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-notification-settings-'));
	try {
		const path = join(root, 'settings.json'),
			legacy = JSON.stringify({
				schemaVersion: 1,
				settings: {
					appearance: 'dark',
					language: 'uk',
					toolbarLabels: 'icons',
					typography: defaultAppSettings.typography,
					agents: { provider: 'codex', transport: 'terminal' },
				},
			});
		await writeFile(path, legacy);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.notifications).toEqual(defaultAppSettings.notifications);
		expect(await readFile(path, 'utf8')).toBe(legacy);
		const custom = {
			mode: 'turn-ended',
			soundMode: 'off',
			sounds: { needsYou: null, turnEnded: 'Hero', failed: 'Basso' },
			muteVisibleTask: false,
		} as const;
		await settings.save({ ...value, notifications: custom });
		expect((await new Settings(root).read()).notifications).toEqual(custom);
		const original = await readFile(path, 'utf8');
		for (const notifications of [
			null,
			{},
			{ ...custom, mode: 'always' },
			{ ...custom, enabled: false },
			{ ...custom, sounds: { ...custom.sounds, failed: '/System/Library/Sounds/Basso.aiff' } },
			{ ...custom, sounds: { needsYou: 'Ping' } },
		]) {
			expect(isAppSettings({ ...value, notifications })).toBe(false);
			expect(() => settings.save({ ...value, notifications } as any)).toThrow();
		}
		expect(await readFile(path, 'utf8')).toBe(original);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('reads the two-control notification preferences as one mode without rewriting the file (spec/notifications-slack-notes-and-schedules#macos-permission)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-notification-mode-'));
	try {
		const path = join(root, 'settings.json'),
			sounds = { needsYou: 'Ping', turnEnded: 'Tink', failed: 'Basso' };
		for (const [enabled, scope, mode] of [
			[false, 'turn-ended', 'off'],
			[true, 'turn-ended', 'turn-ended'],
			[true, 'needs-you', 'needs-you'],
		] as const) {
			const legacy = JSON.stringify({
				schemaVersion: 1,
				settings: {
					...defaultAppSettings,
					notifications: { enabled, scope, soundMode: 'needs-you', sounds, muteVisibleTask: true },
				},
			});
			await writeFile(path, legacy);
			expect((await new Settings(root).read()).notifications).toEqual({
				mode,
				soundMode: 'needs-you',
				sounds,
				muteVisibleTask: true,
			});
			expect(await readFile(path, 'utf8')).toBe(legacy);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('reads settings saved before modules existed with the browser on and the simulator off, and persists a switch (spec/settings-modules-and-onboarding#modules)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-modules-'));
	try {
		const path = join(root, 'settings.json'),
			{ modules: _, ...previous } = defaultAppSettings,
			legacy = JSON.stringify({ schemaVersion: 1, settings: previous });
		await writeFile(path, legacy);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.modules).toEqual({
			browser: true,
			simulator: false,
			pullRequests: true,
			commands: true,
			remoteAccess: true,
			notes: true,
			schedules: true,
			slack: false,
		});
		expect(await readFile(path, 'utf8')).toBe(legacy);
		await settings.save({
			...value,
			modules: { ...value.modules, browser: false, simulator: true },
		});
		expect((await new Settings(root).read()).modules).toEqual({
			browser: false,
			simulator: true,
			pullRequests: true,
			commands: true,
			remoteAccess: true,
			notes: true,
			schedules: true,
			slack: false,
		});
		// spec/settings-modules-and-onboarding#module-off: a file from before pull requests and commands were modules keeps its two switches, the new ones take defaults.
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				settings: { ...previous, modules: { browser: false, simulator: true } },
			})
		);
		expect((await new Settings(root).read()).modules).toEqual({
			browser: false,
			simulator: true,
			pullRequests: true,
			commands: true,
			remoteAccess: true,
			notes: true,
			schedules: true,
			slack: false,
		});
		expect(() => settings.save({ ...value, modules: { browser: false } } as any)).toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('reads agents saved before spec/pull-requests-and-ci#review-with-agent with the quick review and persists the choice', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-review-'));
	try {
		const path = join(root, 'settings.json'),
			{ reviewWhere: _, ...agents } = defaultAppSettings.agents;
		await writeFile(
			path,
			JSON.stringify({ schemaVersion: 1, settings: { ...defaultAppSettings, agents } })
		);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.agents.reviewWhere).toBe('quick');
		await settings.save({ ...value, agents: { ...value.agents, reviewWhere: 'worktree' } });
		expect((await new Settings(root).read()).agents.reviewWhere).toBe('worktree');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('reads agents saved before «Mac sleep» as keeping the Mac awake without rewriting the file, and persists off (spec/architecture-and-platform#keep-awake)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-keep-awake-'));
	try {
		const path = join(root, 'settings.json'),
			{ keepAwake: _, ...agents } = defaultAppSettings.agents,
			legacy = JSON.stringify({ schemaVersion: 1, settings: { ...defaultAppSettings, agents } });
		await writeFile(path, legacy);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.agents.keepAwake).toBe(true);
		expect(await readFile(path, 'utf8')).toBe(legacy);
		await settings.save({ ...value, agents: { ...value.agents, keepAwake: false } });
		expect((await new Settings(root).read()).agents.keepAwake).toBe(false);
		expect(isAppSettings({ ...value, agents: { ...value.agents, keepAwake: 'yes' } })).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('reads settings saved before the accent existed as following the system and persists the choice (spec/appearance#accent)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-accent-'));
	try {
		const path = join(root, 'settings.json'),
			{ accent: _, ...previous } = defaultAppSettings,
			legacy = JSON.stringify({ schemaVersion: 1, settings: { ...previous, appearance: 'dark' } });
		await writeFile(path, legacy);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.accent).toBe('system');
		expect(await readFile(path, 'utf8')).toBe(legacy);
		await settings.save({ ...value, accent: 'yellow' });
		expect((await new Settings(root).read()).accent).toBe('yellow');
		expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
			schemaVersion: 1,
			settings: { accent: 'yellow', appearance: 'dark' },
		});
		const saved = await readFile(path, 'utf8');
		expect(() => settings.save({ ...value, accent: 'orange' } as any)).toThrow();
		expect(await readFile(path, 'utf8')).toBe(saved);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('reads the interface font as the system font at 13 for older documents and rejects invalid values', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-interface-font-'));
	try {
		const path = join(root, 'settings.json'),
			legacy = JSON.stringify({
				schemaVersion: 1,
				settings: { appearance: 'dark', language: 'uk' },
			});
		await writeFile(path, legacy);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.interfaceFont).toEqual({ family: null, size: 13 });
		expect(await readFile(path, 'utf8')).toBe(legacy);
		await settings.save({ ...value, interfaceFont: { family: 'Avenir Next', size: 16 } });
		expect((await new Settings(root).read()).interfaceFont).toEqual({
			family: 'Avenir Next',
			size: 16,
		});
		for (const interfaceFont of [
			{ family: null, size: 7 },
			{ family: null, size: 25 },
			{ family: null, size: 13.5 },
			{ family: '', size: 13 },
			{ family: 'A\nB', size: 13 },
			{ family: null },
			{ family: null, size: 13, extra: 1 },
			13,
			null,
		])
			expect(isAppSettings({ ...value, interfaceFont })).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('reads editor settings saved before the diff base existed as the task start and persists the choice (spec/diff-and-review#diff-base)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-diff-base-'));
	try {
		const path = join(root, 'settings.json'),
			legacy = JSON.stringify({
				schemaVersion: 1,
				settings: { ...defaultAppSettings, editor: { format: 'off' } },
			});
		await writeFile(path, legacy);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.editor).toEqual({ ...defaultAppSettings.editor, format: 'off', diffBase: 'task' });
		expect(await readFile(path, 'utf8')).toBe(legacy);
		await settings.save({ ...value, editor: { ...value.editor, diffBase: 'head' } });
		expect((await new Settings(root).read()).editor.diffBase).toBe('head');
		expect(() =>
			settings.save({ ...value, editor: { ...value.editor, diffBase: 'index' } } as any)
		).toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('reads editor settings saved before the typing aids existed with every aid on (spec/editor-code-intelligence#typing-help)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-typing-'));
	try {
		await writeFile(
			join(root, 'settings.json'),
			JSON.stringify({
				schemaVersion: 1,
				settings: { ...defaultAppSettings, editor: { format: 'auto', diffBase: 'head' } },
			})
		);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.editor).toEqual({
			format: 'auto',
			diffBase: 'head',
			codeTheme: 'brigadir',
			lineAuthor: true,
			syntaxStyles: true,
			indentStyle: 'auto',
			indentSize: 2,
			tabWidth: 'auto',
			languageServers: true,
			closeBrackets: true,
			closeTags: true,
			callParens: true,
		});
		await settings.save({
			...value,
			editor: { ...value.editor, languageServers: false, closeTags: false },
		});
		expect(await new Settings(root).read()).toMatchObject({
			editor: { languageServers: false, closeTags: false, closeBrackets: true },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('reads settings saved before the hint model existed as the default model and persists a catalog choice (spec/composer-steering-queue-and-ghost#ghost-headless)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-suggest-'));
	try {
		const path = join(root, 'settings.json'),
			{ helperAgent: _, ...legacy } = defaultAppSettings;
		await writeFile(
			path,
			JSON.stringify({ schemaVersion: 1, settings: { ...legacy, suggestNextPrompt: true } })
		);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.helperAgent).toBeNull();
		expect(value.suggestNextPrompt).toBe(true);
		expect(await readFile(path, 'utf8')).not.toContain('helperAgent');
		// spec/appearance#evolution-redesign: a stored `suggestModel` carries over as the Helper agent with the lowest effort.
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				settings: {
					...legacy,
					suggestModel: { provider: 'codex', model: 'gpt-6-luna', name: '6 Luna' },
				},
			})
		);
		expect((await new Settings(root).read()).helperAgent).toEqual({
			provider: 'codex',
			model: 'gpt-6-luna',
			name: '6 Luna',
			effort: null,
		});
		const luna = {
			provider: 'codex',
			model: 'gpt-6-luna',
			name: '6 Luna',
			effort: 'high',
		} as const;
		await settings.save({ ...value, helperAgent: luna });
		expect((await new Settings(root).read()).helperAgent).toEqual(luna);
		for (const invalid of [
			{ provider: 'gemini', model: 'x', name: null },
			{ provider: 'codex', model: '', name: null },
			{ provider: 'codex', model: 'gpt-6-luna' },
			{ ...luna, extra: 1 },
		])
			expect(isAppSettings({ ...value, helperAgent: invalid })).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('reads settings saved before per-action agents as inheriting and keeps a remembered agent (spec/appearance#evolution-redesign)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-actions-'));
	try {
		const path = join(root, 'settings.json'),
			{ actionAgents: _, ...legacy } = defaultAppSettings;
		await writeFile(path, JSON.stringify({ schemaVersion: 1, settings: legacy }));
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.actionAgents).toEqual({});
		const luna = {
			provider: 'codex',
			model: 'gpt-6-luna',
			name: '6 Luna',
			effort: 'high',
		} as const;
		await settings.save({ ...value, actionAgents: { prSummary: luna } });
		expect((await new Settings(root).read()).actionAgents).toEqual({ prSummary: luna });
		// Sorted keys on disk, as every JSON state file.
		const text = await readFile(path, 'utf8');
		expect(text.indexOf('"actionAgents"')).toBeLessThan(text.indexOf('"agents"'));
		// An entry that is not an action reads as inheriting.
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				settings: { ...legacy, actionAgents: { prSummary: luna, chat: luna } },
			})
		);
		expect((await new Settings(root).read()).actionAgents).toEqual({ prSummary: luna });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('reads editor settings saved before indentation existed with the defaults and keeps the choice (spec/editor#indentation)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-indent-'));
	try {
		const { indentStyle: _a, indentSize: _b, tabWidth: _c, ...legacy } = defaultAppSettings.editor;
		await writeFile(
			join(root, 'settings.json'),
			JSON.stringify({
				schemaVersion: 1,
				settings: { ...defaultAppSettings, editor: { ...legacy, codeTheme: 'intellij' } },
			})
		);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.editor).toMatchObject({
			codeTheme: 'intellij',
			indentStyle: 'auto',
			indentSize: 2,
			tabWidth: 'auto',
		});
		await settings.save({
			...value,
			editor: { ...value.editor, indentStyle: 'tabs', tabWidth: 8 },
		});
		expect((await new Settings(root).read()).editor).toMatchObject({
			indentStyle: 'tabs',
			indentSize: 2,
			tabWidth: 8,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('reads editor settings saved before font styles existed with them on and keeps the choice (spec/editor-code-intelligence#font-styles)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-syntax-styles-'));
	try {
		const { syntaxStyles: _, ...legacy } = defaultAppSettings.editor;
		await writeFile(
			join(root, 'settings.json'),
			JSON.stringify({
				schemaVersion: 1,
				settings: { ...defaultAppSettings, editor: { ...legacy, codeTheme: 'intellij' } },
			})
		);
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.editor).toMatchObject({ codeTheme: 'intellij', syntaxStyles: true });
		await settings.save({ ...value, editor: { ...value.editor, syntaxStyles: false } });
		expect((await new Settings(root).read()).editor).toMatchObject({
			codeTheme: 'intellij',
			syntaxStyles: false,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('fills terminal settings a document saved before the font weight existed (spec/terminal-and-cli-agents#render-and-theme)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-'));
	try {
		await writeFile(
			join(root, 'settings.json'),
			JSON.stringify({
				schemaVersion: 1,
				settings: { ...defaultAppSettings, terminal: { scrollSpeed: 2 } },
			})
		);
		expect((await new Settings(root).read()).terminal).toEqual({ scrollSpeed: 2, fontWeight: 400 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('reads settings saved before remote access with the module on and access off, and keeps a partial block (spec/remote-access-and-mobile#module-and-settings)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-remote-'));
	try {
		const path = join(root, 'settings.json'),
			{ remoteAccess: _, ...previous } = defaultAppSettings,
			modules = { browser: true, simulator: false, pullRequests: true, commands: true };
		await writeFile(path, JSON.stringify({ schemaVersion: 1, settings: { ...previous, modules } }));
		const value = await new Settings(root).read();
		expect(value.modules.remoteAccess).toBe(true);
		expect(value.remoteAccess).toEqual({
			enabled: false,
			machineName: null,
			listen: { lan: true, tailscale: true },
			phone: false,
		});
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				settings: {
					...previous,
					modules,
					remoteAccess: { enabled: true, listen: { tailscale: false } },
				},
			})
		);
		expect((await new Settings(root).read()).remoteAccess).toEqual({
			enabled: true,
			machineName: null,
			listen: { lan: true, tailscale: false },
			// spec/remote-access-and-mobile#phone-network: a block written before the phone keeps it off.
			phone: false,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('spec/appearance#chat-text-size: a file from before the chat size follows the interface; an own size persists on the 0.5 grid', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-settings-chat-font-'));
	try {
		const path = join(root, 'settings.json'),
			{ chatFont: _, ...older } = defaultAppSettings;
		await writeFile(path, JSON.stringify({ schemaVersion: 1, settings: older }));
		const settings = new Settings(root),
			value = await settings.read();
		expect(value.chatFont).toEqual({ size: null });
		await settings.save({ ...value, chatFont: { size: 15.5 } });
		expect((await new Settings(root).read()).chatFont).toEqual({ size: 15.5 });
		for (const chatFont of [
			{ size: 7.5 },
			{ size: 24.5 },
			{ size: 13.3 },
			{ size: '13' },
			{},
			{ size: null, extra: 1 },
			null,
			13.5,
		])
			expect(isAppSettings({ ...value, chatFont })).toBe(false);
		expect(isAppSettings({ ...value, chatFont: { size: 8 } })).toBe(true);
		expect(isAppSettings({ ...value, chatFont: { size: 24 } })).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
