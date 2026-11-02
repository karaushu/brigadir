import { isRecord } from './workspace';
import { isBrowserActRequest, type BrowserAction, type BrowserActRequest } from './browser-agent';
import { isBrowserTabId } from './document-tabs';
export type BrowserState = {
	url: string;
	title: string;
	loading: boolean;
	mobile: boolean;
	picking: boolean;
	back: boolean;
	forward: boolean;
	error: string | null;
	/** spec/browser-and-simulator#background: the agent works with this page — its last browser call was less than 60 s ago. */
	agent: boolean;
	/** spec/browser-and-simulator#notifications: the page's domain and what the person decided for its notifications; `asking` — the strip over the page. */
	notifications: {
		host: string;
		permission: BrowserNotificationPermission;
		asking: boolean;
	} | null;
};
/** spec/browser-and-simulator#notifications: a domain's notifications — `default` until the person decides. */
export type BrowserNotificationPermission = 'default' | 'granted' | 'denied';
/** spec/browser-and-simulator#network-streams: the drawer shows Fetch and XHR (spec/browser-and-simulator#console-network); EventSource, WebSocket and a page that is itself an event stream reach only browser_network. */
export type BrowserRequest = {
	method: string;
	url: string;
	type: 'Fetch' | 'XHR' | 'EventSource' | 'WebSocket' | 'Document';
	status: number | null;
	duration: number | null;
	bytes: number | null;
	state: 'pending' | 'streaming' | 'done' | 'failed';
	/** Only in an agent's reply, worked out when asked: ms the request has been open, bytes received so far, messages of a stream. */
	elapsed?: number;
	received?: number;
	messages?: number;
};
/** One event of an event stream or one WebSocket frame: ms after the request started, data up to 2 KiB. */
export type BrowserStreamMessage = {
	ms: number;
	direction: 'in' | 'out';
	event?: string;
	id?: string;
	data: string;
	truncated?: true;
};
export type BrowserNetworkDetails = {
	request: BrowserRequest;
	headers: Record<string, string>;
	body: string | null;
	truncated: boolean;
	error: string | null;
	messages?: BrowserStreamMessage[];
	messageCount?: number;
};
export type BrowserLog = {
	id: string;
	kind: 'console' | 'network';
	text: string;
	at: number;
	error: boolean;
	request?: BrowserRequest;
	failure?: string;
};
/** spec/task-window-workspace#work-area: `tab` — the browser tab of the task the event is about; a task holds as many as it needs. */
export type BrowserEvent = {
	tab: string;
	state: BrowserState;
	logs: BrowserLog[];
	node?: string;
	nodeToken?: string;
	/** spec/browser-and-simulator#notifications: the page showed a notification while its tab is in front — a toast. */
	notice?: BrowserPageNotice;
};
export type BrowserPageNotice = { id: number; title: string; body: string; host: string };
/** spec/task-window-workspace#work-area.1: what the agent does on a page — the bar over it and the tab name it; the renderer words it. */
export type BrowserAgentStep = {
	kind: BrowserAction | 'open' | 'read' | 'ui' | 'screenshot';
	target: string | null;
};
/** `acting` — the step now; `step` — the last one; `waiting` — the next step held while the person types or holds the mouse (spec/task-window-workspace#work-area.1);
 *  `last` — when the agent last acted (ms epoch); `count` — its steps on this page. */
export type BrowserAgentState = {
	acting: BrowserAgentStep | null;
	/** The last step taken, for the bar while the agent stays with the page. */ step: BrowserAgentStep | null;
	waiting: BrowserAgentStep | null;
	last: number;
	count: number;
};
/** One browser tab as the work area lists it, on screen or not: the strip's name, the Tools list and the agent's state. */
export type BrowserTabInfo = {
	tab: string;
	url: string;
	title: string;
	loading: boolean;
	agent: BrowserAgentState | null;
	/** spec/browser-and-simulator#tab-sound: the page plays sound now; the person muted the tab. */
	audible: boolean;
	muted: boolean;
};
/** spec/task-window-workspace#work-area: `tab` names the browser tab; the agent may leave it out (its own tab) and `open` with `new` makes one. */
export type BrowserCommand = (
	| { kind: 'bind-node'; token: string; attachmentId: string }
	| { kind: 'retain-nodes'; attachmentIds: string[] }
	/** `snapshot` (spec/task-window-workspace#work-area): hiding under an overlay answers with the page's picture to stand in its place. */
	| {
			kind: 'mount';
			visible: boolean;
			x: number;
			y: number;
			width: number;
			height: number;
			snapshot?: boolean;
	  }
	| { kind: 'open'; url: string }
	| { kind: 'mode'; mobile: boolean }
	| { kind: 'ui'; offset?: number }
	| ({ kind: 'act' } & BrowserActRequest)
	/** The task's browser tabs as main knows them. */
	| { kind: 'tabs' }
	/** spec/browser-and-simulator#notifications: the person's answer for the page's domain; `dismiss` — `×` on the strip. */
	| { kind: 'notifications'; decision: BrowserNotificationPermission | 'dismiss' }
	/** spec/browser-and-simulator#tab-sound: the person mutes or unmutes the tab. */
	| { kind: 'mute'; muted: boolean }
	/** spec/browser-and-simulator#notifications: the person clicked the toast of the page's notification. */
	| { kind: 'notification-click'; id: number }
	| {
			kind:
				| 'external'
				| 'state'
				| 'back'
				| 'forward'
				| 'reload'
				| 'read'
				| 'console'
				| 'network'
				| 'screenshot'
				| 'pick'
				| 'inspect'
				| 'discard'
				| 'focus';
			selector?: string;
			requestId?: string;
	  }
) & { tab?: string };
export function isBrowserCommand(value: unknown): value is BrowserCommand {
	if (!isRecord(value)) return false;
	if (
		value.tab !== undefined &&
		!isBrowserTabId(value.tab) &&
		!(value.kind === 'open' && value.tab === 'new')
	)
		return false;
	// The checks below count a command's own keys; the tab is checked above.
	if (value.tab !== undefined) {
		const { tab: _tab, ...rest } = value;
		return isBrowserCommand(rest);
	}
	if (value.kind === 'tabs') return Object.keys(value).length === 1;
	const uuid = (id: unknown) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
	if (value.kind === 'bind-node') return uuid(value.token) && uuid(value.attachmentId);
	if (value.kind === 'retain-nodes')
		return (
			Array.isArray(value.attachmentIds) &&
			value.attachmentIds.length <= 10 &&
			value.attachmentIds.every(uuid)
		);
	if (value.kind === 'open')
		return typeof value.url === 'string' && value.url.length > 0 && value.url.length <= 8192;
	if (value.kind === 'mode') return typeof value.mobile === 'boolean';
	if (value.kind === 'mute')
		return Object.keys(value).length === 2 && typeof value.muted === 'boolean';
	if (value.kind === 'notification-click')
		return (
			Object.keys(value).length === 2 && Number.isSafeInteger(value.id) && Number(value.id) > 0
		);
	if (value.kind === 'notifications')
		return (
			Object.keys(value).length === 2 &&
			['default', 'granted', 'denied', 'dismiss'].includes(String(value.decision))
		);
	// spec/browser-and-simulator#browser-ui-act: the agent's tree and actions.
	if (value.kind === 'ui')
		return (
			Object.keys(value).every((key) => key === 'kind' || key === 'offset') &&
			(value.offset === undefined ||
				(Number.isSafeInteger(value.offset) && Number(value.offset) >= 0))
		);
	if (value.kind === 'act') {
		const { kind: _kind, ...request } = value;
		return isBrowserActRequest(request);
	}
	if (value.kind === 'mount')
		return (
			typeof value.visible === 'boolean' &&
			(value.snapshot === undefined || typeof value.snapshot === 'boolean') &&
			['x', 'y', 'width', 'height'].every(
				(key) =>
					Number.isFinite(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 20000
			)
		);
	return (
		[
			'external',
			'state',
			'back',
			'forward',
			'reload',
			'read',
			'console',
			'network',
			'screenshot',
			'pick',
			'inspect',
			'discard',
			'focus',
		].includes(String(value.kind)) &&
		(value.requestId === undefined ||
			(value.kind === 'network' &&
				typeof value.requestId === 'string' &&
				/^network-[0-9]{1,12}$/.test(value.requestId))) &&
		(value.selector === undefined ||
			(typeof value.selector === 'string' && value.selector.length <= 500))
	);
}
