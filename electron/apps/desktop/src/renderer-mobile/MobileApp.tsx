/**
 * spec/remote-access-and-mobile#phone-app: the phone's app — the stack of screens (home → project → task), the home's sheets, main's dialogs as sheets,
 * the theme of this phone and the link to the machine.
 */
import { Component, useEffect, type ReactNode } from 'react';
import { t, type Locale } from '@brigadir/core';
import { ConnectionContext } from './context';
import type { Connection } from './connection';
import { useMachineSync } from './data';
import { navigate, openSheet, useRouter, type Route } from './router';
import { useMobile, type ThemeChoice } from './store';
import { Home } from './screens/Home';
import { Project } from './screens/Project';
import { Task } from './screens/Task';
import { Tool } from './screens/Tool';
import { ProjectPullRequest } from './tools/PullRequest';
import {
	FilterSheet,
	MachineSheet,
	NewTaskSheet,
	QuotaSheet,
	ThemeSheet,
} from './screens/HomeSheets';
import { RemoteSheet, useRemoteUi } from './screens/RemoteSheets';
import s from './MobileApp.module.css';

/** A screen that throws shows what failed and how to come back, not a white page (spec/architecture-and-platform#crash-recovery on the phone). */
class Boundary extends Component<{ locale: Locale; children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div className={s.failed} role="alert">
				<p>{t(this.props.locale, 'The screen failed to draw.')}</p>
				<button type="button" onClick={() => location.reload()}>
					{t(this.props.locale, 'Reload')}
				</button>
			</div>
		);
	}
}
const dark = matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(choice: ThemeChoice) {
	const theme = choice === 'system' ? (dark.matches ? 'dark' : 'light') : choice;
	document.documentElement.dataset.theme = theme;
	const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	meta?.setAttribute('content', theme === 'dark' ? '#1e1e1e' : '#ffffff');
}
/** A screen enters once: switching the project's segment (spec/remote-access-and-mobile#phone-pr-list) keeps the same screen. */
const screenKey = (route: Route) =>
	JSON.stringify(route.screen === 'project' ? { ...route, tab: undefined } : route);
function Screens({ locale }: { locale: Locale }) {
	const { route, sheet } = useRouter();
	useRemoteUi();
	const screen =
		route.screen === 'project' ? (
			<Project projectId={route.projectId} tab={route.tab} locale={locale} />
		) : route.screen === 'pr' ? (
			<ProjectPullRequest
				projectId={route.projectId}
				scopeId={route.scopeId}
				number={route.number}
				locale={locale}
			/>
		) : route.screen === 'task' ? (
			<Task projectId={route.projectId} taskId={route.taskId} locale={locale} />
		) : route.screen === 'tool' ? (
			<Tool
				projectId={route.projectId}
				taskId={route.taskId}
				tool={route.tool}
				item={route.item}
				locale={locale}
			/>
		) : (
			<Home locale={locale} />
		);
	return (
		<>
			<div key={screenKey(route)} className={s.enter}>
				{screen}
			</div>
			{sheet?.kind === 'filter' && <FilterSheet locale={locale} />}
			{sheet?.kind === 'machine' && (
				<MachineSheet locale={locale} openTheme={() => openSheet({ kind: 'theme' })} />
			)}
			{sheet?.kind === 'theme' && <ThemeSheet locale={locale} />}
			{sheet?.kind === 'quota' && <QuotaSheet locale={locale} />}
			{sheet?.kind === 'new' && <NewTaskSheet locale={locale} projectId={sheet.projectId} />}
			{(sheet?.kind === 'dialog' || sheet?.kind === 'menu-remote') && (
				<RemoteSheet id={sheet.id} locale={locale} />
			)}
		</>
	);
}
/** The task's ids from a push's key, as the service worker checked them (sw.js) and the router takes them. */
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
/**
 * spec/remote-access-and-mobile#phone-task-tools: a tap on a notification while the app is open — the service worker sends the task's key and the app goes
 * there without a reload, so the sign-in stays. A closed app opens at `#/t/<project>/<task>` instead (router.ts).
 */
function useOpenFromPush() {
	useEffect(() => {
		const worker = navigator.serviceWorker;
		if (!worker) return;
		const take = (event: MessageEvent) => {
			const data: unknown = event.data;
			if (typeof data !== 'object' || data === null || (data as { t?: unknown }).t !== 'open-task')
				return;
			const parts = String((data as { key?: unknown }).key ?? '').split('/');
			if (parts.length !== 2 || !parts.every((part) => id.test(part))) return;
			navigate({ screen: 'task', projectId: parts[0]!, taskId: parts[1]! });
		};
		worker.addEventListener('message', take);
		return () => worker.removeEventListener('message', take);
	}, []);
}
/**
 * The iOS keyboard (spec/remote-access-and-mobile#phone-chat): Safari does not shrink the layout viewport, it slides the visual one over it, so a
 * screen sized to the page keeps its header under the status bar and its bottom bar under the keyboard. The app follows
 * `visualViewport` instead: its top and height (`--vv-top`, `--vv-height`), and `data-keyboard` while the keyboard takes
 * the bottom — then the home indicator's inset is not left above the keyboard. A pinch-zoom is the person's and is left alone.
 */
export function followVisualViewport(): () => void {
	const viewport = window.visualViewport,
		root = document.documentElement;
	if (!viewport) return () => {};
	let frame = 0;
	const apply = () => {
		frame = 0;
		if (viewport.scale > 1.01) return;
		const keyboard = root.clientHeight - viewport.height > 120;
		root.style.setProperty('--vv-height', `${Math.round(viewport.height)}px`);
		root.style.setProperty('--vv-top', `${Math.round(Math.max(0, viewport.offsetTop))}px`);
		if (keyboard) root.dataset.keyboard = '';
		else delete root.dataset.keyboard;
	};
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(apply);
	};
	apply();
	viewport.addEventListener('resize', schedule);
	viewport.addEventListener('scroll', schedule);
	return () => {
		cancelAnimationFrame(frame);
		viewport.removeEventListener('resize', schedule);
		viewport.removeEventListener('scroll', schedule);
		root.style.removeProperty('--vv-height');
		root.style.removeProperty('--vv-top');
		delete root.dataset.keyboard;
	};
}
export function MobileApp({ connection, locale }: { connection: Connection; locale: Locale }) {
	useMachineSync(connection);
	useOpenFromPush();
	useEffect(followVisualViewport, []);
	const theme = useMobile((state) => state.theme);
	useEffect(() => {
		applyTheme(theme);
		const change = () => applyTheme(useMobile.getState().theme);
		dark.addEventListener('change', change);
		return () => dark.removeEventListener('change', change);
	}, [theme]);
	return (
		<ConnectionContext value={connection}>
			<Boundary locale={locale}>
				<div className={s.app} data-mobile-app>
					<Screens locale={locale} />
				</div>
			</Boundary>
		</ConnectionContext>
	);
}
