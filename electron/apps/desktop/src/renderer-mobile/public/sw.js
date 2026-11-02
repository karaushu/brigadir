/*
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-network: the phone's service worker. A push carries the task's name and the kind, which the lock
 * screen shows, and the task's key (spec/remote-access-and-mobile#phone-task-tools), which it does not. No actions: iOS Web Push has none. A tap opens the
 * task: an open app goes there by a message (no reload, no new sign-in), a closed one opens at its address.
 * The kinds' words mirror the catalog's (`messages.ts`): a service worker cannot load the app's bundle.
 */
const words = {
	uk: {
		'needs-you': 'Чекає на тебе',
		question: 'Питання',
		permission: 'Дозвіл',
		plan: 'План',
		done: 'Готово',
		app: 'Бригадир',
	},
	en: {
		'needs-you': 'Waiting for you',
		question: 'Question',
		permission: 'Permission',
		plan: 'Plan',
		done: 'Done',
		app: 'Brigadir',
	},
};
/*
 * spec/remote-access-and-mobile#phone-app, spec/remote-access-and-mobile#outbox: the sign-in page without the machine. The app's shell — the page at `/`, the files under
 * `/assets/` (the sign-in page's and, once signed in, the app's code), the icons and the manifest — is fetched from the
 * network first and kept; when the machine is asleep or out of reach the kept page opens and says so instead of the
 * browser's error. No data is kept: the machine's data comes over the WebSocket only, never through `fetch`, and `POST
 * /session` is not a GET. Only a navigation to `/` itself is kept as the page — another address that answers is not.
 */
// The build names it (`sw-version.ts`): a new version is a new worker whose `activate` drops the older builds' caches.
const shell = 'brigadir-shell-build';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(names.filter((name) => name !== shell).map((name) => caches.delete(name)))
			)
			.then(() => self.clients.claim())
	)
);
self.addEventListener('fetch', (event) => {
	const request = event.request,
		url = new URL(request.url);
	if (request.method !== 'GET' || url.origin !== self.location.origin) return;
	const page = request.mode === 'navigate',
		root = url.pathname === '/' || url.pathname === '/index.html';
	if (!page && !/^\/(assets\/|icon|manifest)/.test(url.pathname)) return;
	event.respondWith(
		fetch(request)
			.then((response) => {
				if (response.ok && (!page || root)) {
					const copy = response.clone();
					void caches.open(shell).then((cache) => cache.put(page ? '/' : request, copy));
				}
				return response;
			})
			.catch(() => caches.match(page ? '/' : request).then((kept) => kept ?? Response.error()))
	);
});
self.addEventListener('push', (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = {};
	}
	const language = (self.navigator.language || '').toLowerCase().startsWith('uk') ? 'uk' : 'en';
	const text = words[language];
	const title = typeof data.task === 'string' && data.task ? data.task.slice(0, 200) : text.app;
	const body =
		Object.prototype.hasOwnProperty.call(text, data.type) && data.type !== 'app'
			? text[data.type]
			: '';
	const key = taskKey(data.key);
	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			// One notice per task, not per title: two tasks with one name keep their own (spec/remote-access-and-mobile#phone-task-tools).
			tag: key ? key.join('/') : title,
			icon: '/icon-192.png',
			data: key ? { key: key.join('/') } : {},
		})
	);
});
/* The ids as the app's router takes them (router.ts, core `isId`): anything else opens the home. */
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
function taskKey(value) {
	if (typeof value !== 'string') return null;
	const parts = value.split('/');
	return parts.length === 2 && parts.every((part) => id.test(part)) ? parts : null;
}
self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const key = taskKey(event.notification.data && event.notification.data.key);
	const address = key ? `/#/t/${key[0]}/${key[1]}` : '/';
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
			const open = windows[0];
			if (!open) return self.clients.openWindow(address);
			if (key) open.postMessage({ t: 'open-task', key: key.join('/') });
			return open.focus();
		})
	);
});
