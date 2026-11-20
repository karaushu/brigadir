import { describe, expect, it } from 'vitest';
import {
	brigadirCards,
	brigadirChatTitle,
	isBrigadirChatRow,
	isBrigadirSetupLink,
	missingSlackScopes,
	slackManifest,
	slackManifestLink,
	type BrigadirChatRow,
} from './brigadir-chat';

describe('Brigadir chat (spec/settings-modules-and-onboarding#brigadir-chat)', () => {
	it('keeps the latest state of each card in the order cards came', () => {
		const rows: BrigadirChatRow[] = [
			{
				seq: 1,
				at: 'a',
				kind: 'card',
				card: { type: 'secret', id: 's', kind: 'slackBotToken', state: 'waiting' },
			},
			{
				seq: 2,
				at: 'b',
				kind: 'card',
				card: {
					type: 'link',
					id: 'l',
					url: 'u',
					label: 'x',
					title: 't',
					detail: 'd',
					opened: false,
				},
			},
			{
				seq: 3,
				at: 'c',
				kind: 'card',
				card: {
					type: 'secret',
					id: 's',
					kind: 'slackBotToken',
					state: 'connected',
					result: '@Jarvis',
				},
			},
		];
		expect(
			brigadirCards(rows).map((card) => `${card.id}:${'state' in card ? card.state : ''}`)
		).toEqual(['s:connected', 'l:']);
		expect(rows.every(isBrigadirChatRow)).toBe(true);
		expect(
			isBrigadirChatRow({ seq: 1, at: 'a', kind: 'card', card: { type: 'nope', id: 'x' } })
		).toBe(false);
	});
	it('names a chat from its first line', () => {
		expect(brigadirChatTitle('  налаштуй слак\nбот Jarvis')).toBe('налаштуй слак');
		expect(brigadirChatTitle('x'.repeat(100))).toHaveLength(80);
	});
	it('builds the Slack manifest link with every scope and event, and opens only Slack app pages', () => {
		const manifest = slackManifest('Jarvis');
		expect(manifest.features.bot_user.display_name).toBe('Jarvis');
		expect(manifest.settings.socket_mode_enabled).toBe(true);
		expect(manifest.oauth_config.scopes.bot).toContain('users:read');
		const link = slackManifestLink('Jarvis');
		expect(link.startsWith('https://api.slack.com/apps?new_app=1&manifest_json=')).toBe(true);
		expect(JSON.parse(decodeURIComponent(link.split('manifest_json=')[1]!))).toEqual(manifest);
		expect(isBrigadirSetupLink(link)).toBe(true);
		expect(isBrigadirSetupLink('https://api.slack.com/apps/A123/oauth')).toBe(true);
		expect(isBrigadirSetupLink('https://evil.example/apps')).toBe(false);
		expect(isBrigadirSetupLink('http://api.slack.com/apps')).toBe(false);
	});
	it('names the scopes a token lacks', () => {
		expect(missingSlackScopes('chat:write,users:read')).toContain('im:history');
		expect(missingSlackScopes(null)).toHaveLength(8);
	});
});

describe('Brigadir chat attachments (spec/composer#chat-composer)', () => {
	it("keeps the message's attachments in its row, within the prompt's limits", () => {
		const item = {
			id: '0b1c2d3e-0000-4000-8000-000000000001',
			name: 'shot.png',
			kind: 'image' as const,
			bytes: 10,
		};
		const row = { seq: 1, at: '2026-11-21T10:00:00Z', kind: 'prompt', text: 'see' };
		expect(isBrigadirChatRow({ ...row, attachments: [item] })).toBe(true);
		expect(isBrigadirChatRow({ ...row, attachments: Array(11).fill(item) })).toBe(false);
		expect(isBrigadirChatRow({ ...row, attachments: 'x' })).toBe(false);
	});
});
