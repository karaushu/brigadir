import { defineConfig } from '@playwright/test';
// These tests share a desktop with the developer. Never claim keyboard focus.
process.env.BRIGADIR_BACKGROUND = '1';
process.env.BRIGADIR_DISPLAY = 'secondary';
// spec/settings-modules-and-onboarding#intro: a fresh data dir would open the intro over every test; tests/intro.spec.ts turns it back on.
process.env.BRIGADIR_SKIP_INTRO = '1';
// spec/git#pull: no background fetch in e2e; a spec that needs it sets BRIGADIR_REMOTE_WATCH=1 for its app.
process.env.BRIGADIR_REMOTE_WATCH = '0';
// spec/appearance#evolution-redesign: no agent pick of project icons in e2e; tests/project-icon.spec.ts sets BRIGADIR_ICON_PICK=1 for its app.
process.env.BRIGADIR_ICON_PICK = '0';
export default defineConfig({
	testDir: './tests',
	workers: Number(process.env.BRIGADIR_E2E_WORKERS || 3),
	timeout: 30_000,
	// Quiet by default: a dot per test, details only for failures. `--reporter=line` overrides.
	reporter: [['dot']],
	use: { trace: 'retain-on-failure' },
});
