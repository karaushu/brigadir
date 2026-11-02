import {
	Component,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type ErrorInfo,
	type ReactNode,
} from 'react';
import { t, type Locale, type MessageKey, type RendererErrorSurface } from '@brigadir/core';
import {
	crashDetails,
	crashReport,
	isChunkLoadError,
	reloadForMissingChunk,
	reportCrash,
	type Crash,
} from '../crash-recovery';
import { Button } from './Controls';
import { Glyph } from './Glyph';
import s from './ErrorBoundary.module.css';
type Props = {
	surface: RendererErrorSurface;
	/** A new key mounts the surface again: the next task, the next project. */ resetKey?: string;
	fallback: (crash: Crash, reset: () => void) => ReactNode;
	children: ReactNode;
};
type State = { crash: Crash | null; resetKey: string | undefined; reloading: boolean };
/** spec/architecture-and-platform#crash-recovery: an error in one surface takes down only that surface. */
export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { crash: null, resetKey: props.resetKey, reloading: false };
	}
	static getDerivedStateFromError(error: unknown): Partial<State> {
		return { crash: { error, componentStack: '' } };
	}
	static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
		return props.resetKey !== state.resetKey ? { crash: null, resetKey: props.resetKey } : null;
	}
	override componentDidCatch(error: unknown, info: ErrorInfo) {
		const crash = { error, componentStack: info.componentStack ?? '' };
		if (window.brigadir.testCrash === this.props.surface)
			sessionStorage.setItem(`brigadir:test-crash:${this.props.surface}`, '1');
		// The window reloads in a moment: an error screen for half a second would only flash.
		if (reloadForMissingChunk(this.props.surface, crash)) {
			this.setState({ crash, reloading: true });
			return;
		}
		this.setState({ crash });
		console.error(error);
		void reportCrash(crashReport('boundary', this.props.surface, crash));
	}
	private readonly reset = () => this.setState({ crash: null });
	override render() {
		return this.state.reloading
			? null
			: this.state.crash
				? this.props.fallback(this.state.crash, this.reset)
				: this.props.children;
	}
}
function useCopy(surface: RendererErrorSurface, crash: Crash) {
	const [copied, setCopied] = useState(false),
		timer = useRef(0);
	useEffect(() => () => clearTimeout(timer.current), []);
	return {
		copied,
		copy: () => {
			void window.brigadir.copyText(crashDetails(surface, crash)).then(
				() => {
					setCopied(true);
					clearTimeout(timer.current);
					timer.current = window.setTimeout(() => setCopied(false), 1500);
				},
				() => {}
			);
		},
	};
}
/** The whole window: the bar under the window buttons stays draggable. */
export function WindowCrash({ crash, locale }: { crash: Crash; locale: Locale }) {
	const { copied, copy } = useCopy('window', crash),
		stale = isChunkLoadError(crash.error),
		details = crashDetails('window', crash);
	// App applied the theme and is gone: the window keeps following the app's appearance (settings or macOS).
	useEffect(() => {
		const apply = (dark: boolean) => {
			document.documentElement.dataset.theme = dark ? 'dark' : 'light';
		};
		void window.brigadir.readAppearance().then(
			(value) => apply(value.dark),
			() => {}
		);
		return window.brigadir.onAppearanceChanged((value) => apply(value.dark));
	}, []);
	return (
		<main className={s.window} data-crash="window">
			<div className={s.titlebar} />
			<section className={s.column} role="alert" aria-labelledby="crash-title">
				<Glyph name="review-warning" size={28} />
				<h1 id="crash-title">{t(locale, 'The window stopped because of an error')}</h1>
				<p>
					{t(
						locale,
						'Agents and commands continue to run. When the window reloads, your tasks and chats stay in their places.'
					)}
				</p>
				{stale && <p>{t(locale, 'The application files changed. Restart Brigadir.')}</p>}
				<div className={s.actions} data-size="m">
					<Button
						appearance="primary"
						onClick={() => {
							void window.brigadir.reloadWindow().catch(() => {});
						}}>
						{t(locale, 'Reload the window')}
					</Button>
					<Button onClick={copy}>{t(locale, copied ? 'Copied' : 'Copy the details')}</Button>
				</div>
				<details className={s.details}>
					<summary>
						<Glyph name="chevron-down" size={10} />
						{t(locale, 'Error details')}
					</summary>
					<pre>{details}</pre>
				</details>
			</section>
		</main>
	);
}
const surfaceTitles: Record<Exclude<RendererErrorSurface, 'window'>, MessageKey> = {
	task: 'The task window stopped because of an error',
	project: 'The board stopped because of an error',
	chat: 'The chat stopped because of an error',
	documents: 'The document stopped because of an error',
	panel: 'The panel stopped because of an error',
	console: 'The console stopped because of an error',
	browser: 'The browser stopped because of an error',
	simulator: 'The simulator stopped because of an error',
};
/** One surface of the window: the rest keeps working, «Show again» mounts this one anew. */
export function SurfaceCrash({
	surface,
	crash,
	reset,
	locale,
	frame,
}: {
	surface: Exclude<RendererErrorSurface, 'window'>;
	crash: Crash;
	reset(): void;
	locale: Locale;
	/** A column with its own width keeps it. */ frame?: CSSProperties | undefined;
}) {
	const { copied, copy } = useCopy(surface, crash),
		stale = isChunkLoadError(crash.error);
	return (
		<div
			className={s.surface}
			data-crash={surface}
			role="alert"
			style={frame}
			data-framed={frame ? true : undefined}>
			{/* These surfaces draw their own drag strip (the title strip, the browser's address bar): the screen keeps one. */}
			{(surface === 'task' ||
				surface === 'project' ||
				surface === 'browser' ||
				surface === 'simulator') && (
				<div
					className={s.surfaceTitlebar}
					data-short={surface === 'browser' || surface === 'simulator' || undefined}
				/>
			)}
			<Glyph name="review-warning" size={20} />
			<h2>{t(locale, surfaceTitles[surface])}</h2>
			{stale && <p>{t(locale, 'The application files changed. Restart Brigadir.')}</p>}
			{/* Canvas v3 5.15: a surface's actions are S (24); the window's keep M (28). */}
			<div className={s.actions} data-size="s">
				<Button onClick={reset}>{t(locale, 'Show again')}</Button>
				<Button onClick={copy}>{t(locale, copied ? 'Copied' : 'Copy the details')}</Button>
			</div>
		</div>
	);
}
/** `BRIGADIR_TEST_CRASH=<surface>` (e2e only): the surface throws once per window session, so «Show again» and a reload recover. */
export function CrashProbe({ surface }: { surface: RendererErrorSurface }) {
	if (window.brigadir.testCrash !== surface) return null;
	const mark = `brigadir:test-crash:${surface}`;
	// The boundary marks the catch: React renders a throwing tree twice before it gives up, so marking here would recover.
	if (sessionStorage.getItem(mark)) return null;
	throw new Error(`Test crash in the ${surface} surface`);
}
/** A boundary that draws the standard surface screen. */
export function SurfaceBoundary({
	surface,
	locale,
	resetKey,
	frame,
	children,
}: {
	surface: Exclude<RendererErrorSurface, 'window'>;
	locale: Locale;
	resetKey?: string;
	frame?: CSSProperties;
	children: ReactNode;
}) {
	return (
		<ErrorBoundary
			surface={surface}
			{...(resetKey === undefined ? {} : { resetKey })}
			fallback={(crash, reset) => (
				<SurfaceCrash surface={surface} crash={crash} reset={reset} locale={locale} frame={frame} />
			)}>
			<CrashProbe surface={surface} />
			{children}
		</ErrorBoundary>
	);
}
