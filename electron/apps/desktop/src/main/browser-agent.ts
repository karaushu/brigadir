import type { WebContents } from 'electron';
import {
	browserElements,
	browserKey,
	browserRef,
	browserActLabel,
	findBrowserElement,
	formatBrowserUi,
	hasBrowserTarget,
	sensitiveField,
	type AxNode,
	type BrowserActRequest,
	type BrowserElement,
	type BrowserViewport,
	browserPickerRefusal,
} from '@brigadir/core';
import { pageApi } from './browser-page';
/**
 * spec/browser-and-simulator#browser-ui-act: the agent's `browser_ui` and `browser_act` on the task's own page. Input goes through CDP `Input.*`, so the
 * page sees the same pointer, focus and key events as from the person; the tree is CDP `Accessibility`.
 */
type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;
const send =
	(web: WebContents): Send =>
	(method, params) =>
		web.debugger.sendCommand(method, params);
async function viewport(cdp: Send): Promise<BrowserViewport> {
	const result = await cdp('Runtime.evaluate', {
		expression:
			'({width:innerWidth,height:innerHeight,scrollX,scrollY,pageWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight})',
		returnByValue: true,
		timeout: 3000,
	});
	return result.result.value as BrowserViewport;
}
async function box(
	cdp: Send,
	backendNodeId: number
): Promise<[number, number, number, number] | null> {
	try {
		const { quads } = (await cdp('DOM.getContentQuads', { backendNodeId })) as {
			quads: number[][];
		};
		const quad = quads.find((item) => item.length === 8);
		if (!quad) return null;
		const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!],
			ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!],
			x = Math.min(...xs),
			y = Math.min(...ys);
		return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
	} catch {
		return null;
	}
}
async function tree(cdp: Send) {
	const { nodes } = (await cdp('Accessibility.getFullAXTree')) as { nodes: AxNode[] };
	return browserElements(nodes);
}
export async function browserUi(web: WebContents, offset = 0) {
	const cdp = send(web),
		elements = await tree(cdp),
		page = elements.slice(offset, offset + 150);
	const boxes = await Promise.all(page.map((element) => box(cdp, element.ref)));
	return formatBrowserUi(
		await viewport(cdp),
		page.map((element, index): BrowserElement => ({ ...element, box: boxes[index]! })),
		elements.length,
		offset
	);
}
/** What an action works on: the element (when there is one), a short name for the answer and the point it happens at. */
type Target = {
	objectId: string | null;
	name: string | null;
	short: string | null;
	x: number;
	y: number;
};
const describe = `function(){const e=this;const text=(e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')))||(e.innerText||e.value||e.alt||e.placeholder||'').trim().replace(/\\s+/g,' ');return e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(text?' "'+text.slice(0,60)+'"':'');}`;
/** What the ring says: the visible name only, as the person reads it on the page. */
const shortName = `function(){const e=this;const text=(e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')))||(e.labels&&e.labels[0]?e.labels[0].innerText.replace((e.value||'')+'',''):'')||(e.innerText||e.placeholder||e.alt||'').trim().replace(/\\s+/g,' ');return text?text.slice(0,40):e.tagName.toLowerCase();}`;
async function call(cdp: Send, objectId: string, fn: string, args: unknown[] = []) {
	const result = await cdp('Runtime.callFunctionOn', {
		objectId,
		functionDeclaration: fn,
		arguments: args.map((value) => ({ value })),
		returnByValue: true,
	});
	if (result.exceptionDetails)
		throw new Error(
			String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
		);
	return result.result.value;
}
async function resolve(cdp: Send, request: BrowserActRequest): Promise<Target | null> {
	if (!hasBrowserTarget(request)) return null;
	let backendNodeId: number | null = null,
		name: string | null = null;
	if (request.ref) backendNodeId = browserRef(request.ref);
	else if (request.label) {
		const found = findBrowserElement(await tree(cdp), request.label);
		if (!found)
			throw new Error(
				`No element is named "${request.label}". Call browser_ui to see the names on the page.`
			);
		backendNodeId = found.ref;
		name = found.name;
	} else if (request.selector) {
		const result = await cdp('Runtime.evaluate', {
			expression: `document.querySelector(${JSON.stringify(request.selector)})`,
			timeout: 3000,
		});
		if (result.exceptionDetails) throw new Error(`Invalid selector: ${request.selector}`);
		if (!result.result.objectId) throw new Error(`Nothing matches ${request.selector}.`);
		backendNodeId = (await cdp('DOM.describeNode', { objectId: result.result.objectId })).node
			.backendNodeId;
		await cdp('Runtime.releaseObject', { objectId: result.result.objectId });
	}
	if (backendNodeId === null) {
		// A point: the element under it, for the checks below and the answer.
		const hit = await cdp('DOM.getNodeForLocation', {
			x: Math.round(request.x!),
			y: Math.round(request.y!),
			ignorePointerEventsNone: false,
		}).catch(() => null);
		const objectId = hit
			? ((await cdp('DOM.resolveNode', { backendNodeId: hit.backendNodeId })).object
					.objectId as string)
			: null;
		return {
			objectId,
			name: objectId ? await call(cdp, objectId, describe) : null,
			short: objectId ? await call(cdp, objectId, shortName) : null,
			x: request.x!,
			y: request.y!,
		};
	}
	let objectId: string;
	try {
		objectId = (await cdp('DOM.resolveNode', { backendNodeId })).object.objectId;
	} catch {
		throw new Error(
			`${request.ref ?? 'The element'} is no longer on the page. Call browser_ui again.`
		);
	}
	// A text node or a label resolves to its element; the ring and the click go to the middle of it.
	objectId = (
		await cdp('Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: 'function(){return this.nodeType===1?this:this.parentElement;}',
		})
	).result.objectId;
	await cdp('DOM.scrollIntoViewIfNeeded', { objectId }).catch(() => {});
	const rect = (await call(
		cdp,
		objectId,
		'function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}'
	)) as { x: number; y: number; w: number; h: number };
	if (rect.w <= 0 || rect.h <= 0)
		throw new Error(`${name ? `"${name}"` : (request.ref ?? request.selector)} is not visible.`);
	const x = rect.x + rect.w / 2,
		y = rect.y + rect.h / 2;
	// spec/browser-and-simulator#browser-ui-act: another element in the middle of the target (a modal, a banner) takes the click, as it would from the person.
	const cover = await call(
		cdp,
		objectId,
		`function(x,y){const root=this.getRootNode();const hit=(root.elementFromPoint?root:document).elementFromPoint(x,y);if(!hit||hit===this||this.contains(hit))return null;if(this.labels&&[...this.labels].some(l=>l===hit||l.contains(hit)))return null;const e=hit;return (${describe}).call(e);}`,
		[x, y]
	);
	if (cover)
		throw new Error(
			`${cover} covers ${name ? `"${name}"` : 'the target'} at ${Math.round(x)},${Math.round(y)}; nothing was done. Close it first or pick another target.`
		);
	return {
		objectId,
		name: name ?? (await call(cdp, objectId, describe)),
		short: name ?? (await call(cdp, objectId, shortName)),
		x,
		y,
	};
}
const fieldInfo = `function(){const e=this.nodeType===1?this:this.parentElement;return e?{tag:e.tagName,type:e.getAttribute('type'),autocomplete:e.getAttribute('autocomplete')}:null;}`;
async function refuseSensitive(cdp: Send, objectId: string | null) {
	let id = objectId;
	if (!id) {
		const active = await cdp('Runtime.evaluate', {
			expression:
				'(()=>{let e=document.activeElement;while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;return e;})()',
		});
		id = active.result.objectId ?? null;
	}
	const field = id
		? ((await call(cdp, id, fieldInfo)) as {
				tag: string;
				type: string | null;
				autocomplete: string | null;
			} | null)
		: null;
	if (field && sensitiveField(field))
		throw new Error(
			'This is a password, one-time code or payment card field. The agent does not fill it: ask the human to.'
		);
}
async function mouse(
	cdp: Send,
	type: string,
	x: number,
	y: number,
	extra: Record<string, unknown> = {}
) {
	await cdp('Input.dispatchMouseEvent', { type, x, y, ...extra });
}
/** spec/browser-and-simulator#background: what a click on this element would open from a hidden page. */
const pickerKind = `function(){const e=this.nodeType===1?this:this.parentElement;if(!e)return null;if(e.closest&&e.closest('select'))return 'select';if(e.tagName==='INPUT'&&(e.type||'').toLowerCase()==='color')return 'color';return null;}`;
/** spec/browser-and-simulator#background: copy, cut or paste in the page with the task clipboard (the page script is installed while the agent acts). */
async function clipboard(cdp: Send, kind: 'copy' | 'cut' | 'paste') {
	const result = await cdp('Runtime.evaluate', {
		expression: `(()=>{const api=${pageApi};return api?api.clip(${JSON.stringify(kind)}):null;})()`,
		returnByValue: true,
	});
	if (result.result?.value !== true)
		throw new Error(
			'The task clipboard is not available on this page; nothing was copied or pasted.'
		);
}
async function press(cdp: Send, spec: string) {
	const key = browserKey(spec);
	if (!key)
		throw new Error(
			`Unknown key "${spec}". Use a KeyboardEvent key (Enter, Escape, Tab, ArrowDown, a), with modifiers like Meta+A or Shift+Tab.`
		);
	const common = {
		key: key.key,
		code: key.code,
		windowsVirtualKeyCode: key.keyCode,
		nativeVirtualKeyCode: key.keyCode,
		modifiers: key.modifiers,
	};
	await cdp('Input.dispatchKeyEvent', {
		type: key.text ? 'keyDown' : 'rawKeyDown',
		...common,
		...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
		...(key.commands ? { commands: key.commands } : {}),
	});
	await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}
/** spec/browser-and-simulator#browser-ui-act: the ring of the simulator's touch (spec/browser-and-simulator#simulator), drawn in the page because the view sits above the window's renderer. */
export type RingColors = { accent: string; soft: string; fill: string; fg: string };
function ring(cdp: Send, x: number, y: number, label: string, colors: RingColors) {
	const script = `(()=>{const host=document.createElement('brigadir-agent-act');host.style.cssText='all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';const root=host.attachShadow({mode:'closed'});
root.innerHTML=${JSON.stringify(`<style>.tap{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:${colors.soft};box-shadow:0 0 0 2px ${colors.accent},0 0 0 8px ${colors.soft};animation:tap 600ms ease-out forwards}.label{position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);box-sizing:border-box;height:24px;min-width:24px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;background:${colors.fill};color:${colors.fg};font:500 12px ui-monospace,'SF Mono',Menlo,monospace;white-space:nowrap}@keyframes tap{0%{opacity:1;transform:scale(.85)}70%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.05)}}@media (prefers-reduced-motion:reduce){.tap{animation:none}}</style>`)}+'<span class="tap" style="left:${Math.round(x)}px;top:${Math.round(y)}px"><span class="label"></span></span>';
root.querySelector('.label').textContent=${JSON.stringify(label)};document.documentElement.appendChild(host);setTimeout(()=>host.remove(),600);})()`;
	return cdp('Runtime.evaluate', { expression: script }).catch(() => {});
}
/** Waits for the page to settle after an action: a navigation until it loads (10 s at most), otherwise a short pause. */
function settle(web: WebContents) {
	let navigated = false;
	const started = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => {
		if (main) navigated = true;
	};
	web.on('did-start-navigation', started);
	return async () => {
		await new Promise((resolve) => setTimeout(resolve, 300));
		if ((navigated || web.isLoading()) && !web.isDestroyed() && web.isLoading())
			await new Promise<void>((resolve) => {
				const timer = setTimeout(done, 10_000);
				function done() {
					clearTimeout(timer);
					web.off('did-stop-loading', done);
					resolve();
				}
				web.on('did-stop-loading', done);
			});
		web.off('did-start-navigation', started);
	};
}
const verbs: Record<BrowserActRequest['action'], string> = {
	click: 'Clicked',
	hover: 'Hovered',
	type: 'Typed into',
	key: 'Pressed',
	scroll: 'Scrolled',
	select: 'Selected',
	back: 'Went back',
	forward: 'Went forward',
	reload: 'Reloaded the page',
	dialog: 'Set the answer to the next dialog',
	clipboard: 'Read the task clipboard',
	paste: 'Pasted',
	notifications: 'Decided the notifications of the domain',
};
/** `errors(since)` — console errors logged after the log counter `since`; the log itself empties on navigation. */
export type ActHooks = {
	/** spec/browser-and-simulator#background: the page is in the invisible window — no native pickers. */
	hidden?: () => boolean;
	colors: () => Promise<RingColors>;
	navigate: (kind: 'back' | 'forward' | 'reload') => boolean;
	counter: () => number;
	errors: (since: number) => string[];
};
export async function browserAct(
	web: WebContents,
	request: BrowserActRequest,
	hooks: ActHooks
): Promise<string> {
	const cdp = send(web),
		before = { url: web.getURL(), title: web.getTitle() },
		since = hooks.counter();
	// The page treats itself as focused, so a field takes the caret without moving the person's focus (spec/browser-and-simulator#opening-tabs).
	await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
	const settled = settle(web);
	let done: string;
	try {
		if (request.action === 'back' || request.action === 'forward' || request.action === 'reload') {
			if (!hooks.navigate(request.action))
				throw new Error(`There is no page to go ${request.action} to.`);
			done = verbs[request.action];
		} else {
			const target = await resolve(cdp, request),
				what = target?.name ? ` ${target.name}` : '';
			const point =
				target ??
				(request.action === 'scroll'
					? await viewport(cdp).then((view) => ({
							x: view.width / 2,
							y: view.height / 2,
							objectId: null,
							name: null,
							short: null,
						}))
					: null);
			if (
				!point &&
				(request.action === 'click' || request.action === 'hover' || request.action === 'select')
			)
				throw new Error(`Give a target: ref from browser_ui, selector, label, or x and y.`);
			if (request.action === 'type' || request.action === 'select' || request.action === 'paste')
				await refuseSensitive(cdp, target?.objectId ?? null);
			// spec/browser-and-simulator#background: a <select> or a color input opens a native window over the screen from a hidden page.
			if (request.action === 'click' && hooks.hidden?.() && target?.objectId) {
				const picker = (await call(cdp, target.objectId, pickerKind)) as 'select' | 'color' | null;
				if (picker) throw new Error(browserPickerRefusal(picker));
			}
			if (point && request.action !== 'key')
				void ring(
					cdp,
					point.x,
					point.y,
					browserActLabel(request, target?.short ?? null),
					await hooks.colors()
				);
			switch (request.action) {
				case 'click': {
					const count = request.count ?? 1;
					await mouse(cdp, 'mouseMoved', point!.x, point!.y);
					for (let index = 1; index <= count; index++) {
						await mouse(cdp, 'mousePressed', point!.x, point!.y, {
							button: 'left',
							buttons: 1,
							clickCount: index,
						});
						await mouse(cdp, 'mouseReleased', point!.x, point!.y, {
							button: 'left',
							buttons: 0,
							clickCount: index,
						});
					}
					done = `${count === 2 ? 'Double-clicked' : 'Clicked'}${what}`;
					break;
				}
				case 'hover':
					await mouse(cdp, 'mouseMoved', point!.x, point!.y);
					done = `Hovered${what}`;
					break;
				case 'scroll':
					await mouse(cdp, 'mouseWheel', point!.x, point!.y, {
						deltaX: request.dx ?? 0,
						deltaY: request.dy ?? 0,
					});
					done = `Scrolled by ${request.dx ?? 0},${request.dy ?? 0}${what ? ` at${what}` : ''}`;
					break;
				case 'type': {
					if (request.text === undefined && !request.clear && !request.submit)
						throw new Error('Give the text to type.');
					// A color input has no text to type into: the color is its value, as the picker would set it.
					if (target?.objectId && request.text !== undefined) {
						const color = (await call(
							cdp,
							target.objectId,
							`function(value){if(this.tagName!=='INPUT'||(this.type||'').toLowerCase()!=='color')return null;if(!/^#[0-9a-f]{6}$/i.test(value))return {error:'A color input takes a color like #3366ff.'};this.focus();this.value=value.toLowerCase();this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return {value:this.value};}`,
							[request.text]
						)) as { error?: string; value?: string } | null;
						if (color?.error) throw new Error(color.error);
						if (color) {
							done = `Set the color ${color.value}${what ? ` of${what}` : ''}`;
							break;
						}
					}
					if (target) {
						await mouse(cdp, 'mousePressed', target.x, target.y, {
							button: 'left',
							buttons: 1,
							clickCount: 1,
						});
						await mouse(cdp, 'mouseReleased', target.x, target.y, {
							button: 'left',
							buttons: 0,
							clickCount: 1,
						});
					}
					if (request.clear)
						await cdp('Runtime.evaluate', {
							expression: `(()=>{let e=document.activeElement;while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;if(e&&typeof e.select==='function')e.select();else document.execCommand('selectAll');})()`,
						}).then(() => press(cdp, 'Backspace'));
					if (request.text) await cdp('Input.insertText', { text: request.text });
					if (request.submit) await press(cdp, 'Enter');
					done = `${request.text ? `Typed ${request.text.length} characters` : 'Cleared the field'}${what ? ` into${what}` : ''}${request.submit ? ' and pressed Enter' : ''}`;
					break;
				}
				case 'key': {
					if (!request.key) throw new Error('Give the key to press.');
					if (target) await call(cdp, target.objectId!, 'function(){this.focus();}');
					// Enter or Tab in a password field the person filled is fine; a character or a paste is filling it.
					const key = browserKey(request.key);
					if (key && ((key.text && key.key !== 'Enter') || key.commands?.includes('paste')))
						await refuseSensitive(cdp, null);
					// spec/browser-and-simulator#background: Space, Enter or Alt+arrows on a focused <select> open its native list.
					if (
						hooks.hidden?.() &&
						key &&
						(key.key === ' ' ||
							key.key === 'Enter' ||
							((key.modifiers & 1) !== 0 && /^Arrow(Up|Down)$/.test(key.key)))
					) {
						const focused = await cdp('Runtime.evaluate', {
							expression: `(()=>{let e=document.activeElement;while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;return e?(${pickerKind}).call(e):null;})()`,
							returnByValue: true,
						});
						const picker = focused.result?.value as 'select' | 'color' | null;
						if (picker) throw new Error(browserPickerRefusal(picker));
					}
					// spec/browser-and-simulator#background: copy, cut and paste go through the task clipboard, never the system one.
					const clip = key?.commands?.find((command) => ['copy', 'cut', 'paste'].includes(command));
					if (clip) await clipboard(cdp, clip as 'copy' | 'cut' | 'paste');
					else await press(cdp, request.key);
					done = `Pressed ${request.key}${what ? ` in${what}` : ''}`;
					break;
				}
				case 'paste': {
					if (target?.objectId) await call(cdp, target.objectId, 'function(){this.focus();}');
					await clipboard(cdp, 'paste');
					const into = await cdp('Runtime.evaluate', {
						expression: `(()=>{let e=document.activeElement;while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;return e&&e!==document.body?(${describe}).call(e):null;})()`,
						returnByValue: true,
					});
					const field = typeof into.result?.value === 'string' ? ` into ${into.result.value}` : '';
					done = `Pasted ${[...(request.text ?? '')].length} characters from the task clipboard${field}`;
					break;
				}
				case 'select': {
					if (request.value === undefined) throw new Error('Give the value or text of the option.');
					const chosen = (await call(
						cdp,
						target!.objectId!,
						`function(wanted){if(this.tagName!=='SELECT')return {error:'The target is not a <select>: click it and the option instead.'};const options=[...this.options];const o=options.find(o=>o.value===wanted)||options.find(o=>o.text.trim()===wanted)||options.find(o=>o.text.toLowerCase().includes(wanted.toLowerCase()));if(!o)return {error:'No option matches "'+wanted+'". Options: '+options.map(o=>o.text.trim()).slice(0,30).join(', ')};this.focus();this.value=o.value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return {text:o.text.trim()};}`,
						[request.value]
					)) as { error?: string; text?: string };
					if (chosen.error) throw new Error(chosen.error);
					done = `Selected "${chosen.text}"${what ? ` in${what}` : ''}`;
					break;
				}
				default:
					throw new Error('Invalid browser action');
			}
			if (target?.objectId)
				await cdp('Runtime.releaseObject', { objectId: target.objectId }).catch(() => {});
		}
	} finally {
		await settled();
	}
	const after = { url: web.getURL(), title: web.getTitle() },
		fresh = hooks.errors(since);
	const moved =
		after.url !== before.url
			? ` Now at ${after.url}${after.title ? ` — "${after.title}"` : ''}.`
			: after.title !== before.title
				? ` The title is now "${after.title}".`
				: '';
	const failed = fresh.length
		? ` ${fresh.length} new console error${fresh.length === 1 ? '' : 's'}: ${fresh
				.slice(-3)
				.map((text) => text.split('\n')[0]!.slice(0, 200))
				.join(' | ')}`
		: '';
	return `${done}.${moved}${failed}`;
}
