/**
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-network, spec/remote-access-and-mobile#phone-app: the phone's sign-in page — the only code the web listener gives without a
 * sign-in. Pairing: the machine's code 4 + 4 through CPace, then the phone's name and a
 * passkey for the machine's tailnet name; on iPhone in Safari the Home Screen step. Each visit: «Увійти» with the passkey, then
 * the app's files with the cookie the signed-in socket earned, and the app gets this very socket. The states: the machine
 * asleep or unreachable, the session ended, the phone revoked.
 */
import './signin.css';
import { normalizePairingCode, selectLocale, t, type MessageKey } from '@brigadir/core';
import {
	CPaceParty,
	fromBase64,
	fromBase64Url,
	toBase64,
	toBase64Url,
	webChannelIdentifier,
	type WebMessage,
} from '@brigadir/remote/web';
import { Connection, readMessages, send, socketUrl, type Welcome } from './connection';
import { icon, type SigninIcon } from './signin-icons';

const locale = selectLocale(navigator.language);
const say = (key: MessageKey, fill: Record<string, string> = {}) =>
	Object.entries(fill).reduce(
		(text, [name, value]) => text.replaceAll(`{${name}}`, value),
		t(locale, key)
	);
const root = document.getElementById('root')!;
document.documentElement.lang = locale;
const android = /Android/.test(navigator.userAgent),
	ios = /iPhone|iPad/.test(navigator.userAgent);
document.documentElement.dataset.platform = android ? 'android' : 'ios';
const dark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => {
	let choice: string | null = null;
	try {
		choice = localStorage.getItem('brigadir.theme');
	} catch {
		choice = null;
	}
	const value = choice === 'light' || choice === 'dark' ? choice : dark.matches ? 'dark' : 'light';
	document.documentElement.dataset.theme = value;
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute('content', value === 'dark' ? '#1e1e1e' : '#ffffff');
};
theme();
dark.addEventListener('change', theme);
const utf8 = (text: string) => new TextEncoder().encode(text);
const buffer = (bytes: Uint8Array) => bytes.slice().buffer;

/** What this browser remembers of its pairing: none of it is a secret (spec/remote-access-and-mobile#phone-network). */
const remembered = {
	read(name: 'passkey' | 'machine' | 'device' | 'signed-in'): string | null {
		try {
			return localStorage.getItem(`brigadir.${name}`);
		} catch {
			return null;
		}
	},
	write(name: 'passkey' | 'machine' | 'device' | 'signed-in', value: string | null) {
		try {
			if (value === null) localStorage.removeItem(`brigadir.${name}`);
			else localStorage.setItem(`brigadir.${name}`, value);
		} catch {
			// Storage blocked: the browser offers the keys itself next time.
		}
	},
};
let machine = remembered.read('machine') ?? '';
let challenge: { ws: WebSocket; message: Extract<WebMessage, { t: 'challenge' }> } | null = null;
let unmount: (() => void) | null = null;

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> & { data?: Record<string, string> } = {},
	...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	const { data, ...rest } = props;
	Object.assign(node, rest);
	for (const [key, value] of Object.entries(data ?? {})) node.dataset[key] = value;
	node.append(...children.filter((child): child is Node | string => Boolean(child)));
	return node;
}
const space = () => element('span', { className: 'sp' });
/** One screen of the page (the body centred); `top` is its first spacer. */
function show(
	state: string,
	layout: 'centre' | 'state' | 'name',
	...children: (Node | null | false)[]
) {
	unmount?.();
	unmount = null;
	root.dataset.state = state;
	root.replaceChildren(element('div', { className: `page ${layout}` }, ...children));
}
const logo = (size: 72 | 84) =>
	element('div', { className: `logo s${size}` }, icon('helmet', size === 84 ? 52 : 45));
const head = (title: string, sub?: string) =>
	element(
		'div',
		{ className: 'head' },
		element('h1', {}, title),
		sub ? element('p', {}, sub) : null
	);
const caption = (text: string, tone: 'plain' | 'error' | 'ok' = 'plain') =>
	element(
		'p',
		{ className: `cap ${tone}`, data: { note: tone === 'error' ? 'error' : 'plain' } },
		text
	);
function button(
	text: string,
	look: 'solid' | 'ghost',
	data: Record<string, string> = {},
	glyph?: SigninIcon
): HTMLButtonElement {
	return element(
		'button',
		{ type: 'button', className: `btn ${look === 'solid' ? 'xl solid wide' : 'ghost'}`, data },
		...(glyph ? [icon(glyph, look === 'solid' ? (glyph === 'key' ? 20 : 22) : 18)] : []),
		text
	);
}
const machineName = () => machine || t(locale, 'Brigadir');

// —— sign-in ——

function loginRefusal(reason: Extract<WebMessage, { t: 'refused' }>['reason']): string {
	switch (reason) {
		case 'unknown':
		case 'expired':
			return say('This passkey is not paired with {machine}. Pair the phone again.', {
				machine: machineName(),
			});
		case 'wait':
			return say('Try again in a moment.');
		case 'passkey':
			return say('The passkey was not accepted.');
		case 'blocked':
			return say('This phone is blocked on {machine}. Unblock it there.', {
				machine: machineName(),
			});
		case 'off':
			return say('Access from a phone is off on {machine}.', { machine: machineName() });
	}
}
/** Sign-in: a fresh challenge on its own socket; «Увійти» calls WebAuthn at once on a tap (Safari wants the gesture). */
function openLogin(error: string | null = null) {
	challenge?.ws.close();
	challenge = null;
	const device = remembered.read('device');
	const signin = button(
		t(locale, 'Sign in'),
		'solid',
		{ signin: '' },
		android ? 'finger' : 'faceid'
	);
	signin.disabled = true;
	signin.setAttribute('aria-label', say('Sign in with a passkey'));
	const reach = element('i', { className: 'dot' });
	const pair = button(say(device ? 'Pair again' : 'Pair this phone'), 'ghost', { pairOpen: '' });
	pair.addEventListener('click', () => {
		history.pushState({ page: 'pair' }, '');
		openPairing();
	});
	show(
		'signin',
		'centre',
		element('span', { className: 'gap70' }),
		logo(84),
		element('div', { className: 'brand' }, t(locale, 'Brigadir')),
		element('div', { className: 'where' }, icon('machine', 18), machineName(), reach, 'Tailscale'),
		error ? caption(error, 'error') : null,
		space(),
		signin,
		device ? caption(say('{device} · passkey', { device })) : null,
		pair
	);
	let opened = false;
	const ws = new WebSocket(socketUrl('/ws'));
	ws.addEventListener('open', () => (opened = true));
	readMessages(ws, (message) => {
		if (message.t === 'challenge') {
			challenge = { ws, message };
			if (!machine) machine = message.rpId.split('.')[0] ?? '';
			reach.dataset.on = '';
			signin.disabled = false;
		} else if (message.t === 'welcome') void signedIn(ws, message);
		else if (message.t === 'refused') {
			if (message.reason === 'unknown') remembered.write('passkey', null);
			openLogin(loginRefusal(message.reason));
		}
	});
	ws.addEventListener('close', () => {
		// Never reached the machine: it sleeps, Tailscale is off, or Brigadir is not running there.
		if (!opened && root.dataset.state === 'signin' && challenge === null) return openAsleep();
		if (challenge?.ws === ws) {
			challenge = null;
			signin.disabled = true;
		}
	});
	signin.addEventListener('click', () => void assert(signin));
}
async function assert(trigger: HTMLButtonElement) {
	const current = challenge;
	if (!current) return;
	trigger.disabled = true;
	let credential: PublicKeyCredential | null;
	try {
		const known = remembered.read('passkey');
		credential = (await navigator.credentials.get({
			publicKey: {
				challenge: buffer(fromBase64Url(current.message.challenge)),
				rpId: current.message.rpId,
				userVerification: 'required',
				timeout: current.message.timeoutMs,
				...(known
					? { allowCredentials: [{ type: 'public-key', id: buffer(fromBase64Url(known)) }] }
					: {}),
			},
		})) as PublicKeyCredential | null;
	} catch {
		credential = null;
	}
	if (!credential) {
		trigger.disabled = false;
		return;
	}
	const response = credential.response as AuthenticatorAssertionResponse;
	send(current.ws, {
		t: 'assert',
		id: toBase64Url(new Uint8Array(credential.rawId)),
		clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
		authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
		signature: toBase64Url(new Uint8Array(response.signature)),
		userHandle: response.userHandle ? toBase64Url(new Uint8Array(response.userHandle)) : null,
	});
}
async function signedIn(ws: WebSocket, welcome: Welcome) {
	challenge = null;
	machine = welcome.machine;
	remembered.write('machine', welcome.machine);
	remembered.write('device', welcome.device);
	remembered.write('signed-in', String(Date.now()));
	const connection = new Connection(ws, welcome);
	connection.onEnd = (reason) => {
		if (reason === 'revoked') openRevoked();
		else if (reason === 'expired' || reason === 'replaced') openExpired();
		else openLogin();
	};
	// The app's files open with the cookie this socket earns; the app gets the socket itself.
	const session = await fetch('/session', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ticket: welcome.ticket }),
		credentials: 'same-origin',
	}).catch(() => null);
	if (!session?.ok) return openLogin(say('{machine} does not answer.', { machine: machineName() }));
	for (const href of welcome.app.styles)
		document.head.append(element('link', { rel: 'stylesheet', href }));
	const app = (await import(/* @vite-ignore */ welcome.app.script)) as {
		mount(root: HTMLElement, connection: Connection, locale: 'en' | 'uk'): () => void;
	};
	unmount = app.mount(root, connection, locale);
}

// —— the states ——

function statePage(
	state: string,
	glyph: SigninIcon,
	title: string,
	text: string,
	action: HTMLButtonElement,
	extra: (Node | null)[] = []
) {
	show(
		state,
		'state',
		element('span', { className: 'gap50' }),
		element('div', { className: 'badge' }, icon(glyph, 36)),
		head(title, text),
		...extra,
		space(),
		action
	);
}
function openAsleep() {
	const retry = button(say('Try again (asleep)'), 'solid', { retry: '' });
	retry.addEventListener('click', () => openLogin());
	const last = Number(remembered.read('signed-in'));
	const checks = element(
		'div',
		{ className: 'grp checks' },
		...[
			say('{machine} is on and awake', { machine: machineName() }),
			say('Tailscale is on on this phone'),
			say('Brigadir is running on {machine}', { machine: machineName() }),
		].map((text) => element('div', { className: 'srow check' }, element('i'), text))
	);
	statePage(
		'asleep',
		'moon',
		say('{machine} is asleep or unreachable', { machine: machineName() }),
		say('Could not connect.'),
		retry,
		[checks]
	);
	if (last)
		root.querySelector('.page')?.append(
			caption(
				say('Last successful sign-in: {time}', {
					time: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
						last
					),
				})
			)
		);
}
function openExpired() {
	const again = button(
		t(locale, 'Sign in'),
		'solid',
		{ signin: '' },
		android ? 'finger' : 'faceid'
	);
	again.addEventListener('click', () => openLogin());
	statePage(
		'expired',
		'lock',
		say('The session has ended'),
		say('Sign in again with the same passkey.'),
		again
	);
}
function openRevoked() {
	const again = button(say('Pair again'), 'solid', { pairOpen: '' });
	again.addEventListener('click', () => {
		history.pushState({ page: 'pair' }, '');
		openPairing();
	});
	statePage(
		'revoked',
		'x2',
		say('This phone was revoked on {machine}', { machine: machineName() }),
		say('To come back, open «Add device» on {machine} and pair the phone again.', {
			machine: machineName(),
		}),
		again
	);
}

// —— pairing ——

function pairRefusal(
	reason: Extract<WebMessage, { t: 'pair-refused' }>['reason'],
	left: number | null
): string {
	switch (reason) {
		case 'code':
			return left === null
				? say('The code did not match.')
				: `${say('The code did not match.')} ${attemptsLeft(left)}`;
		case 'closed':
		case 'off':
			return say('Pairing is not open on {machine}.', { machine: machineName() });
		case 'exhausted':
			return say('Too many wrong codes. Open pairing on {machine} again.', {
				machine: machineName(),
			});
		case 'declined':
			return say('Declined on {machine}.', { machine: machineName() });
		case 'busy':
			return say('Another device is pairing now.');
		case 'passkey':
			return say('The passkey was not accepted.');
	}
}
/** «Лишилось 3 спроби»: four plural forms for uk (rule 9). */
function attemptsLeft(count: number): string {
	const form = new Intl.PluralRules(locale).select(count) as 'one' | 'few' | 'many' | 'other';
	const uk = {
		one: 'Лишилась {n} спроба.',
		few: 'Лишилось {n} спроби.',
		many: 'Лишилось {n} спроб.',
		other: 'Лишилось {n} спроби.',
	};
	const en = {
		one: '{n} attempt left.',
		few: '{n} attempts left.',
		many: '{n} attempts left.',
		other: '{n} attempts left.',
	};
	return (locale === 'uk' ? uk : en)[form].replace(
		'{n}',
		new Intl.NumberFormat(locale).format(count)
	);
}
/** The phone's name for the machine's list: what the system calls it, at least its kind. */
function phoneName(): string {
	const agent = navigator.userAgent;
	if (/iPhone/.test(agent)) return 'iPhone';
	if (/iPad/.test(agent)) return 'iPad';
	if (/Android/.test(agent)) return 'Android';
	return locale === 'uk' ? 'Телефон' : 'Phone';
}
/** Eight cells, 4 + 4, over one `one-time-code` field (`.code8`). */
function codeCells(value: string, state: 'edit' | 'error' | 'ok') {
	const cells = element('div', {
		className: `code8 ${state === 'edit' ? '' : state}`,
		data: { codeCells: '' },
	});
	cells.setAttribute('aria-hidden', 'true');
	for (let index = 0; index < 8; index++) {
		if (index === 4) cells.append(element('i'));
		const char = value[index] ?? '';
		cells.append(
			element(
				'span',
				{ className: state === 'edit' && index === value.length ? 'f' : '' },
				char,
				state === 'edit' && index === value.length && !char
					? element('span', { className: 'caret' })
					: null
			)
		);
	}
	return cells;
}
const cleanCode = (text: string) =>
	text
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '')
		.slice(0, 8);
function openPairing(error: string | null = null, typed = '') {
	challenge?.ws.close();
	challenge = null;
	const box = element('div', { className: 'codeBox' });
	const input = element('input', {
		name: 'code',
		autocomplete: 'one-time-code',
		autocapitalize: 'characters',
		spellcheck: false,
		inputMode: 'text',
		maxLength: 16,
		value: typed,
		className: 'codeInput',
		data: { pairCode: '' },
	});
	input.setAttribute('aria-label', say('Pairing code'));
	input.setAttribute('autocorrect', 'off');
	const submit = button(say('Pair'), 'solid', { pairSubmit: '' });
	// The field stays in the DOM for the whole step: detaching it on every keystroke closed the iOS keyboard and put
	// the caret back at the start, so the next characters landed before the earlier ones. Only the cells are redrawn.
	let cells = codeCells('', 'edit');
	box.replaceChildren(cells, input);
	const draw = () => {
		const value = cleanCode(input.value);
		const next = codeCells(
			value,
			error && value.length === 8 && value === cleanCode(typed) ? 'error' : 'edit'
		);
		cells.replaceWith(next);
		cells = next;
		// A paste or autofill with spaces or dashes: keep the field equal to what the cells show, caret at the end.
		if (input.value !== value) {
			input.value = value;
			input.setSelectionRange(value.length, value.length);
		}
		submit.disabled = value.length !== 8;
	};
	input.addEventListener('input', () => {
		error = null;
		root.querySelector('[data-note="error"]')?.remove();
		draw();
	});
	submit.addEventListener('click', () => pair(cleanCode(input.value)));
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && cleanCode(input.value).length === 8) pair(cleanCode(input.value));
	});
	draw();
	const where = element('p', { className: 'cap where-code' });
	const [before, after] = say(
		'The code is shown on {machine}: Settings ▸ Remote ▸ Add device. It lasts 5 min.',
		{
			machine: '\u0000',
		}
	).split('\u0000');
	where.append(before ?? '', element('b', { className: 'mono' }, machineName()), after ?? '');
	show(
		'pair',
		'centre',
		logo(72),
		head(say('Brigadir on {machine}', { machine: machineName() })),
		box,
		error ? caption(error, 'error') : null,
		where,
		space(),
		submit
	);
	input.focus();
}
function pair(code: string) {
	const ws = new WebSocket(socketUrl('/ws/pair'));
	const initial = remembered.read('device') ?? phoneName();
	let party: CPaceParty | null = null;
	let created: string | null = null;
	let finished = false;
	const fail = (text: string) => {
		finished = true;
		ws.close();
		openPairing(text, code);
	};
	readMessages(ws, (message) => {
		switch (message.t) {
			case 'pair-hello':
				machine = message.machine;
				party = new CPaceParty(
					'initiator',
					{
						prs: utf8(normalizePairingCode(code)),
						ci: webChannelIdentifier(location.origin),
						sid: fromBase64(message.sid),
					},
					utf8(initial)
				);
				send(ws, { t: 'pair-a', share: toBase64(party.share), device: initial });
				return;
			case 'pair-b':
				if (!party) return fail(say('The code did not match.'));
				try {
					party.finish(fromBase64(message.share), utf8(machine));
				} catch {
					return fail(say('The code did not match.'));
				}
				// The machine proves the code first; only then does this page answer (as a computer does).
				if (!party.verify(fromBase64(message.tag))) return fail(say('The code did not match.'));
				send(ws, { t: 'pair-confirm', tag: toBase64(party.tag()) });
				return;
			case 'pair-register':
				return openName(ws, code, initial, message.options, (id) => (created = id));
			case 'pair-wait':
				show(
					'pair-wait',
					'state',
					element('span', { className: 'gap50' }),
					element('div', { className: 'badge' }, icon('machine', 36)),
					head(
						say('Confirm this phone on {machine}.', { machine }),
						say('Brigadir on {machine} asks whether to add this phone.', { machine })
					)
				);
				return;
			case 'paired':
				finished = true;
				machine = message.machine;
				remembered.write('machine', machine);
				remembered.write('passkey', created);
				// On iPhone in Safari, the Home Screen is a step of the way in — without it there are no notifications.
				if (ios && !standalone()) openInstall();
				else openLogin();
				return;
			case 'pair-refused': {
				// A passkey the machine did not keep: the phone's password manager may forget it (WebAuthn Signal API).
				const signal = (
					PublicKeyCredential as unknown as {
						signalUnknownCredential?: (options: {
							rpId: string;
							credentialId: string;
						}) => Promise<void>;
					}
				).signalUnknownCredential;
				if (created && signal)
					void signal({ rpId: location.hostname, credentialId: created }).catch(() => {});
				return fail(pairRefusal(message.reason, message.attemptsLeft));
			}
		}
	});
	ws.addEventListener('close', () => {
		if (!finished && root.dataset.state?.startsWith('pair'))
			openPairing(say('{machine} does not answer.', { machine: machineName() }), code);
	});
}
const standalone = () =>
	matchMedia('(display-mode: standalone)').matches ||
	(navigator as Navigator & { standalone?: boolean }).standalone === true;
/** The code matched — the phone's name, then the passkey (the OS draws its own sheet). */
function openName(
	ws: WebSocket,
	code: string,
	initial: string,
	options: Extract<WebMessage, { t: 'pair-register' }>['options'],
	keep: (id: string) => void
) {
	const name = element('input', {
		name: 'name',
		value: initial,
		maxLength: 64,
		className: 'fld',
		id: 'phone-name',
		data: { pairName: '' },
	});
	const create = button(say('Create a passkey'), 'solid', { pairCreate: '' }, 'key');
	name.addEventListener('input', () => (create.disabled = !name.value.trim()));
	create.addEventListener('click', async () => {
		const device = name.value.trim() || initial;
		create.disabled = true;
		let credential: PublicKeyCredential | null = null;
		try {
			credential = (await navigator.credentials.create({
				publicKey: {
					challenge: buffer(fromBase64Url(options.challenge)),
					rp: { id: options.rpId, name: options.rpName },
					user: { id: buffer(fromBase64Url(options.userId)), name: device, displayName: device },
					pubKeyCredParams: options.algorithms.map((alg) => ({ type: 'public-key', alg })),
					authenticatorSelection: {
						residentKey: 'required',
						requireResidentKey: true,
						userVerification: 'required',
					},
					attestation: 'none',
					timeout: options.timeoutMs,
				},
			})) as PublicKeyCredential | null;
		} catch {
			credential = null;
		}
		if (!credential) {
			create.disabled = false;
			return;
		}
		const response = credential.response as AuthenticatorAttestationResponse;
		const id = toBase64Url(new Uint8Array(credential.rawId));
		keep(id);
		remembered.write('device', device);
		send(ws, {
			t: 'pair-credential',
			id,
			clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
			attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
			...(device !== initial ? { device } : {}),
		});
	});
	const matched = element(
		'div',
		{ className: 'matched' },
		icon('tick', 16),
		say('The code matches')
	);
	const label = element(
		'label',
		{ className: 'cap left', htmlFor: 'phone-name' },
		say('Name of this phone')
	);
	show(
		'pair-register',
		'name',
		head(
			say('Almost done'),
			say('The phone is paired with {machine}. One passkey instead of a password is left.', {
				machine,
			})
		),
		codeCells(code, 'ok'),
		matched,
		element('div', { className: 'nameField' }, label, name),
		space(),
		create
	);
}
/** Share ▸ Add to Home Screen; then the app from the Home Screen signs in with the passkey. */
function openInstall() {
	const rows: [SigninIcon | 'logo', string, string][] = [
		['share', say('1. Share'), say('The button at the bottom of Safari')],
		['addsq', say('2. Add to Home Screen'), say('Name it «Brigadir»')],
		['logo', say('3. Open Brigadir from the Home Screen'), say('Sign in with the passkey')],
	];
	const go = button(say('Continue in Safari'), 'ghost', { continue: '' });
	go.addEventListener('click', () => openLogin());
	show(
		'install',
		'centre',
		element('span', { className: 'gap20' }),
		logo(72),
		head(
			say('Add Brigadir to the Home Screen'),
			say('Only then can iPhone show notifications when an agent is waiting for you.')
		),
		element(
			'div',
			{ className: 'grp steps' },
			...rows.map(([glyph, title, sub]) =>
				element(
					'div',
					{ className: 'srow' },
					glyph === 'logo'
						? element('span', { className: 'ic2 mini' }, icon('helmet', 19))
						: element('span', { className: 'ic2 accent' }, icon(glyph, 18)),
					element(
						'span',
						{ className: 'two' },
						element('span', {}, title),
						element('small', {}, sub)
					)
				)
			)
		),
		space(),
		go
	);
}

addEventListener('popstate', () => {
	if (root.dataset.state?.startsWith('pair')) openLogin();
});
if ('serviceWorker' in navigator)
	void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
openLogin();
