import { describe, expect, it } from 'vitest';
import { defaultAppSettings, textSurfaces, type MachineAppearance } from '@brigadir/core';
import { RoutedNotices } from './remote-notices';
import { composeAppearance } from './appearance';
import type { Client } from './clients';
import type { Notice, NoticeGateway } from './notifications';

const notice: Notice = {
	id: 'n1',
	groupId: 'project/task',
	kind: 'needs-you',
	key: { projectId: 'project', id: 'task' },
	title: 'Fix',
	body: 'Waits for you',
	actions: { allow: 'Allow', deny: 'Deny' },
};
function local() {
	const shown: string[] = [];
	const gateway: NoticeGateway = {
		supported: () => true,
		show: (item) => {
			shown.push(item.id);
			return { close: () => {} };
		},
		removeGroup: () => {},
	};
	return { gateway, shown };
}
describe('notices of a machine under a device (spec/remote-access-and-mobile#client-ui-seam)', () => {
	it('go to the device in control and come back as its Allow; without one they stay here', () => {
		const here = local(),
			sent: { channel: string; value: any }[] = [];
		let target: Client | null = null;
		const routed = new RoutedNotices(here.gateway, () => target);
		const device: Client = {
			id: 'peer',
			local: false,
			device: { id: 'd', name: 'ThinkPad' },
			send: (channel, value) => {
				sent.push({ channel, value });
				return true;
			},
			owns: () => false,
		};
		routed.show(notice, { open: () => {}, allow: () => {}, deny: () => {} });
		expect(here.shown).toEqual(['n1']);
		target = device;
		const answers: string[] = [];
		const handle = routed.show(notice, {
			open: () => answers.push('open'),
			allow: () => answers.push('allow'),
			deny: () => answers.push('deny'),
		});
		expect(sent[0]).toMatchObject({
			channel: 'remote:notify',
			value: { kind: 'show', notice: { id: 'n1' } },
		});
		const id = sent[0]!.value.id;
		routed.act({ ...device, id: 'other' }, id, 'allow');
		routed.act(device, id, 'allow');
		routed.act(device, id, 'deny');
		expect(answers).toEqual(['allow']);
		handle!.close();
		expect(sent.at(-1)).toEqual({ channel: 'remote:notify', value: { kind: 'close', id } });
		const played: string[] = [];
		routed.sounds({ play: (name) => played.push(name) }).play('Glass');
		expect(played).toEqual([]);
		expect(sent.at(-1)).toEqual({
			channel: 'remote:notify',
			value: { kind: 'sound', name: 'Glass' },
		});
		target = null;
		routed.sounds({ play: (name) => played.push(name) }).play('Glass');
		expect(played).toEqual(['Glass']);
	});
});
describe('the appearance of a window of another machine (spec/remote-access-and-mobile#client-ui-seam)', () => {
	it('takes the machine settings with this device theme and fonts', () => {
		const typography = structuredClone(defaultAppSettings.typography);
		typography[textSurfaces[0]!].family = 'Machine Mono';
		const machine = {
			suggestNextPrompt: true,
			modules: defaultAppSettings.modules,
			accentColor: defaultAppSettings.accent,
			locale: 'uk',
			toolbarLabels: defaultAppSettings.toolbarLabels,
			interfaceFont: { ...defaultAppSettings.interfaceFont, family: 'Inter' },
			typography,
			diffBase: defaultAppSettings.editor.diffBase,
			notificationMode: defaultAppSettings.notifications.mode,
			editing: {
				languageServers: true,
				closeBrackets: true,
				closeTags: true,
				callParens: true,
			},
		} as MachineAppearance;
		const result = composeAppearance(
			machine,
			{ fonts: [{ family: 'Inter', mono: false }] } as never,
			true,
			'0a84ffff'
		);
		expect(result.locale).toBe('uk');
		expect(result.dark).toBe(true);
		expect(result.accent).toBe('0a84ffff');
		expect(result.interfaceFont.family).toBe('Inter');
		// The missing family falls back to the OS mono, as the notice says; Geist (null) and the OS fonts are never missing.
		expect(result.typography[textSurfaces[0]!].family).toBe('ui-monospace');
		expect(result.typography[textSurfaces[1]!].family).toBeNull();
		expect(result.missingFonts).toEqual(['Machine Mono']);
		expect(machine.typography[textSurfaces[0]!].family).toBe('Machine Mono');
		expect(
			composeAppearance(
				{
					...machine,
					interfaceFont: { ...machine.interfaceFont, family: 'system-ui' },
					typography: {
						...typography,
						[textSurfaces[0]!]: { ...typography[textSurfaces[0]!], family: 'ui-monospace' },
					},
				},
				{ fonts: [] } as never,
				false,
				'0a84ffff'
			)
		).toMatchObject({ missingFonts: [], interfaceFont: { family: 'system-ui' } });
	});
});
