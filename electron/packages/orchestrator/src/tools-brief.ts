import { simulatorQueued, type CrewProcessRole, type WorkspaceTools } from './tools';
/**
 * spec/agents-and-providers#tools-awareness: an agent uses only the tools it knows about. English by rule 12. Built from the modules that are on (spec/settings-modules-and-onboarding#module-off) and
 * the role of the session; a module switched off is never named. Three texts: the MCP `instructions`, a short line of
 * the first-prompt brief for Codex and the CLI, which may not show those instructions to the model, and the foreman's
 * sentence about its crew's tools.
 */
/** `a, b and c`; falsy items are left out. */
function words(items: readonly (string | false | undefined)[], last: 'and' | 'or'): string {
	const kept = items.filter((item): item is string => Boolean(item));
	return kept.length > 1
		? `${kept.slice(0, -1).join(', ')} ${last} ${kept.at(-1)}`
		: (kept[0] ?? '');
}
const sharedSimulator =
	'The device is shared with your crew: while another agent uses it, your call waits up to 60 seconds; if it is still busy, do other work and retry later.';
/** spec/agents-and-providers#tools-awareness: the `instructions` of `initialize`; the console line stays when every module is off (spec/terminal-and-cli-agents#agent-console-tools). */
export function toolsInstructions(role: CrewProcessRole | null, tools: WorkspaceTools): string {
	const lines: string[] = [];
	if (tools.browser)
		lines.push(
			'- A real browser in the window of this task (browser_*). After you change anything a person sees in a web app, open the page yourself with browser_open, check it with browser_ui and browser_screenshot, and click, type and navigate with browser_act. Read browser_console and browser_network when something looks wrong. Local pages need no permission.'
		);
	if (tools.simulator)
		lines.push(
			`- The project simulator, an iOS Simulator or Android Emulator device (simulator_*). For a React Native or other mobile app, check your change on the device: simulator_open, simulator_ui, simulator_act, simulator_screenshot, simulator_logs.${simulatorQueued(role) ? ` ${sharedSimulator}` : ''}`
		);
	if (tools.commands)
		lines.push(
			"- The project's saved commands (commands_*): dev servers, builds, tests and scripts the person runs from the toolbar. Call commands_list before you start one yourself and run it with commands_run, not with your shell: it runs in the console of this task, where the person sees it, and gives you its local address. Use your shell only when no saved command fits."
		);
	// spec/terminal-and-cli-agents#agent-console-tools: the console is in every task, so this line is always there.
	lines.push(
		'- The console of this task (console_*): the terminal tabs the person opened beside you, with the dev servers, logs and commands they run there. When the person mentions the console, a log, an error on their screen or a server they started, call console_list and read it with console_read instead of asking them to paste the output.'
	);
	const asks = words(
			[
				tools.browser && 'open a page',
				tools.simulator && 'tap through the app',
				tools.commands && 'start a server',
				'paste the console output',
			],
			'or'
		),
		places = words(
			[tools.browser && 'in the browser', tools.simulator && 'on the simulator'],
			'and'
		),
		seen = [places && `every action you take ${places}`, tools.commands && 'every command you run']
			.filter(Boolean)
			.join(', and ');
	return [
		'Brigadir, the app this session runs in, gives you tools a person would otherwise use for you:',
		...lines,
		`Check yourself what these tools can check: do not ask the person to ${asks} for you.${seen ? ` The person sees ${seen}.` : ''}`,
		...(role === 'foreman' || role === 'lead'
			? [
					'Your agents have the same tools: when a part changes what a person sees, its prompt says how the agent checks it.',
				]
			: []),
	].join('\n');
}
/** spec/agents-and-providers#tools-awareness: the same in one paragraph of the first-prompt brief; it names the console in any case (spec/terminal-and-cli-agents#agent-console-tools). */
export function toolsBrief(role: CrewProcessRole | null, tools: WorkspaceTools): string {
	const named = [
		tools.browser && 'a real browser (browser_open, browser_ui, browser_screenshot, browser_act)',
		tools.simulator && 'the project simulator for a React Native or mobile app (simulator_*)',
		tools.commands && "the project's saved commands (commands_*)",
		'the console of this task (console_list, console_read)',
	];
	const list = words(named, 'and');
	const check =
		tools.browser || tools.simulator
			? ` After a change a person can see, check it yourself: open the ${words([tools.browser && 'page', tools.simulator && 'app'], 'or')}, look at it and click through it. Do not ask the person to check what you can check; they see each of your actions.`
			: '';
	const queue =
		tools.simulator && simulatorQueued(role)
			? ' The simulator is shared with your crew: a call may wait for it, and if it stays busy, retry later.'
			: '';
	return `This app gives you ${list}.${check}${queue}`;
}
/** spec/agents-and-providers#tools-awareness: the foreman plans the check into each part; empty when no module is on. */
export function crewToolsBrief(tools: WorkspaceTools): string {
	const named = [
		tools.browser && 'a real browser (browser_*)',
		tools.simulator && 'the project simulator (simulator_*)',
		tools.commands && "the project's saved commands (commands_*)",
	];
	const list = words(named, 'and');
	if (!list) return '';
	const checks = [
		tools.browser &&
			'a part that changes a web page says that the agent opens the page in the browser and checks it',
		tools.simulator &&
			'a part that changes the mobile app says that the agent checks it on the simulator after implementing',
		tools.commands &&
			'a part that needs a dev server, a build or the tests says that the agent runs them as project commands',
	].filter(Boolean);
	return [
		`Your agents have ${list}, as you do. Put the check into the plan: ${checks.join('; ')}.`,
		...(tools.simulator ? ['The simulator is one device: your agents take it in turns.'] : []),
	].join(' ');
}
