/**
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-network: this phone's Web Push — the subscription with the machine's VAPID key, kept on the machine
 * in the device record. On iPhone only the app on the Home Screen may ask, and only from a tap.
 */
import { fromBase64Url } from '@brigadir/remote/web';
import type { Connection } from './connection';

export const pushSupported = () =>
	'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const ios = /iPhone|iPad/.test(navigator.userAgent);
const standalone = () =>
	matchMedia('(display-mode: standalone)').matches ||
	(navigator as Navigator & { standalone?: boolean }).standalone === true;
/** The card «Сповіщення на цьому телефоні» shows when the phone can ask and has not answered yet. */
export const pushOfferable = (connection: Connection) =>
	Boolean(connection.welcome.push) &&
	pushSupported() &&
	Notification.permission === 'default' &&
	(!ios || standalone());
export async function pushSubscription(): Promise<PushSubscription | null> {
	if (!pushSupported()) return null;
	const registration = await navigator.serviceWorker.getRegistration('/');
	return (await registration?.pushManager.getSubscription()) ?? null;
}
/** True when the machine keeps this phone's subscription now. */
export async function turnPushOn(connection: Connection): Promise<boolean> {
	const key = connection.welcome.push;
	if (!key || !pushSupported()) return false;
	if ((await Notification.requestPermission()) !== 'granted') return false;
	const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
	const subscription = await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: fromBase64Url(key).slice().buffer,
	});
	const json = subscription.toJSON();
	return (
		(await connection.savePush({
			endpoint: subscription.endpoint,
			p256dh: json.keys?.p256dh ?? '',
			auth: json.keys?.auth ?? '',
		})) === null
	);
}
export async function turnPushOff(connection: Connection): Promise<void> {
	await (await pushSubscription())?.unsubscribe().catch(() => false);
	await connection.savePush(null);
}
