/**
 * spec/browser-and-simulator#background: what the page gets in place of native windows and the system clipboard while the agent works with it.
 * One script, installed on every document of the tab and of its cross-site frames (`Page.addScriptToEvaluateOnNewDocument`,
 * CDP auto-attach) before the page's own scripts; running it again only changes its state. Off, it passes every call to
 * the page's own functions.
 *
 * - `dialogs`: alert closes, confirm gets Cancel, prompt gets null — unless the agent set the answer (`next`);
 * - `clipboard`: navigator.clipboard, execCommand('copy' | 'cut' | 'paste') and their events use the task clipboard;
 * - `pickers`: showPicker() refuses (the page is not on screen); so do print, the file system pickers and the eye dropper.
 * - `ask` (spec/remote-access-and-mobile#browser-from-device): a device streams the page — alert, confirm and prompt block the page like native ones with a
 *   synchronous request to this address of the page's own origin, which main intercepts (CDP `Fetch`) and answers with
 *   the device's choice. A request that fails (a CSP, an opaque origin) is a cancel. `dialogs` (the agent) comes first.
 * - `remotePickers` (spec/remote-access-and-mobile#networking): a device streams the page and the agent does not act on it — a `<select>`, a colour
 *   or a date/time input that would open its popup on this machine's screen reports it instead (`open-picker`); the
 *   device shows its own and main sets the chosen value with `pick`, which fires `input` and `change` like a real choice.
 * - `notifications` (spec/browser-and-simulator#notifications): the person's decisions by domain. `Notification`, its permission query and a service worker's
 *   `showNotification` answer from them; a request on `default` asks main (`notification-ask`), a shown one reports
 *   `notification`, and main sends back `click` and the end of the question (`asked`).
 * What happened reaches main through the CDP binding as one JSON line.
 */
export type PageAgentState = {
	dialogs: boolean;
	clipboard: boolean;
	pickers: boolean;
	next: { accept: boolean; text?: string } | null;
	buffer: string;
	ask?: string | null;
	remotePickers?: boolean;
	notifications?: Record<string, 'granted' | 'denied'>;
};
/** spec/remote-access-and-mobile#browser-from-device: the path a page's dialog asks through; main intercepts it before the network. */
export const pageDialogPath = '/.well-known/brigadir-dialog/';
export const pageBinding = '__brigadirAgent';
export const pageApi = `window[Symbol.for('brigadir.agent')]`;
const install = `(state, binding, token) => {
  const key = Symbol.for('brigadir.agent');
  const existing = window[key];
  if (existing) { existing.set(token, state); return; }
  let current = state;
  const report = (value) => { try { const call = window[binding]; if (typeof call === 'function') call(JSON.stringify(value)); } catch {} };
  const text = (value) => String(value ?? '').slice(0, 100000);
  const original = {
    alert: window.alert, confirm: window.confirm, prompt: window.prompt,
    exec: Document.prototype.execCommand,
    writeText: Clipboard.prototype.writeText, readText: Clipboard.prototype.readText,
    write: Clipboard.prototype.write, read: Clipboard.prototype.read,
    inputPicker: HTMLInputElement.prototype.showPicker, selectPicker: HTMLSelectElement.prototype.showPicker,
  };
  const answer = () => { const next = current.next; if (next) { current.next = null; report({ kind: 'next-used' }); } return next; };
  const ask = (type, message, value) => {
    try {
      const request = new XMLHttpRequest();
      request.open('POST', current.ask, false);
      request.send(JSON.stringify({ type, message: text(message).slice(0, 4000), value: value == null ? '' : String(value).slice(0, 4000) }));
      return request.status === 200 ? JSON.parse(request.responseText).answer : null;
    } catch { return null; }
  };
  window.alert = function (message) {
    if (!current.dialogs && current.ask) { ask('alert', message, ''); return; }
    if (!current.dialogs) return original.alert.apply(this, arguments);
    answer();
    report({ kind: 'dialog', type: 'alert', message: text(message), answer: null });
  };
  window.confirm = function (message) {
    if (!current.dialogs && current.ask) return ask('confirm', message, '') === true;
    if (!current.dialogs) return original.confirm.apply(this, arguments);
    const next = answer(), result = !!(next && next.accept);
    report({ kind: 'dialog', type: 'confirm', message: text(message), answer: result || null });
    return result;
  };
  window.prompt = function (message, fallback) {
    if (!current.dialogs && current.ask) { const value = ask('prompt', message, fallback); return typeof value === 'string' ? value : null; }
    if (!current.dialogs) return original.prompt.apply(this, arguments);
    const next = answer(), result = next && next.accept ? String(next.text ?? fallback ?? '') : null;
    report({ kind: 'dialog', type: 'prompt', message: text(message), answer: result });
    return result;
  };
  const deep = () => { let e = document.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement; return e; };
  const selected = (target) => {
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && typeof target.selectionStart === 'number')
      return target.value.slice(target.selectionStart, target.selectionEnd);
    return String(getSelection() || '');
  };
  const clip = (kind) => {
    const target = deep() || document.body || document.documentElement;
    const data = new DataTransfer();
    if (kind === 'paste') data.setData('text/plain', current.buffer);
    const event = new ClipboardEvent(kind, { clipboardData: data, bubbles: true, cancelable: true, composed: true });
    const plain = target.dispatchEvent(event);
    if (kind === 'paste') {
      if (plain) original.exec.call(document, 'insertText', false, current.buffer);
      return true;
    }
    const copied = plain ? selected(target) : data.getData('text/plain');
    if (plain && kind === 'cut') original.exec.call(document, 'delete', false);
    current.buffer = text(copied);
    report({ kind: 'copy', text: current.buffer, cut: kind === 'cut' });
    return true;
  };
  Document.prototype.execCommand = function (command) {
    const name = String(command).toLowerCase();
    if (current.clipboard && (name === 'copy' || name === 'cut' || name === 'paste')) return clip(name);
    return original.exec.apply(this, arguments);
  };
  Clipboard.prototype.writeText = function (value) {
    if (!current.clipboard) return original.writeText.apply(this, arguments);
    current.buffer = text(value);
    report({ kind: 'copy', text: current.buffer, cut: false });
    return Promise.resolve();
  };
  Clipboard.prototype.readText = function () {
    if (!current.clipboard) return original.readText.apply(this, arguments);
    return Promise.resolve(current.buffer);
  };
  Clipboard.prototype.write = function (items) {
    if (!current.clipboard) return original.write.apply(this, arguments);
    const item = [...(items || [])].find((entry) => entry.types.includes('text/plain'));
    if (!item) return Promise.resolve();
    return item.getType('text/plain').then((blob) => blob.text()).then((value) => {
      current.buffer = text(value);
      report({ kind: 'copy', text: current.buffer, cut: false });
    });
  };
  Clipboard.prototype.read = function () {
    if (!current.clipboard) return original.read.apply(this, arguments);
    return Promise.resolve([new ClipboardItem({ 'text/plain': new Blob([current.buffer], { type: 'text/plain' }) })]);
  };
  const pickerInputs = ['color', 'date', 'time', 'datetime-local', 'month', 'week'];
  let pickerId = 0, picking = null;
  const pickerOf = (target) => {
    if (!current.remotePickers || !target || target.disabled) return null;
    if (target.tagName === 'SELECT') return !target.multiple && !(target.size > 1) ? 'select' : null;
    if (target.tagName === 'INPUT' && !target.readOnly && pickerInputs.includes(target.type)) return target.type;
    return null;
  };
  const clip64 = (value) => String(value ?? '').slice(0, 64);
  const openPicker = (target, type) => {
    const box = target.getBoundingClientRect();
    pickerId += 1;
    picking = { id: pickerId, element: target };
    const options = type !== 'select' ? [] : [...target.options].slice(0, 1000).map((option) => {
      const group = option.parentElement && option.parentElement.tagName === 'OPTGROUP' ? option.parentElement : null;
      return { label: String(option.label || option.text || '').slice(0, 500), value: String(option.value).slice(0, 4096),
        group: group ? String(group.label).slice(0, 500) : null, disabled: !!(option.disabled || (group && group.disabled)) };
    });
    report({ kind: 'open-picker', picker: { id: pickerId, type, value: String(target.value ?? '').slice(0, 4096), options,
      min: type === 'select' ? '' : clip64(target.min), max: type === 'select' ? '' : clip64(target.max),
      step: type === 'select' ? '' : clip64(target.step),
      x: box.left, y: box.top, width: Math.max(0, box.width), height: Math.max(0, box.height) } });
  };
  const deepTarget = (event) => (event.composedPath ? event.composedPath()[0] : event.target);
  window.addEventListener('mousedown', (event) => {
    const target = deepTarget(event), type = pickerOf(target);
    if (!type || type === 'color' || event.button !== 0) return;
    // A date or time field keeps its own segments; only its picker's icon (the right end) opens the popup.
    if (type !== 'select' && event.clientX < target.getBoundingClientRect().right - 28) return;
    event.preventDefault();
    target.focus();
    openPicker(target, type);
  }, true);
  window.addEventListener('click', (event) => {
    const target = deepTarget(event);
    if (pickerOf(target) !== 'color') return;
    event.preventDefault();
    openPicker(target, 'color');
  }, true);
  window.addEventListener('keydown', (event) => {
    const target = deepTarget(event), type = pickerOf(target);
    if (!type || type === 'color') return;
    const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    const opens = (event.altKey && arrow) || event.key === 'F4' ||
      (type === 'select' && (event.key === ' ' || (arrow && /Mac/.test(navigator.platform))));
    if (!opens) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openPicker(target, type);
  }, true);
  const setValue = (element, value) => {
    const proto = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    // The prototype's setter: a framework's own tracker on the element then sees a change, as with a real choice.
    setter.call(element, value);
  };
  const pick = (id, value) => {
    const entry = picking;
    if (!entry || entry.id !== id) return false;
    picking = null;
    const element = entry.element;
    if (value == null || !element.isConnected || element.value === value) return false;
    setValue(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const refuse = (fallback) => function () {
    const type = pickerOf(this);
    if (type) { openPicker(this, type); return; }
    if (!current.pickers) return fallback.apply(this, arguments);
    report({ kind: 'picker' });
    throw new DOMException('The picker is not available while the page is not on screen.', 'NotAllowedError');
  };
  if (original.inputPicker) HTMLInputElement.prototype.showPicker = refuse(original.inputPicker);
  if (original.selectPicker) HTMLSelectElement.prototype.showPicker = refuse(original.selectPicker);
  // Print, the file system pickers and the eye dropper are windows of this machine too (security review R2–R4, V2).
  const offScreen = (fallback, refusal) => function () {
    if (!current.pickers) return fallback.apply(this, arguments);
    report({ kind: 'picker' });
    return refusal();
  };
  const refused = () => Promise.reject(new DOMException('The picker is not available while the page is not on screen.', 'NotAllowedError'));
  window.print = offScreen(window.print, () => undefined);
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'])
    if (typeof window[name] === 'function') window[name] = offScreen(window[name], refused);
  if (typeof window.EyeDropper === 'function') EyeDropper.prototype.open = offScreen(EyeDropper.prototype.open, refused);
  // spec/browser-and-simulator#notifications: notifications by the person's decision for this domain; another site's frame never gets them, as in Chrome.
  const crossFrame = (() => { try { return window.top !== window && window.top.location.host !== location.host; } catch { return true; } })();
  const permission = () => crossFrame ? 'denied' : ((current.notifications || {})[location.hostname] || 'default');
  let asking = [], noteId = 0;
  const shown = new Map(), ids = new WeakMap();
  const settle = (all) => {
    const state = permission();
    if (!all && state === 'default') return;
    const waiting = asking; asking = [];
    for (const done of waiting) done(state);
  };
  const fire = (target, type) => {
    const event = new Event(type);
    const handler = target['on' + type];
    if (typeof handler === 'function') { try { handler.call(target, event); } catch (error) { queueMicrotask(() => { throw error; }); } }
    target.dispatchEvent(event);
  };
  const showNote = (target, title, options) => {
    const id = ++noteId;
    ids.set(target, id);
    shown.set(id, target);
    if (shown.size > 100) shown.delete(shown.keys().next().value);
    report({ kind: 'notification', id, title: text(title).slice(0, 200), body: text(options && options.body).slice(0, 1000),
      tag: text(options && options.tag).slice(0, 200) });
  };
  const NativeNotification = window.Notification;
  class PageNotification extends EventTarget {
    constructor(title, options) {
      super();
      if (arguments.length < 1) throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.");
      const value = options || {};
      Object.assign(this, { title: String(title), body: String(value.body ?? ''), tag: String(value.tag ?? ''),
        icon: String(value.icon ?? ''), data: value.data ?? null, dir: value.dir || 'auto', lang: String(value.lang ?? ''),
        silent: value.silent ?? null, requireInteraction: !!value.requireInteraction,
        onclick: null, onshow: null, onclose: null, onerror: null });
      if (permission() !== 'granted') { queueMicrotask(() => fire(this, 'error')); return; }
      showNote(this, title, value);
      queueMicrotask(() => fire(this, 'show'));
    }
    close() {
      const id = ids.get(this);
      if (!id || !shown.delete(id)) return;
      report({ kind: 'notification-close', id });
      fire(this, 'close');
    }
    static get permission() { return permission(); }
    static get maxActions() { return 0; }
    static requestPermission(callback) {
      const result = permission() !== 'default' ? Promise.resolve(permission())
        : new Promise((resolve) => { asking.push(resolve); if (asking.length === 1) report({ kind: 'notification-ask' }); });
      if (typeof callback === 'function') result.then(callback);
      return result;
    }
  }
  Object.defineProperty(PageNotification, 'name', { value: 'Notification' });
  if (NativeNotification) window.Notification = PageNotification;
  if (navigator.permissions) {
    const query = navigator.permissions.query;
    Permissions.prototype.query = function (descriptor) {
      if (!descriptor || descriptor.name !== 'notifications') return query.apply(this, arguments);
      const status = new EventTarget();
      const state = () => ({ default: 'prompt', granted: 'granted', denied: 'denied' })[permission()];
      Object.defineProperties(status, { state: { get: state }, name: { value: 'notifications' } });
      status.onchange = null;
      return Promise.resolve(status);
    };
  }
  if (window.ServiceWorkerRegistration) {
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      if (permission() !== 'granted')
        return Promise.reject(new TypeError('No notification permission has been granted for this origin.'));
      showNote({}, title, options || {});
      return Promise.resolve();
    };
    ServiceWorkerRegistration.prototype.getNotifications = function () {
      return Promise.resolve([...shown.values()].filter((note) => note instanceof PageNotification));
    };
  }
  const clickNote = (id) => {
    const note = shown.get(id);
    if (!note) return;
    if (note instanceof PageNotification) fire(note, 'click');
  };
  Object.defineProperty(window, key, {
    value: {
      // Only main knows the token: the page cannot switch the dialogs back to the native ones (security review R2–R4, V2).
      set: (secret, value) => { if (secret === token) { current = value; settle(false); } }, clip, paste: () => clip('paste'),
      // spec/remote-access-and-mobile#browser-from-device: a device's copy reads what the page copied; its paste brings the device's clipboard.
      buffer: () => current.buffer, put: (value) => { current.buffer = text(value); },
      // spec/remote-access-and-mobile#networking: the device's choice in a picker the page reported.
      pick,
      // spec/browser-and-simulator#notifications: the person clicked the page's notification; the strip closed without a decision.
      click: clickNote, asked: () => settle(true),
    },
    enumerable: false,
  });
}`;
/**
 * The script for a page (or a frame of it) with this state. `token` is the tab's own secret: the script is installed on
 * every document before the page's scripts run, so the page can neither plant its own object under the key first nor
 * change the state of ours (security review R2–R4, V2).
 */
export function pageAgentScript(state: PageAgentState, token: string) {
	return `(${install})(${JSON.stringify(state)}, ${JSON.stringify(pageBinding)}, ${JSON.stringify(token)});`;
}
