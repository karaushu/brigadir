import { expect, it } from 'vitest';
import {
	defaultSlackSettings,
	dotenvToken,
	isSlackSettings,
	slackDuration,
	slackEnvironment,
	slackMention,
	slackPermalinkTarget,
	slackTaskAgent,
	slackText,
	withSlackDefaults,
} from './slack';

const task = { projectId: 'p', id: 't', title: 'Phone validation' };
const token = 'xoxb-1234567890-abcdefghij';

it('reads the bot token from a dotenv file as watch-ci does', () => {
	expect(dotenvToken(`# bot\nOTHER=1\nexport SLACK_CI_BOT_TOKEN="${token}"\n`)).toBe(token);
	expect(dotenvToken(`SLACK_CI_BOT_TOKEN=${token} # mine`)).toBe(token);
	expect(dotenvToken('SLACK_CI_BOT_TOKEN=xoxp-user-token')).toBeNull();
	expect(dotenvToken('# SLACK_CI_BOT_TOKEN=' + token)).toBeNull();
});

it('writes a failed run in the watch-ci lines, with the run link and the error only when it did not pass', () => {
	const failed = slackText({
		kind: 'ci',
		state: 'fail',
		repo: 'business',
		branch: 'claude/phone',
		environment: null,
		task,
		seconds: 372,
		link: 'https://github.com/o/business/actions/runs/1',
		error: 'signup.spec.ts:48\nExpected "+380…"\nline 3\nline 4',
	});
	expect(failed.split('\n')).toEqual([
		'❌ *CI failed* — business (`claude/phone`)',
		'🌐 Environment: *claude/phone*',
		'📋 Task: Phone validation',
		'⏱️ Duration: 6m 12s',
		'🔗 <https://github.com/o/business/actions/runs/1|View run>',
		'```signup.spec.ts:48',
		'Expected "+380…"',
		'line 3```',
	]);
	const passed = slackText(
		{
			kind: 'ci',
			state: 'pass',
			repo: 'business',
			branch: 'staging',
			environment: null,
			task: null,
			seconds: 30,
			link: 'x',
			error: 'no',
		},
		slackMention('S05UAUB2GVD')
	);
	expect(passed).toBe(
		'<!subteam^S05UAUB2GVD>\n✅ *CI passed* — business (`staging`)\n🌐 Environment: *Staging*\n⏱️ Duration: 30s'
	);
});

it('escapes Slack’s three characters so a title never becomes a link or a mention', () => {
	expect(
		slackText({
			kind: 'taskDone',
			repo: 'a',
			branch: 'b',
			task: { ...task, title: '<!channel> & co' },
			summary: null,
		})
	).toContain('📋 Task: &lt;!channel&gt; &amp; co');
});

it('names the environment, the duration and the group mention as watch-ci does', () => {
	expect([slackEnvironment('main'), slackEnvironment('master'), slackEnvironment('feat')]).toEqual([
		'Production',
		'Production',
		'feat',
	]);
	expect([slackDuration(5), slackDuration(3725)]).toEqual(['5s', '1h 2m']);
	expect([slackMention('<!subteam^S1AB|qateam>'), slackMention('@qateam')]).toEqual([
		'<!subteam^S1AB>',
		'',
	]);
});

it('checks the settings and fills an event a file did not have', () => {
	expect(isSlackSettings(defaultSlackSettings)).toBe(true);
	expect(isSlackSettings({ ...defaultSlackSettings, memberId: 'nope' })).toBe(false);
	expect(withSlackDefaults({ memberId: 'U1AB', events: { ci: false }, projects: {} })).toEqual({
		...defaultSlackSettings,
		memberId: 'U1AB',
		events: { ...defaultSlackSettings.events, ci: false },
	});
});

it('loads a file from before «Agent for tasks» as the same as the app, and checks the agent it keeps', () => {
	const old = {
		...defaultSlackSettings,
		mentions: { on: true, who: 'people', people: [], start: 'ask' },
	};
	const loaded = withSlackDefaults(old) as typeof defaultSlackSettings;
	expect(loaded.mentions.agent).toBeNull();
	expect(isSlackSettings(loaded)).toBe(true);
	const agent = { provider: 'codex' as const, model: 'gpt-6', effort: 'high' };
	const mentions = { ...defaultSlackSettings.mentions, agent };
	expect(isSlackSettings({ ...defaultSlackSettings, mentions })).toBe(true);
	expect(
		isSlackSettings({
			...defaultSlackSettings,
			mentions: { ...mentions, agent: { ...agent, model: '' } },
		})
	).toBe(false);
	expect(
		isSlackSettings({
			...defaultSlackSettings,
			mentions: { ...mentions, agent: { provider: 'gemini', model: 'x', effort: null } },
		})
	).toBe(false);
});

it('starts a Slack task with the Slack agent while its provider is on and its model is listed, else the app’s', () => {
	const on = { claude: true, codex: true },
		agent = { provider: 'codex' as const, model: 'gpt-6', effort: 'high' };
	expect(slackTaskAgent({ agent: null }, on, 'claude')).toEqual({ provider: 'claude', run: null });
	expect(slackTaskAgent({ agent }, on, 'claude')).toEqual({ provider: 'codex', run: agent });
	expect(slackTaskAgent({ agent }, { claude: true, codex: false }, 'claude')).toEqual({
		provider: 'claude',
		run: null,
	});
	// A known catalog without the model: the default; a catalog not known yet never makes it unavailable.
	expect(slackTaskAgent({ agent }, on, 'claude', { codex: ['gpt-5'] }).run).toBeNull();
	expect(slackTaskAgent({ agent }, on, 'claude', { codex: null }).run).toEqual(agent);
});

it('names the repo alone when the task has no branch of its own', () => {
	expect(slackText({ kind: 'taskDone', repo: 'b2c', branch: '', task, summary: null })).toBe(
		'🏁 *Turn ended* — b2c\n📋 Task: Phone validation'
	);
});

it('reads a Slack message link as the channel and the ts to answer in', () => {
	expect(
		slackPermalinkTarget('https://acme.slack.com/archives/C0BC02W9WLW/p1793884455669649')
	).toEqual({ channel: 'C0BC02W9WLW', ts: '1793884455.669649' });
	expect(
		slackPermalinkTarget(
			'https://acme.slack.com/archives/C0B/p1793884455669649?thread_ts=1793884400.000100&cid=C0B'
		)
	).toEqual({ channel: 'C0B', ts: '1793884400.000100' });
	expect(slackPermalinkTarget('1793884455.669649')).toBeNull();
});
