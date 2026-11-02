import {
	_electron as electron,
	expect,
	test,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import type { SessionEvent } from '../packages/core/src/session';
import type { AgentOption } from '../packages/core/src/agent';
import type { CrewReportSummary } from '../packages/core/src/crew-runtime';
import { settle } from './settle';
import { hideChat, hidePanel, openPanelTab, showChat } from './layout';
import { refreshChanges } from './refresh-changes';
import { repoPRs } from './repos';

/**
 * Screenshots for the repository README. Not a test of behavior: it stages a neutral demo workspace (the `acme-shop`
 * monorepo with three git roots, a few tasks, a crew and a pull request) with the synthetic fixtures, opens the real
 * app in the background and saves WebP images to `docs/assets/readme/`. Skipped unless BRIGADIR_README_SHOTS is set:
 *
 *     BRIGADIR_README_SHOTS=1 pnpm exec playwright test tests/readme-shots.spec.ts --workers=1
 */
test.skip(!process.env.BRIGADIR_README_SHOTS, 'README screenshots run only on request');
test.describe.configure({ mode: 'serial' });

const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	assets = resolve('../docs/assets/readme'),
	run = promisify(execFile),
	width = 1600,
	height = 1000,
	// The README image width: device scale 2 is captured, then scaled down to keep each file small.
	imageWidth = Number(process.env.BRIGADIR_README_WIDTH || 2000),
	imageQuality = Number(process.env.BRIGADIR_README_QUALITY || 80);
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);

// ---------------------------------------------------------------------------------------------------------------
// Demo sources
// ---------------------------------------------------------------------------------------------------------------

const cartBefore = `import type { Product } from '../products/types';

export type CartLine = { product: Product; quantity: number };
export type Cart = { lines: CartLine[]; coupon: string | null };

export function addToCart(cart: Cart, product: Product, quantity = 1): Cart {
	const existing = cart.lines.find((line) => line.product.id === product.id);
	if (existing) {
		return {
			...cart,
			lines: cart.lines.map((line) =>
				line === existing ? { ...line, quantity: line.quantity + quantity } : line
			),
		};
	}
	return { ...cart, lines: [...cart.lines, { product, quantity }] };
}

export function removeFromCart(cart: Cart, productId: string): Cart {
	return { ...cart, lines: cart.lines.filter((line) => line.product.id !== productId) };
}

export function itemCount(cart: Cart): number {
	return cart.lines.reduce((sum, line) => sum + line.quantity, 0);
}
`;
const cartAfter = `import type { Product } from '../products/types';
import { discountFor } from './coupons';

export const FREE_SHIPPING_FROM = 5000; // cents
export const SHIPPING = 499;
export const TAX_RATE = 0.08;

export type CartLine = { product: Product; quantity: number };
export type Cart = { lines: CartLine[]; coupon: string | null };

export type CartTotals = {
	subtotal: number;
	discount: number;
	tax: number;
	shipping: number;
	total: number;
};

export function addToCart(cart: Cart, product: Product, quantity = 1): Cart {
	const existing = cart.lines.find((line) => line.product.id === product.id);
	if (existing) {
		return {
			...cart,
			lines: cart.lines.map((line) =>
				line === existing ? { ...line, quantity: line.quantity + quantity } : line
			),
		};
	}
	return { ...cart, lines: [...cart.lines, { product, quantity }] };
}

export function removeFromCart(cart: Cart, productId: string): Cart {
	return { ...cart, lines: cart.lines.filter((line) => line.product.id !== productId) };
}

export function itemCount(cart: Cart): number {
	return cart.lines.reduce((sum, line) => sum + line.quantity, 0);
}

/** All amounts are in cents. Free shipping applies after the discount. */
export function cartTotals(cart: Cart): CartTotals {
	const subtotal = cart.lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
	const discount = Math.min(discountFor(cart.coupon, subtotal), subtotal);
	const taxable = subtotal - discount;
	const tax = Math.round(taxable * TAX_RATE);
	const shipping = taxable === 0 || taxable >= FREE_SHIPPING_FROM ? 0 : SHIPPING;
	return { subtotal, discount, tax, shipping, total: taxable + tax + shipping };
}
`;
const summaryBefore = `import { itemCount, type Cart } from './cart';

export function CartSummary({ cart }: { cart: Cart }) {
	return (
		<aside className="cart-summary">
			<h2>Your cart</h2>
			<p>{itemCount(cart)} items</p>
			<button type="submit">Checkout</button>
		</aside>
	);
}
`;
const summaryAfter = `import { Price } from '@acme/ui';
import { cartTotals, itemCount, type Cart } from './cart';

export function CartSummary({ cart }: { cart: Cart }) {
	const totals = cartTotals(cart);
	return (
		<aside className="cart-summary">
			<h2>Your cart</h2>
			<p>{itemCount(cart)} items</p>
			<dl>
				<dt>Subtotal</dt>
				<dd><Price cents={totals.subtotal} /></dd>
				{totals.discount > 0 && (
					<>
						<dt>Discount</dt>
						<dd><Price cents={-totals.discount} /></dd>
					</>
				)}
				<dt>Tax</dt>
				<dd><Price cents={totals.tax} /></dd>
				<dt>Shipping</dt>
				<dd>{totals.shipping === 0 ? 'Free' : <Price cents={totals.shipping} />}</dd>
				<dt className="total">Total</dt>
				<dd className="total"><Price cents={totals.total} /></dd>
			</dl>
			<button type="submit">Checkout</button>
		</aside>
	);
}
`;
const cartTest = `import { describe, expect, it } from 'vitest';
import { cartTotals, type Cart } from './cart';

const mug = { id: 'mug', name: 'Enamel mug', price: 1800 };
const cart = (quantity: number, coupon: string | null = null): Cart => ({
	lines: [{ product: mug, quantity }],
	coupon,
});

describe('cartTotals', () => {
	it('adds tax and shipping below the free shipping line', () => {
		expect(cartTotals(cart(1))).toEqual({
			subtotal: 1800,
			discount: 0,
			tax: 144,
			shipping: 499,
			total: 2443,
		});
	});

	it('ships for free from $50 after the discount', () => {
		expect(cartTotals(cart(3)).shipping).toBe(0);
		expect(cartTotals(cart(3, 'SAVE10')).shipping).toBe(499);
	});

	it('is all zeros for an empty cart', () => {
		expect(cartTotals({ lines: [], coupon: null }).total).toBe(0);
	});
});
`;
const priceBefore = `export function Price({ cents }: { cents: number }) {
	return <span className="price">\${(cents / 100).toFixed(2)}</span>;
}
`;
const priceAfter = `const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function Price({ cents }: { cents: number }) {
	return (
		<span className="price" data-negative={cents < 0 || undefined}>
			{format.format(cents / 100)}
		</span>
	);
}
`;
const validateBefore = `import type { Address } from './types';

export type FieldError = { field: keyof Address; message: string };

export function validateAddress(address: Address): FieldError[] {
	const errors: FieldError[] = [];
	if (!address.name.trim()) errors.push({ field: 'name', message: 'Enter your name' });
	if (!address.street.trim()) errors.push({ field: 'street', message: 'Enter a street address' });
	if (!address.city.trim()) errors.push({ field: 'city', message: 'Enter a city' });
	if (!/^\\d{5}$/.test(address.postalCode))
		errors.push({ field: 'postalCode', message: 'Enter a 5-digit ZIP code' });
	return errors;
}
`;
const validateAfter = `import type { Address } from './types';

export type FieldError = { field: keyof Address; message: string };

const postalCodes: Record<string, RegExp> = {
	US: /^\\d{5}(-\\d{4})?$/,
	CA: /^[A-Z]\\d[A-Z] ?\\d[A-Z]\\d$/i,
	GB: /^[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2}$/i,
	DE: /^\\d{5}$/,
};

export function validateAddress(address: Address): FieldError[] {
	const errors: FieldError[] = [];
	if (!address.name.trim()) errors.push({ field: 'name', message: 'Enter your name' });
	if (!address.street.trim()) errors.push({ field: 'street', message: 'Enter a street address' });
	if (!address.city.trim()) errors.push({ field: 'city', message: 'Enter a city' });
	const pattern = postalCodes[address.country];
	if (pattern && !pattern.test(address.postalCode.trim()))
		errors.push({ field: 'postalCode', message: 'Check the postal code' });
	return errors;
}
`;

const rootFiles: Record<string, string> = {
	'.gitignore': 'node_modules/\ndist/\npackages/ui/\nservices/payments/\n',
	'README.md':
		'# acme-shop\n\nThe Acme web shop: storefront, shared UI kit and the payments service.\n\n```sh\npnpm install\npnpm dev\n```\n',
	'package.json':
		JSON.stringify(
			{
				name: 'acme-shop',
				private: true,
				scripts: { dev: 'pnpm --filter web dev', test: 'vitest run', lint: 'eslint .' },
				devDependencies: { typescript: '^5.9.0', vitest: '^4.0.0' },
			},
			null,
			2
		) + '\n',
	'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n  - services/*\n',
	'tsconfig.json':
		JSON.stringify(
			{ compilerOptions: { strict: true, jsx: 'react-jsx', module: 'esnext', target: 'es2022' } },
			null,
			2
		) + '\n',
	'apps/web/package.json':
		JSON.stringify(
			{ name: 'web', private: true, dependencies: { '@acme/ui': 'workspace:*', react: '^19.0.0' } },
			null,
			2
		) + '\n',
	'apps/web/src/cart/cart.ts': cartBefore,
	'apps/web/src/cart/CartSummary.tsx': summaryBefore,
	'apps/web/src/cart/coupons.ts': `const coupons: Record<string, (subtotal: number) => number> = {
	SAVE10: (subtotal) => Math.round(subtotal * 0.1),
	WELCOME5: () => 500,
};

export function discountFor(code: string | null, subtotal: number): number {
	return code ? (coupons[code.toUpperCase()]?.(subtotal) ?? 0) : 0;
}
`,
	'apps/web/src/checkout/types.ts':
		'export type Address = {\n\tname: string;\n\tstreet: string;\n\tcity: string;\n\tpostalCode: string;\n\tcountry: string;\n};\n',
	'apps/web/src/checkout/validate.ts': validateBefore,
	'apps/web/src/checkout/CheckoutForm.tsx': `import { useState } from 'react';
import { Button } from '@acme/ui';
import { validateAddress, type FieldError } from './validate';
import type { Address } from './types';

const empty: Address = { name: '', street: '', city: '', postalCode: '', country: 'US' };

export function CheckoutForm({ onSubmit }: { onSubmit: (address: Address) => void }) {
	const [address, setAddress] = useState(empty);
	const [errors, setErrors] = useState<FieldError[]>([]);
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				const found = validateAddress(address);
				setErrors(found);
				if (!found.length) onSubmit(address);
			}}
		>
			{errors.map((error) => (
				<p key={error.field} role="alert">
					{error.message}
				</p>
			))}
			<Button type="submit">Place order</Button>
		</form>
	);
}
`,
	'apps/web/src/products/types.ts':
		'export type Product = { id: string; name: string; price: number; tags?: string[] };\n',
	'apps/web/src/products/search.ts': `import type { Product } from './types';

export function searchProducts(products: Product[], query: string): Product[] {
	const words = query.toLowerCase().split(/\\s+/).filter(Boolean);
	return products.filter((product) =>
		words.every((word) => product.name.toLowerCase().includes(word))
	);
}
`,
	'apps/web/src/lib/money.ts':
		'export const cents = (dollars: number) => Math.round(dollars * 100);\n',
};
const uiFiles: Record<string, string> = {
	'package.json':
		JSON.stringify({ name: '@acme/ui', version: '1.4.0', main: 'src/index.ts' }, null, 2) + '\n',
	'src/index.ts': "export { Button } from './Button';\nexport { Price } from './Price';\n",
	'src/Button.tsx': `import type { ButtonHTMLAttributes } from 'react';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button {...props} className={['acme-button', props.className].filter(Boolean).join(' ')} />;
}
`,
	'src/Price.tsx': priceBefore,
};
const paymentsFiles: Record<string, string> = {
	'package.json': JSON.stringify({ name: 'payments', private: true }, null, 2) + '\n',
	'src/charge.ts': `export type Charge = { orderId: string; amount: number; currency: 'USD' };

export async function charge(request: Charge, idempotencyKey: string) {
	const response = await fetch(process.env.PAYMENTS_URL + '/charges', {
		method: 'POST',
		headers: { 'Idempotency-Key': idempotencyKey, 'Content-Type': 'application/json' },
		body: JSON.stringify(request),
	});
	if (!response.ok) throw new Error(\`Charge failed: \${response.status}\`);
	return (await response.json()) as { id: string };
}
`,
	'src/refunds.ts':
		"export async function refund(chargeId: string) {\n\treturn fetch(process.env.PAYMENTS_URL + '/refunds/' + chargeId, { method: 'POST' });\n}\n",
};

// ---------------------------------------------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------------------------------------------

type Workspace = {
	root: string;
	home: string;
	data: string;
	shop: string;
	ghState: string;
	agent: string;
	server: Server;
	url: string;
};
let workspace: Workspace;

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: 'Acme Dev',
	GIT_AUTHOR_EMAIL: 'dev@acme.example',
	GIT_COMMITTER_NAME: 'Acme Dev',
	GIT_COMMITTER_EMAIL: 'dev@acme.example',
};
const git =
	(cwd: string) =>
	async (...args: string[]) =>
		(await run('git', args, { cwd, env: gitEnv })).stdout.trim();
async function writeTree(dir: string, files: Record<string, string>) {
	for (const [file, text] of Object.entries(files)) {
		await mkdir(dirname(join(dir, file)), { recursive: true });
		await writeFile(join(dir, file), text);
	}
}
/** A repo with an `origin` (a bare repo beside it) and a few commits of history. */
async function initRepo(root: string, path: string, files: Record<string, string>) {
	await mkdir(path, { recursive: true });
	const remote = join(root, 'remotes', path.replace(/\W/g, '_') + '.git');
	await mkdir(remote, { recursive: true });
	await run('git', ['init', '--bare', '-q', '-b', 'main'], { cwd: remote });
	const g = git(path);
	await g('init', '-q', '-b', 'main');
	await writeTree(path, files);
	await g('add', '-A');
	await g('commit', '-q', '-m', 'Initial commit');
	await g('remote', 'add', 'origin', remote);
	await g('push', '-q', '-u', 'origin', 'main');
	await g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
	return g;
}
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
async function writeTask(task: { id: string; projectId: string } & Record<string, unknown>) {
	const dir = join(workspace.data, 'projects', task.projectId, 'tasks', task.id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'task.json'), JSON.stringify({ schemaVersion: 1, task }));
	return dir;
}
async function writeJournal(
	projectId: string,
	taskId: string,
	events: { event: SessionEvent | Record<string, unknown>; at?: number }[]
) {
	let time = Date.now() - 25 * 60_000;
	await writeFile(
		join(workspace.data, 'projects', projectId, 'tasks', taskId, 'events.jsonl'),
		events
			.map((entry, index) => {
				time = entry.at ?? time + 4000;
				return JSON.stringify({
					schemaVersion: 1,
					seq: index + 1,
					at: new Date(time).toISOString(),
					event: entry.event,
				});
			})
			.join('\n') + '\n'
	);
}
async function writeSettings(settings: Record<string, unknown>) {
	await writeFile(
		join(workspace.data, 'settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: {
				appearance: 'dark',
				language: 'en',
				modules: { browser: true, simulator: true, pullRequests: true, commands: true },
				...settings,
			},
		})
	);
}

async function launch(
	options: { theme?: 'light' | 'dark'; extraEnv?: Record<string, string> } = {}
): Promise<{ app: ElectronApplication; page: Page }> {
	await writeSettings({ appearance: options.theme ?? 'dark' });
	const app = await electron.launch({
		executablePath,
		args: [
			desktop,
			`--user-data-dir=${join(workspace.root, 'profile')}`,
			'--force-device-scale-factor=2',
		],
		env: {
			...env,
			HOME: workspace.home,
			BRIGADIR_DATA_DIR: workspace.data,
			BRIGADIR_TEST_AGENT: workspace.agent,
			BRIGADIR_TEST_GH: resolve('packages/forge/fixtures/gh.mjs'),
			BRIGADIR_TEST_GH_STATE: workspace.ghState,
			BRIGADIR_TEST_NOTIFICATIONS: '1',
			...options.extraEnv,
		},
	});
	const page = await app.firstWindow();
	await app.evaluate(
		({ BrowserWindow }, size) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height),
		{ width, height }
	);
	await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
	return { app, page };
}
/** Quits the app the normal way; detached task hosts exit with it. */
async function quit(app: ElectronApplication) {
	await app.close();
}

/** Saves a screenshot of the page (or a part of it) as WebP in docs/assets/readme. */
async function shot(
	page: Page,
	name: string,
	options: { clip?: { x: number; y: number; width: number; height: number }; png?: Buffer } = {}
) {
	// Spinners of working tasks restart their animations; give the rest a few seconds to finish.
	await Promise.race([settle(page), new Promise((done) => setTimeout(done, 3000))]);
	const png = join(process.env.BRIGADIR_README_RAW || join(workspace.root, 'shots'), `${name}.png`);
	await mkdir(dirname(png), { recursive: true });
	if (options.png) await writeFile(png, options.png);
	else
		await page.screenshot({
			path: png,
			animations: 'disabled',
			...(options.clip ? { clip: options.clip } : {}),
		});
	await mkdir(assets, { recursive: true });
	const out = join(assets, `${name}.webp`),
		shown = options.clip?.width ?? (await page.evaluate(() => window.innerWidth)),
		target = Math.min(imageWidth, Math.round(shown * 1.25));
	await run('cwebp', [
		'-quiet',
		'-q',
		String(imageQuality),
		'-m',
		'6',
		'-resize',
		String(target),
		'0',
		png,
		'-o',
		out,
	]);
	return (await stat(out)).size;
}
const openTask = (page: Page, title: string) =>
	page
		.locator('aside')
		.getByRole('button', { name: new RegExp(title) })
		.first()
		.click();
async function setTheme(app: ElectronApplication, page: Page, theme: 'light' | 'dark') {
	await app.evaluate(({ nativeTheme }, theme) => {
		nativeTheme.themeSource = theme;
	}, theme);
	await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
async function menuClick(app: ElectronApplication, id: string) {
	await expect
		.poll(() =>
			app.evaluate(
				({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)?.enabled ?? false,
				id
			)
		)
		.toBe(true);
	await app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id);
}

// ---------------------------------------------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------------------------------------------

const hero = { projectId: 'acme-shop', id: 'cart-totals' };
/** The model and effort the composer shows, as an adapter's option catalog would list them. */
const demoOptions: AgentOption[] = [
	{
		id: 'model',
		name: 'Model',
		description: null,
		category: 'model',
		kind: 'select',
		value: 'opus',
		choices: [
			{ value: 'opus', name: 'Opus', description: null, group: null },
			{ value: 'sonnet', name: 'Sonnet', description: null, group: null },
		],
	},
	{
		id: 'effort',
		name: 'Effort',
		description: null,
		category: 'thought_level',
		kind: 'select',
		value: 'high',
		choices: ['low', 'medium', 'high'].map((value) => ({
			value,
			name: value[0]!.toUpperCase() + value.slice(1),
			description: null,
			group: null,
		})),
	},
];

function heroJournal(): { event: SessionEvent }[] {
	const tool = (id: string, name: string, category: string, title: string, patch: object = {}) => [
		{
			event: { kind: 'tool.changed', patch: { id, name, title, category, status: 'in_progress' } },
		},
		{ event: { kind: 'tool.changed', patch: { id, status: 'completed', ...patch } } },
	];
	const say = (id: string, text: string) => ({
		event: {
			kind: 'message.delta',
			role: 'assistant',
			messageId: id,
			content: { kind: 'text', text },
		},
	});
	return [
		{ event: { kind: 'checkpoint.created', checkpoint: 0 } },
		{
			event: {
				kind: 'session.started',
				sessionId: 'demo',
				modes: [],
				modeId: null,
				options: demoOptions,
			},
		},
		{
			event: {
				kind: 'turn.started',
				text: 'Add cart totals to the cart summary: subtotal, coupon discount, 8% tax and shipping. Shipping is free from $50 after the discount. Cover it with tests.',
			},
		},
		say('m1', 'I will look at the cart model and how prices are shown first.'),
		...tool('t1', 'Read', 'read', 'Read apps/web/src/cart/cart.ts', {
			locations: [{ path: 'apps/web/src/cart/cart.ts', line: null }],
		}),
		...tool('t2', 'Read', 'read', 'Read apps/web/src/cart/coupons.ts', {
			locations: [{ path: 'apps/web/src/cart/coupons.ts', line: null }],
		}),
		...tool('t3', 'Grep', 'search', 'grep -rn "Price" packages/ui/src apps/web/src'),
		...tool('t4', 'Read', 'read', 'Read packages/ui/src/Price.tsx', {
			locations: [{ path: 'packages/ui/src/Price.tsx', line: null }],
		}),
		say(
			'm2',
			'Amounts are kept in cents, and `Price` from the UI kit formats them with `toFixed`, which prints `$-5.00` for a discount. I will add `cartTotals()` next to the cart, switch `Price` to `Intl.NumberFormat` and show the totals in `CartSummary`.'
		),
		...tool('t5', 'Edit', 'edit', 'Edit apps/web/src/cart/cart.ts', {
			content: [
				{ kind: 'diff', path: 'apps/web/src/cart/cart.ts', before: cartBefore, after: cartAfter },
			],
		}),
		...tool('t6', 'Edit', 'edit', 'Edit packages/ui/src/Price.tsx', {
			content: [
				{ kind: 'diff', path: 'packages/ui/src/Price.tsx', before: priceBefore, after: priceAfter },
			],
		}),
		...tool('t7', 'Edit', 'edit', 'Edit apps/web/src/cart/CartSummary.tsx', {
			content: [
				{
					kind: 'diff',
					path: 'apps/web/src/cart/CartSummary.tsx',
					before: summaryBefore,
					after: summaryAfter,
				},
			],
		}),
		...tool('t8', 'Write', 'edit', 'Write apps/web/src/cart/cart.test.ts', {
			content: [
				{ kind: 'diff', path: 'apps/web/src/cart/cart.test.ts', before: null, after: cartTest },
			],
		}),
		...tool('t9', 'Bash', 'execute', 'pnpm vitest run apps/web/src/cart', {
			exitCode: 0,
			output:
				' ✓ apps/web/src/cart/cart.test.ts (3 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  412ms',
		}),
		{
			event: {
				kind: 'plan.changed',
				entries: [
					{
						text: 'Add cartTotals() with tax, discount and shipping',
						priority: 'medium',
						status: 'completed',
					},
					{
						text: 'Format negative amounts in the UI kit Price',
						priority: 'medium',
						status: 'completed',
					},
					{ text: 'Show the totals in CartSummary', priority: 'medium', status: 'completed' },
					{
						text: 'Cover the free shipping line with tests',
						priority: 'medium',
						status: 'completed',
					},
				],
			},
		},
		say(
			'm3',
			'Done. `cartTotals()` returns subtotal, discount, tax, shipping and total in cents; shipping is free once the discounted subtotal reaches $50. `CartSummary` lists each line and shows **Free** instead of $0.00. The UI kit `Price` now formats negative amounts as `-$5.00`. Three new tests pass.'
		),
		{ event: { kind: 'usage.changed', used: 46_000, capacity: 200_000, cost: null } },
		{ event: { kind: 'checkpoint.created', checkpoint: 1 } },
		{ event: { kind: 'turn.completed', reason: 'end_turn' } },
		{ event: { kind: 'host.stopped', reason: 'idle' } },
	] as { event: SessionEvent }[];
}

async function stage() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-readme-')),
		home = join(root, 'home'),
		data = join(root, 'data'),
		shop = join(home, 'projects', 'acme-shop'),
		docs = join(home, 'projects', 'acme-docs'),
		ghState = join(root, 'gh.json');
	const server = createServer((request, response) => {
		response.setHeader('content-type', 'text/html; charset=utf-8');
		response.end(storefront);
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	// The synthetic agent with the model names a real catalog shows instead of «Fixture» and «Other».
	const fixtures = resolve('packages/transport/fixtures'),
		agent = join(root, 'agent', 'agent.mjs');
	await mkdir(dirname(agent), { recursive: true });
	await symlink(resolve('packages/transport/node_modules'), join(root, 'agent', 'node_modules'));
	await writeFile(
		agent,
		(await readFile(join(fixtures, 'agent.mjs'), 'utf8'))
			.replace("{value:'fixture',name:'Fixture'}", "{value:'fixture',name:'Opus'}")
			.replace("{value:'other',name:'Other'}", "{value:'other',name:'Sonnet'}")
	);
	workspace = {
		agent,
		root,
		home,
		data,
		shop,
		ghState,
		server,
		url: `http://localhost:${(server.address() as { port: number }).port}/cart`,
	};
	const shopGit = await initRepo(root, shop, rootFiles);
	await initRepo(root, join(shop, 'packages/ui'), uiFiles);
	await initRepo(root, join(shop, 'services/payments'), paymentsFiles);
	await initRepo(root, docs, {
		'README.md': '# acme-docs\n\nGuides and API reference for the Acme platform.\n',
		'guides/payments.md': '# Payments\n\nCharges are idempotent.\n',
	});
	// A little history for blame and the commit list.
	await writeFile(
		join(shop, 'apps/web/src/lib/money.ts'),
		'export const cents = (dollars: number) => Math.round(dollars * 100);\nexport const dollars = (cents: number) => cents / 100;\n'
	);
	await shopGit('commit', '-q', '-am', 'lib: add dollars()');
	// The pull request: a pushed branch that changes checkout validation.
	await shopGit('switch', '-q', '-c', 'feat/postal-codes');
	await writeFile(join(shop, 'apps/web/src/checkout/validate.ts'), validateAfter);
	await shopGit('commit', '-q', '-am', 'checkout: validate postal codes per country');
	const prSha = await shopGit('rev-parse', 'HEAD');
	await shopGit(
		'push',
		'-q',
		'origin',
		'HEAD:refs/pull/42/head',
		'HEAD:refs/heads/feat/postal-codes'
	);
	await shopGit('switch', '-q', 'main');
	await writeFile(
		ghState,
		JSON.stringify({
			repoNames: true,
			viewer: 'me',
			pullRequests: pullRequests(prSha),
		})
	);

	await mkdir(join(data, 'projects/acme-shop'), { recursive: true });
	await writeFile(
		join(data, 'projects/acme-shop/project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: {
				id: 'acme-shop',
				name: 'acme-shop',
				path: shop,
				icon: { kind: 'lucide', name: 'shopping-cart', color: 'orange', by: 'person' },
				commands: [
					{ id: 'dev', name: 'Dev server', command: 'pnpm dev', repo: '', directory: '' },
					{ id: 'test', name: 'Tests', command: 'pnpm test', repo: '', directory: '' },
				],
			},
		})
	);
	await mkdir(join(data, 'projects/acme-docs'), { recursive: true });
	await writeFile(
		join(data, 'projects/acme-docs/project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: {
				id: 'acme-docs',
				name: 'acme-docs',
				path: docs,
				icon: { kind: 'lucide', name: 'book-open', color: 'blue', by: 'person' },
			},
		})
	);
	await stageOtherTasks();
	await stageCrew();
	await writeTask({
		...hero,
		title: 'Add cart totals',
		status: 'done',
		provider: 'claude',
		transport: 'gui',
		modelName: 'Opus',
		effortName: 'High',
		hasStarted: true,
		updatedAt: at(2),
	});
	// Snapshots: the baseline, the agent's edits, then a second snapshot (the app makes them; the journal is written after).
	{
		const { app, page } = await launch();
		await openTask(page, 'Add cart totals');
		const checkpoint = async (id: number) => {
			await refreshChanges(page);
			await expect
				.poll(() =>
					page.evaluate(async (key) => (await window.brigadir.readChanges(key)).checkpoint, hero)
				)
				.toBe(id);
		};
		await checkpoint(0);
		await writeFile(join(shop, 'apps/web/src/cart/cart.ts'), cartAfter);
		await writeFile(join(shop, 'apps/web/src/cart/CartSummary.tsx'), summaryAfter);
		await writeFile(join(shop, 'apps/web/src/cart/cart.test.ts'), cartTest);
		await writeFile(join(shop, 'packages/ui/src/Price.tsx'), priceAfter);
		await checkpoint(1);
		// Live tasks: the synthetic agent holds a turn (working) or asks a question (needs you). Their hosts outlive
		// the app and stop by themselves once the fixture folder is deleted.
		await page.evaluate(async (live) => {
			for (const [id, text] of live) {
				const key = { projectId: 'acme-shop', id };
				await window.brigadir.startSession(key as never);
				await window.brigadir.sendCommand(key, { kind: 'prompt', text });
			}
		}, live);
		await expect
			.poll(() =>
				page.evaluate(async () => {
					const workspace = await window.brigadir.readWorkspace();
					return workspace.tasks.filter(
						(task) => task.status === 'working' || task.status === 'needs-you'
					).length;
				})
			)
			.toBe(live.length);
		await quit(app);
	}
	await writeJournal(hero.projectId, hero.id, heroJournal());
	// The synthetic agent asks about colours; the sidebar line (read from the journal) shows the question this task would ask.
	const questionJournal = join(data, 'projects/acme-shop/tasks/checkout-validation/events.jsonl');
	await writeFile(
		questionJournal,
		(await readFile(questionJournal, 'utf8')).replace(
			'"question":"Which color?"',
			'"question":"Which countries should checkout accept?"'
		)
	);
}
const live: [string, string][] = [
	['product-search', 'hold'],
	['checkout-validation', 'question'],
	['crew-form', 'hold'],
	['crew-review', 'hold'],
];

async function stageOtherTasks() {
	const task = (id: string, projectId: string, title: string, rest: Record<string, unknown>) =>
		writeTask({ id, projectId, title, transport: 'gui', hasStarted: true, ...rest });
	await task('checkout-validation', 'acme-shop', 'Fix checkout validation', {
		status: 'done',
		provider: 'claude',
		modelName: 'Opus',
		effortName: 'Medium',
		readOnlyAgent: true,
		updatedAt: at(4),
	});
	await task('product-search', 'acme-shop', 'Speed up product search', {
		status: 'done',
		provider: 'codex',
		modelName: 'GPT-5.5',
		readOnlyAgent: true,
		updatedAt: at(1),
	});
	await task('readme-badges', 'acme-shop', 'Update README badges', {
		status: 'completed',
		provider: 'codex',
		completedAt: at(60 * 20),
		updatedAt: at(60 * 20),
	});
	await task('email-dark-mode', 'acme-shop', 'Dark mode for order emails', {
		status: 'backlog',
		provider: 'claude',
		hasStarted: false,
		updatedAt: at(60 * 30),
	});
	await task('payments-api-docs', 'acme-docs', 'Document the payments API', {
		status: 'done',
		provider: 'codex',
		modelName: 'GPT-5.5',
		updatedAt: at(35),
		hasUnread: true,
	});
}

const crewAgent = (
	id: string,
	name: string,
	role: 'foreman' | 'developer' | 'reviewer',
	agents: unknown[] = [],
	checkedBy: string[] = [],
	zone: string[] = []
) => ({
	id,
	name,
	role,
	provider: role === 'reviewer' ? 'codex' : 'claude',
	requestedChoices: {},
	choiceNames: {},
	instructions: '',
	extraInstructions: '',
	zone,
	checkedBy,
	agents,
});
async function stageCrew() {
	const crew = {
		schemaVersion: 1,
		templateId: null,
		name: 'Checkout crew',
		resolvedAt: at(50),
		root: crewAgent('foreman', 'Foreman', 'foreman', [
			crewAgent('web', 'Storefront', 'developer', [], ['review'], ['apps/web/**']),
			crewAgent('pay', 'Payments', 'developer', [], ['review'], ['services/payments/**']),
			crewAgent('review', 'Reviewer', 'reviewer'),
		]),
	};
	await writeTask({
		id: 'one-page-checkout',
		projectId: 'acme-shop',
		title: 'One-page checkout',
		status: 'done',
		provider: 'claude',
		transport: 'gui',
		hasStarted: true,
		taskTree: { branch: 'main', worktree: false },
		scopeNames: ['acme-shop', 'packages/ui', 'services/payments'],
		crew,
		updatedAt: at(3),
	});
	const worker = (
		id: string,
		title: string,
		node: string,
		status: string,
		minutes: number,
		provider = 'claude'
	) =>
		writeTask({
			id,
			projectId: 'acme-shop',
			title,
			status,
			provider,
			transport: 'gui',
			hasStarted: true,
			// The synthetic agent only holds a turn; a read-only agent takes no repo lock, so the held turns do not block each other.
			readOnlyAgent: true,
			crewTaskId: 'one-page-checkout',
			crewNodeId: node,
			parentTaskId: 'one-page-checkout',
			updatedAt: at(minutes),
		});
	await worker('crew-form', 'Checkout form on one page', 'web', 'done', 1);
	await worker('crew-charge', 'Idempotent charge on submit', 'pay', 'done', 6);
	await worker('crew-review', 'checks Storefront, Payments', 'review', 'done', 2, 'codex');
	const plan = {
		id: 'plan-1',
		summary:
			'Two parts that touch different repos, so they run in parallel. The **Reviewer** checks both before I accept them.\n\n- `apps/web/**` belongs to Storefront\n- `services/payments/**` belongs to Payments',
		parts: [
			{
				id: 'p1',
				title: 'Checkout form on one page',
				agent: 'Storefront',
				prompt: 'Merge the address, delivery and payment steps of the checkout into one page.',
				files: ['apps/web/src/checkout/**'],
				scopes: [],
			},
			{
				id: 'p2',
				title: 'Idempotent charge on submit',
				agent: 'Payments',
				prompt: 'Charge once per order: derive the idempotency key from the order id.',
				files: ['services/payments/src/**'],
				scopes: [],
			},
		],
	};
	const report: CrewReportSummary = {
		taskId: 'crew-charge',
		nodeId: 'pay',
		name: 'Payments',
		title: 'Idempotent charge on submit',
		additions: 34,
		deletions: 9,
		files: 3,
		outside: 0,
		verdict: 'pending',
		round: 1,
		newNotes: 1,
	};
	await writeJournal('acme-shop', 'one-page-checkout', [
		{
			event: {
				kind: 'session.started',
				sessionId: 'demo',
				modes: [],
				modeId: null,
				options: demoOptions,
			},
		},
		{
			event: {
				kind: 'turn.started',
				text: 'Move checkout to one page: address, delivery and payment together. A double click on "Place order" must never charge twice.',
			},
		},
		{
			event: {
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'f1',
				content: {
					kind: 'text',
					text: 'The form lives in `apps/web` and the charge in `services/payments`, two separate repos. I will split the work between two developers and have the reviewer check both.',
				},
			},
		},
		{ event: { kind: 'crew.plan.requested', plan } },
		{ event: { kind: 'crew.plan.resolved', id: 'plan-1', approved: true, parts: null } },
		{
			event: {
				kind: 'turn.started',
				text: '',
				crew: { kind: 'plan-decision', planId: 'plan-1', approved: true },
			},
		},
		{
			event: {
				kind: 'crew.worker.created',
				taskId: 'crew-form',
				nodeId: 'web',
				name: 'Storefront',
				title: 'Checkout form on one page',
			},
		},
		{
			event: {
				kind: 'crew.worker.created',
				taskId: 'crew-charge',
				nodeId: 'pay',
				name: 'Payments',
				title: 'Idempotent charge on submit',
			},
		},
		{
			event: {
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'f2',
				content: {
					kind: 'text',
					text: 'Both developers have started. I will wait for their reports.',
				},
			},
		},
		{ event: { kind: 'turn.completed', reason: 'end_turn' } },
		{ event: { kind: 'crew.report', report } },
		{ event: { kind: 'turn.started', text: '', crew: { kind: 'report', report } } },
		{
			event: {
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'f3',
				content: {
					kind: 'text',
					text: 'Payments reported: the idempotency key is now `order:<id>`, and a retry returns the first charge. Waiting for the Reviewer before accepting it.',
				},
			},
		},
		{
			event: {
				kind: 'crew.review',
				reviewId: 'r1',
				taskId: 'crew-charge',
				name: 'Payments',
				reviewer: 'Reviewer',
				round: 1,
				approved: false,
				comments: 0,
				state: 'reviewing',
			},
		},
		{ event: { kind: 'turn.completed', reason: 'end_turn' } },
		{ event: { kind: 'host.stopped', reason: 'idle' } },
	]);
}

function pullRequests(sha: string) {
	return [
		{
			repo: 'acme-shop',
			number: 42,
			title: 'Checkout: validate postal codes per country',
			author: 'me',
			requested: ['web-reviewer'],
			comments: 2,
			checks: 'SUCCESS',
			updatedAt: at(18),
			head: 'feat/postal-codes',
			base: 'main',
			approvals: 1,
			mergeState: 'CLEAN',
			reviewDecision: 'APPROVED',
			additions: 10,
			deletions: 2,
			headSha: sha,
			body: '## What\nCheckout accepted only 5-digit US ZIP codes. It now checks the postal code against the format of the selected country.\n\n## How\n- `validate.ts` keeps one pattern per country: **US**, **CA**, **GB** and **DE**\n- unknown countries are not blocked\n\n## Testing\n- `pnpm vitest run apps/web/src/checkout`',
			reviews: [{ author: 'web-reviewer', state: 'APPROVED', body: 'Looks good.', at: at(20) }],
			threads: [
				{
					path: 'apps/web/src/checkout/validate.ts',
					line: 9,
					comments: [
						{
							author: 'web-reviewer',
							body: 'Should the UK pattern allow lowercase input?',
							at: at(40),
						},
						{ author: 'me', body: 'Yes, the `i` flag covers it.', at: at(30) },
					],
				},
			],
			files: [{ path: 'apps/web/src/checkout/validate.ts', additions: 10, deletions: 2 }],
			commitList: [
				{ sha, subject: 'checkout: validate postal codes per country', author: 'me', at: at(60) },
			],
			checkRuns: [
				{ name: 'build' },
				{ name: 'unit tests' },
				{ name: 'e2e: checkout' },
				{ name: 'lint' },
			],
		},
		{
			repo: 'acme-shop',
			number: 41,
			title: 'Search: rank exact name matches first',
			author: 'search-dev',
			requested: ['me'],
			comments: 4,
			checks: 'PENDING',
			updatedAt: at(55),
		},
		{
			repo: 'acme-shop',
			number: 39,
			title: 'Bump vitest to 4.1',
			author: 'dependabot',
			checks: 'FAILURE',
			updatedAt: at(60 * 26),
		},
		{
			repo: 'acme-shop',
			number: 37,
			title: 'Orders: export to CSV',
			author: 'me',
			state: 'MERGED',
			closedAt: at(60 * 24 * 2),
			updatedAt: at(60 * 24 * 2),
		},
	];
}

const storefront = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cart · Acme</title>
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f5f2;color:#1d1d1f}
header{display:flex;align-items:center;gap:24px;padding:14px 32px;background:#fff;border-bottom:1px solid #e5e2dc}
header b{font-size:18px;letter-spacing:-.01em}header nav{display:flex;gap:18px;color:#555}header .cart{margin-left:auto;font-weight:600}
main{display:grid;grid-template-columns:1fr 320px;gap:28px;max-width:1040px;margin:28px auto;padding:0 32px}
h1{font-size:26px;margin:0 0 16px}.line{display:flex;gap:16px;align-items:center;background:#fff;border-radius:12px;padding:14px;margin-bottom:12px;border:1px solid #ebe8e2}
.thumb{width:64px;height:64px;border-radius:10px;flex:none}.line .name{font-weight:600}.line .meta{color:#777;font-size:13px}.line .price{margin-left:auto;font-weight:600}
aside{background:#fff;border-radius:14px;padding:20px;border:1px solid #ebe8e2;align-self:start}aside h2{margin:0 0 4px;font-size:18px}aside p{margin:0 0 14px;color:#777}
dl{display:grid;grid-template-columns:1fr auto;gap:8px 12px;margin:0 0 18px}dd{margin:0;text-align:right}.neg{color:#1a7f37}.total{font-weight:700;font-size:17px;border-top:1px solid #eee;padding-top:10px}
button{width:100%;border:0;border-radius:10px;padding:12px;font:600 15px system-ui;background:#1d1d1f;color:#fff}
.coupon{display:flex;gap:8px;margin-bottom:14px}.coupon input{flex:1;padding:9px 10px;border:1px solid #ddd;border-radius:8px;font:inherit}
@media (max-width:720px){header{padding:12px 16px}header nav{display:none}main{grid-template-columns:1fr;gap:16px;margin:16px auto;padding:0 16px}h1{font-size:22px}}
</style>
<header><b>acme</b><nav><span>Kitchen</span><span>Home</span><span>Outdoor</span><span>Sale</span></nav><span class="cart">Cart (4)</span></header>
<main><section><h1>Your cart</h1>
<div class="line"><div class="thumb" style="background:linear-gradient(135deg,#f2b84b,#e07a3f)"></div><div><div class="name">Enamel mug</div><div class="meta">Mustard · 350 ml</div></div><div class="price">2 × $18.00</div></div>
<div class="line"><div class="thumb" style="background:linear-gradient(135deg,#7aa6c2,#3d6f8e)"></div><div><div class="name">Linen tea towel</div><div class="meta">Harbor blue</div></div><div class="price">$12.50</div></div>
<div class="line"><div class="thumb" style="background:linear-gradient(135deg,#9bbf8a,#4f7a46)"></div><div><div class="name">Olive wood board</div><div class="meta">Medium</div></div><div class="price">$24.00</div></div>
</section>
<aside><h2>Summary</h2><p>4 items</p><div class="coupon"><input value="SAVE10" aria-label="Coupon"></div>
<dl><dt>Subtotal</dt><dd>$72.50</dd><dt>Discount</dt><dd class="neg">-$7.25</dd><dt>Tax</dt><dd>$5.22</dd><dt>Shipping</dt><dd>Free</dd><dt class="total">Total</dt><dd class="total">$70.47</dd></dl>
<button>Checkout</button></aside></main>`;

// ---------------------------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------------------------

test.beforeAll(async () => {
	test.setTimeout(180_000);
	await stage();
});
test.afterAll(async () => {
	workspace?.server.close();
	// Deleting the folder also stops the fixture task hosts (their orphan check).
	if (workspace)
		await rm(workspace.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Opens the hero task with the chat, the diff of cart.ts in the work area and Changes in the panel. */
async function openHero(page: Page) {
	await openTask(page, 'Add cart totals');
	await showChat(page);
	await openPanelTab(page, 'changes');
	await page
		.getByRole('list', { name: 'Files', exact: true })
		.getByRole('button', { name: /cart\.ts/ })
		.first()
		.click();
	await expect(page.getByRole('log', { name: 'Diff', exact: true })).toContainText('cartTotals');
}

test('hero', async () => {
	test.setTimeout(120_000);
	for (const theme of ['dark', 'light'] as const) {
		const { app, page } = await launch({ theme });
		try {
			await openHero(page);
			await page.mouse.move(width / 2, height - 4);
			console.log(`hero-${theme}`, await shot(page, `hero-${theme}`));
		} finally {
			await quit(app);
		}
	}
});

test('crew', async () => {
	test.setTimeout(120_000);
	const { app, page } = await launch();
	try {
		// A smaller window: the foreman's chat is one column and would leave most of a wide window empty.
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1240, 860)
		);
		await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1240);
		await openTask(page, 'One-page checkout');
		await showChat(page);
		await expect(page.locator('aside [data-crew-card]').first()).toBeVisible();
		await page.locator('[data-plan-summary] > summary').first().click();
		await page.mouse.move(620, 856);
		console.log('crew', await shot(page, 'crew'));
	} finally {
		await quit(app);
	}
});

test('editor', async () => {
	test.setTimeout(120_000);
	const { app, page } = await launch();
	try {
		await openTask(page, 'Add cart totals');
		await hideChat(page);
		await openPanelTab(page, 'changes');
		const files = page.getByRole('list', { name: 'Files', exact: true });
		for (const name of [/CartSummary\.tsx/, /cart\.ts/]) {
			await files.getByRole('button', { name }).first().click();
			await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
			await expect(page.getByRole('textbox', { name: 'File content' }).first()).toBeVisible();
		}
		await page.locator('[data-panel-tab=files]').click();
		const tree = page.getByRole('tree').first();
		for (const name of ['apps', 'web', 'src', 'cart']) {
			const item = tree.getByRole('treeitem', { name, exact: true }).first();
			if ((await item.getAttribute('aria-expanded')) !== 'true') await item.press('ArrowRight');
			await expect(item).toHaveAttribute('aria-expanded', 'true');
		}
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await page.mouse.move(width / 2, height - 4);
		console.log('editor', await shot(page, 'editor'));
	} finally {
		await quit(app);
	}
});

test('browser', async () => {
	test.setTimeout(120_000);
	const { app, page } = await launch();
	try {
		await openTask(page, 'Add cart totals');
		await showChat(page);
		await hidePanel(page);
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Browser')!
				.click()
		);
		const panel = page.getByRole('region', { name: 'Browser', exact: true }),
			address = panel.getByRole('textbox', { name: 'Address' });
		await address.fill(workspace.url);
		await address.press('Enter');
		await expect
			.poll(() =>
				page.evaluate((key) => window.brigadir.browserCommand(key, { kind: 'state' }), hero)
			)
			.toMatchObject({ title: 'Cart · Acme', loading: false });
		await panel.getByRole('radio', { name: 'Mobile', exact: true }).click();
		await page.mouse.move(width / 2, height - 4);
		await Promise.race([settle(page), new Promise((done) => setTimeout(done, 3000))]);
		// The page is a native view over the window: capture it on its own and draw it where it sits.
		const base = (await page.screenshot({ animations: 'disabled' })).toString('base64');
		const view = await app.evaluate(async ({ BrowserWindow }) => {
			const child = BrowserWindow.getAllWindows()[0]!.contentView
				.children[0] as Electron.WebContentsView;
			const image = await child.webContents.capturePage();
			return { png: image.toPNG().toString('base64'), bounds: child.getBounds() };
		});
		const composite = await page.evaluate(
			async ({ base, view }) => {
				const load = (data: string) =>
					new Promise<HTMLImageElement>((done, fail) => {
						const image = new Image();
						image.onload = () => done(image);
						image.onerror = fail;
						image.src = 'data:image/png;base64,' + data;
					});
				const [back, front] = await Promise.all([load(base), load(view.png)]);
				const canvas = document.createElement('canvas');
				canvas.width = back.width;
				canvas.height = back.height;
				const context = canvas.getContext('2d')!,
					scale = back.width / window.innerWidth;
				context.drawImage(back, 0, 0);
				context.drawImage(
					front,
					view.bounds.x * scale,
					view.bounds.y * scale,
					view.bounds.width * scale,
					view.bounds.height * scale
				);
				return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
			},
			{ base, view }
		);
		console.log('browser', await shot(page, 'browser', { png: Buffer.from(composite, 'base64') }));
	} finally {
		await quit(app);
	}
});

test('pull request', async () => {
	test.setTimeout(120_000);
	const { app, page } = await launch();
	try {
		await openTask(page, 'Add cart totals');
		await hideChat(page);
		await openPanelTab(page, 'prs');
		await page.locator('[data-pr-row="42"]').click();
		await page.getByRole('button', { name: 'Overview', exact: true }).click();
		await expect(page.locator('[data-pr-overview="42"]')).toContainText('postal code');
		await page.mouse.move(width / 2, height - 4);
		console.log('pull-request', await shot(page, 'pull-request'));
	} finally {
		await quit(app);
	}
});

/** The diff with review comments beside the lines, the chat hidden so the diff has the room. */
test('review', async () => {
	test.setTimeout(120_000);
	const { app, page } = await launch();
	try {
		await openTask(page, 'Add cart totals');
		await page.evaluate(
			async ({ key, lines }) => {
				const changes = await window.brigadir.readChanges(key);
				const file = (path: string) => changes.files.find((entry) => entry.path.endsWith(path))!;
				const cart = file('apps/web/src/cart/cart.ts'),
					summary = file('CartSummary.tsx');
				await window.brigadir.addComment(key, {
					fileId: cart.id,
					side: 'new',
					start: lines.shipping,
					end: lines.shipping,
					text: 'Free shipping should count the subtotal before the coupon, as the product page promises "free shipping from $50".',
				});
				await window.brigadir.addComment(key, {
					fileId: cart.id,
					side: 'new',
					start: lines.tax,
					end: lines.tax,
					text: 'Read the tax rate from the store settings instead of a constant.',
				});
				await window.brigadir.addComment(key, {
					fileId: summary.id,
					side: 'new',
					start: 1,
					end: 1,
					text: 'Keep the UI kit import last, as in the rest of the app.',
				});
				await window.brigadir.addReviewNote(key, 'Run the cart tests again after the changes.');
			},
			{
				key: hero,
				lines: {
					shipping: cartAfter.split('\n').findIndex((line) => line.includes('const shipping')) + 1,
					tax:
						cartAfter.split('\n').findIndex((line) => line.includes('export const TAX_RATE')) + 1,
				},
			}
		);
		await hideChat(page);
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /cart\.ts/ })
			.first()
			.click();
		const diff = page.getByRole('log', { name: 'Diff', exact: true });
		await expect(diff).toContainText('Free shipping should count');
		await diff.getByText('Free shipping should count').scrollIntoViewIfNeeded();
		await page.mouse.move(width / 2, height - 4);
		console.log('review', await shot(page, 'review'));
	} finally {
		await quit(app);
	}
});

async function settingsTab(app: ElectronApplication, page: Page, tab: string) {
	const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
	if (!(await dialog.isVisible())) await menuClick(app, 'settings');
	await dialog.getByRole('tab', { name: tab, exact: true }).click();
	await page.mouse.move(2, height - 2);
	await Promise.race([settle(page), new Promise((done) => setTimeout(done, 3000))]);
	const box = (await dialog.boundingBox())!,
		pad = 0;
	return {
		dialog,
		clip: {
			x: Math.max(0, box.x - pad),
			y: Math.max(0, box.y - pad),
			width: Math.min(width, box.width + pad * 2),
			height: Math.min(height - Math.max(0, box.y - pad), box.height + pad * 2),
		},
	};
}

test('settings', async () => {
	test.setTimeout(120_000);
	const { app, page } = await launch();
	try {
		await openTask(page, 'Add cart totals');
		const modules = await settingsTab(app, page, 'Modules');
		console.log('settings-modules', await shot(page, 'settings-modules', { clip: modules.clip }));
		const language = await settingsTab(app, page, 'Language');
		const panel = language.dialog.getByRole('tabpanel');
		await expect(panel).toContainText('Updates');
		// Does the Updates card fit the fixed-height tab without clipping or a scroll?
		const fit = await panel.evaluate((node) => {
			const out: string[] = [],
				limit = node.getBoundingClientRect();
			for (const element of [node, ...node.querySelectorAll('*')] as HTMLElement[]) {
				if (
					element.scrollHeight > element.clientHeight + 1 &&
					getComputedStyle(element).overflowY !== 'visible'
				)
					out.push(
						`scroll ${element.tagName}.${element.className} ${element.scrollHeight}>${element.clientHeight}`
					);
				const box = element.getBoundingClientRect();
				if (box.height && box.bottom > limit.bottom + 1)
					out.push(`below ${element.tagName} ${element.textContent?.slice(0, 40)}`);
			}
			return out;
		});
		console.log('updates-fit', JSON.stringify(fit));
		console.log(
			'settings-language',
			await shot(page, 'settings-language', { clip: language.clip })
		);
	} finally {
		await quit(app);
	}
});
