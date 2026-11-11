import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;

test('reads v2, isolates the renderer, updates theme, and opens Kit @area:shell @smoke', async ({}, testInfo) => {
	const directory = await mkdtemp(join(tmpdir(), 'brigadir-desktop-'));
	const projectDir = join(directory, 'data/projects/acme');
	const taskDir = join(projectDir, 'tasks/task-1');
	await mkdir(taskDir, { recursive: true });
	const project = JSON.stringify({
		schemaVersion: 1,
		project: { id: 'acme', name: 'acme', path: directory },
	});
	await writeFile(join(projectDir, 'project.json'), project);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task-1',
				projectId: 'acme',
				title: 'Build the Electron app',
				status: 'working',
			},
		})
	);
	const otherDir = join(directory, 'data/projects/second/tasks/task-1');
	await mkdir(otherDir, { recursive: true });
	await writeFile(
		join(otherDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'second', name: 'second', path: directory } })
	);
	await writeFile(
		join(otherDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { id: 'task-1', projectId: 'second', title: 'Another project task', status: 'done' },
		})
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const application = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(directory, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(directory, 'data') },
	});
	try {
		const page = await application.firstWindow();
		await expect
			.poll(() =>
				application.evaluate(({ BrowserWindow, screen }) => {
					const window = BrowserWindow.getAllWindows()[0]!;
					const second = screen
						.getAllDisplays()
						.find((display) => display.id !== screen.getPrimaryDisplay().id);
					const bounds = window.getBounds();
					return {
						focused: window.isFocused(),
						focusable: window.isFocusable(),
						placed: second
							? screen.getDisplayMatching(bounds).id === second.id &&
								bounds.x >= second.workArea.x &&
								bounds.y >= second.workArea.y
							: !window.isVisible(),
					};
				})
			)
			.toEqual({ focused: false, focusable: false, placed: true });
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await expect(
			page.locator('aside').getByRole('heading', { name: 'acme', exact: true })
		).toBeVisible();
		// New Task is a modal sheet. Opening/cancelling it must keep the task view
		// and its selection, and the provider menu must not dismiss the sheet.
		const newTask = page.getByRole('button', { name: 'New task · acme', exact: true });
		await newTask.click();
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByRole('textbox', { name: 'Message' })).toBeFocused();
		await sheet
			.getByRole('textbox', { name: 'Message' })
			.fill('Fix the focus ring on the Button in Safari.');
		await sheet.getByRole('button', { name: 'Agent', exact: true }).click();
		await sheet.getByRole('option', { name: 'Codex', exact: true }).click();
		await expect(sheet.getByRole('button', { name: 'Agent', exact: true })).toHaveText('Codex');
		await sheet.getByRole('radio', { name: 'CLI', exact: true }).click();
		await expect(sheet.getByRole('radio', { name: 'CLI', exact: true })).toBeChecked();
		await sheet.getByRole('textbox', { name: 'Message' }).focus();
		await application.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.screenshot({
			animations: 'disabled',
			path: testInfo.outputPath('launch-light.png'),
		});
		await application.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'dark';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('launch-dark.png') });
		await page.keyboard.press('Escape');
		await expect(sheet).toHaveCount(0);
		await expect(newTask).toBeFocused();
		await application.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		await page.getByRole('button', { name: /Build the Electron app/ }).click();
		await expect(
			page.getByRole('heading', { name: 'Build the Electron app', exact: true })
		).toBeVisible();
		await page.getByRole('button', { name: /Another project task/ }).click();
		await expect(
			page.getByRole('heading', { name: 'Another project task', exact: true })
		).toBeVisible();
		await expect(
			page
				.getByRole('complementary', { name: 'Projects', exact: true })
				.getByRole('button', { pressed: true })
		).toHaveCount(1);
		await page.getByRole('button', { name: /Build the Electron app/ }).click();
		expect(
			await page.evaluate(() => ({
				node: typeof (window as unknown as { require?: unknown }).require,
				bridge: Object.keys(window.brigadir).sort(),
			}))
		).toEqual({
			node: 'undefined',
			bridge: [
				'readCIRun',
				'readCIRuns',
				'readCIWatches',
				'watchCIRun',
				'onCIWatches',
				'onCIFinished',
				'onCIOpen',
				'readQuota',
				'refreshQuota',
				'onQuotaChanged',
				'watchQuota',
				'readSessionActivity',
				'changeCode',
				'closeCode',
				'completeCode',
				'definitionCode',
				'hoverCode',
				'onCodeProblems',
				'formatCode',
				'formatInfoCode',
				'indentInfoCode',
				'restartCode',
				'onCodeRestarted',
				'readFormatters',
				'setProjectFormatter',
				'openCode',
				'referencesCode',
				'resolveCompletion',
				'signatureCode',
				'renameTask',
				'readLiveAgents',
				'controlLiveAgent',
				'readSidebarState',
				'collapseProject',
				'readCollapsedCrews',
				'collapseCrew',
				'readCollapsedCompleted',
				'collapseCompleted',
				'readSelection',
				'saveSelection',
				'readKnowledge',
				'prepareKnowledge',
				'generateKnowledge',
				'cancelKnowledge',
				'rejectKnowledge',
				'restoreKnowledge',
				'addKnowledge',
				'undoKnowledge',
				'dismissKnowledge',
				'readKnowledgeFile',
				'requestGhost',
				'cancelGhost',
				'readForge',
				'preparePush',
				'pushChanges',
				'preparePullRequest',
				'checkPullRequest',
				'createPullRequest',
				'generatePullRequest',
				'discardForgeDraft',
				'hidePullRequestSuggestion',
				'readPullRequest',
				'openPullRequest',
				'createScopeBranch',
				'readCommits',
				'commitChanges',
				'generateCommitMessage',
				'commitBaskets',
				'onCommitProgress',
				'generateBasketMessage',
				'splitCommits',
				'stopCommitSplit',
				'readCommitFile',
				'openCommitFile',
				'prepareRelay',
				'stopRelaySummary',
				'summarizeRelay',
				'discardRelay',
				'createRelayTask',
				'readScopePanel',
				'updateScope',
				'collapseScopes',
				'readLaunchConflict',
				'resolveLaunchConflict',
				'onLaunchConflict',
				'readScopeLocks',
				'readPreparationLog',
				'readLaunchSettings',
				'readTemplates',
				'saveAgentTemplate',
				'saveCrewTemplate',
				'deleteTemplate',
				'deleteTreeFile',
				'restoreCrewTemplates',
				'exportTemplate',
				'importTemplate',
				'readProviderCatalog',
				'readProjectViews',
				'saveProjectView',
				'readProjectModes',
				'saveProjectMode',
				'moveTask',
				'taskOptionMenu',
				'deleteCompletedTask',
				'clearCompletedTasks',
				'editBacklogTask',
				'updateMenuContext',
				'readSettings',
				'saveActionAgent',
				'saveActionCrew',
				'saveSettings',
				'restartApp',
				'readSounds',
				'previewSound',
				'openNotificationSettings',
				'readNotificationPermission',
				'requestNotificationPermission',
				'onNotificationPermission',
				'setVisibleTask',
				'onProjectOpen',
				'onNotificationOpen',
				'projectMenu',
				'taskMenu',
				'pickAttachments',
				'addComment',
				'addEditorComment',
				'readToolChange',
				'turnMenu',
				'readToolDiff',
				'readTurnChanges',
				'readSurfaceLayout',
				'saveSurfaceLayout',
				'readSurface',
				'writeSurface',
				'writeSurfaceDrafts',
				'onSurfaceFlush',
				'surfaceFlushed',
				'createAttachment',
				'pasteAttachment',
				'attachDroppedFiles',
				'readAttachment',
				'readAttachmentThumbnail',
				'openPlanFile',
				'readPlanFile',
				'openWebLink',
				'addProject',
				'setProjectIcon',
				'pickProjectIcon',
				'readProjectRepoIcons',
				'setProjectRepoIcon',
				'setProjectReviewNotes',
				'setProjectImageIcon',
				'readProjectImageIcon',
				'generateProjectIcon',
				'createTask',
				'editComment',
				'listFiles',
				'onAppearanceChanged',
				'onEditorAction',
				'onNavigate',
				'onSessionEvent',
				'openDiffFile',
				'prepareReview',
				'readAppearance',
				'readChanges',
				'readEditorFile',
				'createEditorFile',
				'readEditorBlame',
				'readBlameMessage',
				'checkEditorFile',
				'readEditorReview',
				'setShortcutRecording',
				'signInAgent',
				'readAgentLogin',
				'submitAgentLoginCode',
				'cancelAgentLogin',
				'reopenAgentLogin',
				'onAgentLogin',
				'checkEnvironment',
				'addDroppedProject',
				'readAttribution',
				'fileMenu',
				'copyText',
				'chatMenu',
				'checkCliUpdates',
				'readCliUpdates',
				'onCliUpdates',
				'readAppUpdate',
				'checkAppUpdate',
				'downloadAppUpdate',
				'installAppUpdate',
				'cancelAppUpdateRestart',
				'onAppUpdate',
				'readKeepAwake',
				'onKeepAwake',
				'copyAttachmentImage',
				'chromePlatform',
				'remoteMachine',
				'openAppMenu',
				'onAppMenu',
				'setChromeColors',
				'readComposer',
				'saveComposer',
				'attachFile',
				'openFileTerminal',
				'readTimeline',
				'selectChangeRange',
				'revertFile',
				'backgroundOutput',
				'testAttentionMs',
				'onBrowserEvent',
				'onBrowserShow',
				'onBrowserTab',
				'readBrowserLive',
				'onBrowserLive',
				'browserCommand',
				'onTerminalEvent',
				'terminalCommand',
				'editorMenu',
				'documentTabMenu',
				'readCommandRuns',
				'runProjectCommand',
				'readProjectScripts',
				'saveProjectCommands',
				'projectCommandMenu',
				'compareEditorFile',
				'addReviewNote',
				'adoptProposedTask',
				'addScopeFolder',
				// spec/notifications-slack-notes-and-schedules#notification-center: the notification center.
				'addToastNotice',
				'noticeCenterAction',
				'onNoticeCenter',
				'readNoticeCenter',
				// spec/notifications-slack-notes-and-schedules#notes: notes and their chats.
				'attachNote',
				'createNote',
				'deleteNote',
				'linkNoteTask',
				'listNotes',
				'noteMenu',
				'noteProjectMenu',
				'noteTaskProjectMenu',
				'onNoteChatEvent',
				'onNotesChanged',
				'readNote',
				'readNoteChat',
				'sendNoteChat',
				'setNoteProject',
				'stopNoteChat',
				'undoNoteEdit',
				'writeNote',
				// spec/notifications-slack-notes-and-schedules#schedules: scheduled tasks.
				'createSchedule',
				'deleteSchedule',
				'editSchedule',
				'listSchedules',
				'onSchedulesChanged',
				'readScheduleRuns',
				'resolveScheduleMissed',
				'runScheduleNow',
				'setSchedulePaused',
				'createProposedTask',
				'declineProposedTask',
				'draftProposedTask',
				'searchFiles',
				'onWorkspaceAction',
				'onReviewChanged',
				'readEditorSyntax',
				'readEditorGutter',
				'readFileDiff',
				'readFileSyntax',
				'readReview',
				'readReviewPositions',
				'readCodeSyntax',
				'readFileLinks',
				'readSession',
				'readWorkspace',
				'releaseEditorFile',
				'removeComment',
				'removeReviewSelection',
				'resolveComment',
				'readCommentFile',
				'saveEditorFile',
				'sendCommand',
				'setEditorDirty',
				'setMenuIcons',
				'startSession',
				'addProjectFolder',
				'searchProjectFiles',
				'readHistoryScopes',
				'readBranches',
				'readHistory',
				'readHistoryCommit',
				'readHistoryFile',
				'previewMerge',
				'startMerge',
				'readMergeState',
				'resolveConflict',
				'markConflictResolved',
				'finishMerge',
				'abortMerge',
				'askAgentToResolve',
				'stopConflictAgent',
				'readMergeStates',
				'readConflictTexts',
				'applyConflict',
				'reopenConflict',
				'readBaseRefs',
				'removeWorktree',
				'onSimulatorEvent',
				'onSimulatorFrame',
				'readSimulatorToolchain',
				'simulatorCommand',
				'readPullRequests',
				'readPullRequestDetail',
				'openPullRequestPage',
				'openPullRequestLink',
				'resolvePullRequestLink',
				'readClipboardText',
				'terminalMenu',
				'openMainTree',
				'readMainTreeBranch',
				'switchMainTreeBranch',
				'readBranchSwitch',
				'switchBranchTo',
				'createMainTreeBranch',
				'readStashes',
				'stashChanges',
				'restoreStash',
				'dropStash',
				'pullBranch',
				'undoLastCommit',
				'discardChanges',
				'preparePullRequestTrees',
				'readPullRequestFiles',
				'readPullRequestFileDiff',
				'findPullRequestDefinition',
				'readPullRequestReview',
				'readPullRequestReviewStates',
				'notePullRequestViewed',
				'pullRequestMenu',
				'addPullRequestDraft',
				'editPullRequestDraft',
				'removePullRequestDraft',
				'discussPullRequestDraft',
				'setPullRequestReview',
				'submitPullRequestReview',
				'commentPullRequestNow',
				'commentPullRequest',
				'resolvePullRequestThread',
				'markPullRequestFileViewed',
				'readPullRequestSummary',
				'generatePullRequestSummary',
				'stopPullRequestSummary',
				'acceptPullRequestDraft',
				'writePullRequestReviewBody',
				'suggestPullRequestVerdict',
				'askPullRequestAgent',
				'startPullRequestAgent',
				'mergePullRequest',
				'resolvePullRequestConflicts',
				'readyPullRequest',
				'reportRendererError',
				'reloadWindow',
				'testCrash',
				'answerContextRequest',
				'onContextRequest',
				'readSlashCatalog',
				'dispatchWorkspaceAction',
				'readMarkdownDescription',
				'sheetAttachMenu',
				'discardAttachmentDraft',
				'searchText',
				'cancelTextSearch',
				'peekFile',
				'readTextSearchRepos',
				'onTextSearch',
				'runMenuCommand',
				'attachTaskSummary',
				'readAttachmentInfo',
				'askQuickQuestion',
				'askQuickFollowUp',
				'stopQuickQuestion',
				'closeQuickQuestion',
				'answerQuickPermission',
				'revertQuickChange',
				'onQuickAskEvent',
				'archiveTask',
				'archiveCompletedTasks',
				'deleteArchivedTasks',
				'openArchiveSection',
				'readArchiveSections',
				'restoreTasks',
				// spec/remote-access-and-mobile#pairing: remote access.
				'readRemoteAccess',
				'setRemoteAccess',
				'setRemotePassword',
				'renameRemoteMachine',
				'revokeRemoteDevice',
				'revokeAllRemoteDevices',
				'unblockRemoteDevice',
				'startRemotePairing',
				'stopRemotePairing',
				'confirmRemotePairing',
				'readRemoteAudit',
				'readRemoteKeyStore',
				'takeRemoteControl',
				'onRemoteStatus',
				'onRemoteControl',
				'onRemoteNotice',
				'readRemoteMachines',
				'browseRemoteMachines',
				'pairRemoteMachine',
				'forgetRemoteMachine',
				'connectRemoteMachine',
				'disconnectRemoteMachine',
				'readRemoteSessions',
				'onRemoteSessions',
				'onRemoteFound',
				'answerRemoteUi',
				'listRemoteFolder',
				'createRemoteFolder',
				'actOnRemoteNotice',
				'onRemoteMenu',
				'onRemoteDialog',
				'onRemoteSave',
				'onRemoteNotify',
				'onRemoteAppearance',
				'readMachineAppearance',
				'readPullRequestPageUrl',
				'readPullRequestLinkUrl',
				'readPullRequestUrl',
				'uploadAttachment',
				'disconnectRemoteDevice',
				'revealRemoteAudit',
				// spec/remote-access-and-mobile#phone-network: the phone's web listener.
				'setRemotePhone',
				'checkRemotePhone',
				'cancelPairRemoteMachine',
				'onRemotePairProgress',
				// spec/remote-access-and-mobile#browser-from-device: the browser and the simulator from a device.
				'browserScreen',
				'onBrowserScreen',
				'uploadPageFile',
				'onRemoteFiles',
				'closingRemoteWindow',
				// spec/remote-access-and-mobile#networking: availability before connecting, an agent sign-in's way back from a device.
				'onRemoteReach',
				'openAgentSignIn',
				'relayAgentLogin',
				// spec/remote-access-and-mobile#remote-button: «Go to» from the chip's menu in another machine's window.
				'showRemoteWindow',
				'onRemoteOpen',
				'readSlack',
				'retrySlack',
				'connectSlack',
				'moveSlackToKeychain',
				'disconnectSlack',
				'connectSlackApp',
				'disconnectSlackApp',
				'onSlack',
			].sort(),
		});
		await application.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'dark';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.screenshot({
			animations: 'disabled',
			path: testInfo.outputPath('workspace-dark.png'),
		});
		const composer = page.getByRole('textbox', { name: 'Message', exact: true });
		await composer.fill('Keep this unsent task draft.');
		await newTask.click();
		await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(composer).toHaveText('Keep this unsent task draft.');
		await composer.fill('');
		await page.evaluate(() => {
			location.hash = 'kit';
		});
		await expect(page.getByRole('heading', { name: 'Control kit', exact: true })).toBeVisible();
		const toggle = page.getByRole('switch', { name: 'Notifications', exact: true });
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		const popup = page.locator('button[aria-haspopup="listbox"]').first();
		await popup.focus();
		await popup.press('ArrowDown');
		await expect(page.getByRole('listbox')).toBeVisible();
		for (const theme of ['light', 'dark'] as const) {
			await application.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.getByRole('listbox').screenshot({
				animations: 'disabled',
				path: testInfo.outputPath(`popup-menu-${theme}.png`),
			});
		}
		await page.getByRole('listbox').press('Home');
		await page.getByRole('listbox').press('Enter');
		await expect(popup).toHaveText('Crew');
		await expect(popup).toBeFocused();
		await popup.click();
		await page.getByRole('listbox').press('Escape');
		await expect(page.getByRole('listbox')).toHaveCount(0);
		const manual = page.getByRole('radio', { name: 'Manual', exact: true });
		await page.getByRole('radio', { name: 'Automatic', exact: true }).focus();
		await page.keyboard.press('ArrowRight');
		await expect(manual).toBeChecked();
		await expect(manual).toBeFocused();
		await page.getByRole('button', { name: 'Increase', exact: true }).click();
		await expect(page.getByRole('spinbutton', { name: 'Stepper' })).toHaveValue('4');
		await page.getByRole('spinbutton', { name: 'Stepper' }).fill('99');
		await page.getByRole('spinbutton', { name: 'Stepper' }).press('Enter');
		await expect(page.getByRole('button', { name: 'Increase', exact: true })).toBeDisabled();
		await page.getByRole('checkbox', { name: 'Unchecked', exact: true }).check();
		await expect(page.getByRole('checkbox', { name: 'Unchecked', exact: true })).toBeChecked();
		await page.getByRole('radio', { name: 'First option', exact: true }).check();
		await expect(page.getByRole('radio', { name: 'Second option', exact: true })).not.toBeChecked();
		// spec/appearance#component-details: the Kit opens the real ModalDialog, not a copy of a sheet.
		const sheetOpen = page.locator('[data-kit-sheet]').first();
		await sheetOpen.click();
		await expect(page.getByRole('dialog')).toBeVisible();
		// Rule 14: the sheet's header carries the shared Esc.
		await expect(
			page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })
		).toHaveText('Esc');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(sheetOpen).toBeFocused();
		await application.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setSize(1288, 1280)
		);
		await page.getByRole('main').evaluate((element) => {
			element.scrollTop = 0;
		});
		await page.evaluate(() => {
			location.hash = 'workspace';
		});
		await expect(
			page.getByRole('heading', { name: 'Build the Electron app', exact: true })
		).toBeVisible();
		await page.evaluate(() => {
			location.hash = 'kit';
		});
		await expect(page.getByRole('heading', { name: 'Control kit' })).toBeVisible();
		const systemAccent = await application.evaluate(({ systemPreferences }) =>
			systemPreferences.getAccentColor()
		);
		// Main always publishes a full Appearance; the renderer reads every field of it (spec/editor-code-intelligence#typing-help `editing`).
		const baseAppearance = await page.evaluate(() => window.brigadir.readAppearance());
		const publishAppearance = (patch: Partial<typeof baseAppearance>) => {
			const value = { ...baseAppearance, ...patch };
			return application
				.evaluate(
					({ BrowserWindow }, value) =>
						BrowserWindow.getAllWindows()[0]!.webContents.send('appearance:changed', value),
					value
				)
				.then(() => value);
		};
		await publishAppearance({ dark: true, accent: systemAccent, locale: 'uk' });
		await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
		await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('kit-dark.png') });
		await application.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await publishAppearance({ dark: false, accent: systemAccent, locale: 'uk' });
		await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
		await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('kit-light.png') });
		const box = async (locator: ReturnType<typeof page.locator>) => (await locator.boundingBox())!;
		const dimensions = {
			// The page is Ukrainian by now.
			toggle: await box(page.getByRole('switch', { name: /^(Notifications|Сповіщення)$/ })),
			popup: await box(page.locator('[aria-haspopup="listbox"]').first()),
			checkbox: await box(page.getByRole('checkbox', { name: /^(Unchecked|Не вибрано)$/ })),
		};
		// spec/appearance#control-scale: the Kit shows size M: switch 34 × 20 inside a 46 × 28 target, popup 28, checkbox 16.
		expect([dimensions.toggle.width, dimensions.toggle.height]).toEqual([46, 28]);
		expect(dimensions.popup.height).toBe(28);
		expect([dimensions.checkbox.width, dimensions.checkbox.height]).toEqual([16, 16]);
		// Events stay inside preload; unsubscribe removes precisely this listener.
		await page.evaluate(() => {
			const state = { count: 0, keys: [] as string[], stop: () => {} };
			state.stop = window.brigadir.onAppearanceChanged((value) => {
				state.count++;
				state.keys = Object.keys(value).sort();
			});
			(window as unknown as { appearanceProbe: typeof state }).appearanceProbe = state;
		});
		const sent = await publishAppearance({ dark: false, accent: 'ff6600ff', locale: 'en' });
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as unknown as { appearanceProbe: { count: number } }).appearanceProbe.count
				)
			)
			.toBe(1);
		expect(
			await page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue('--accent')
			)
		).toBe('#ff6600');
		expect(
			await page.evaluate(
				() => (window as unknown as { appearanceProbe: { keys: string[] } }).appearanceProbe.keys
			)
		).toEqual(Object.keys(sent).sort());
		await page.evaluate(() =>
			(window as unknown as { appearanceProbe: { stop(): void } }).appearanceProbe.stop()
		);
		await publishAppearance({ dark: false, accent: '00cc66ff', locale: 'en' });
		await expect
			.poll(() =>
				page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'))
			)
			.toBe('#00cc66');
		expect(
			await page.evaluate(
				() => (window as unknown as { appearanceProbe: { count: number } }).appearanceProbe.count
			)
		).toBe(1);
		// Exercise the actual native notification path without changing the user's system preferences.
		const nativeAccent = await application.evaluate(({ systemPreferences }) => {
			systemPreferences.emit('accent-color-changed', {}, systemPreferences.getAccentColor());
			return systemPreferences.getAccentColor();
		});
		await expect
			.poll(() =>
				page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'))
			)
			.toBe(`#${nativeAccent.slice(0, 6)}`);
		// Reach the real registered handlers with real Electron frame objects, including a child frame.
		await page.evaluate(() => {
			const frame = document.createElement('iframe');
			frame.srcdoc = '<p>Untrusted frame</p>';
			document.body.append(frame);
		});
		await expect.poll(() => page.frames().length).toBe(2);
		const rejections = await application.evaluate(async ({ BrowserWindow, ipcMain }) => {
			const sender = BrowserWindow.getAllWindows()[0]!.webContents;
			const handlers = (
				ipcMain as unknown as {
					_invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
				}
			)._invokeHandlers;
			const invoke = handlers.get('workspace:read')!;
			const reject = async (frame: unknown, args: unknown[]) => {
				try {
					await invoke({ sender, senderFrame: frame }, ...args);
					return false;
				} catch {
					return true;
				}
			};
			return [
				await reject(sender.mainFrame, ['/etc/passwd']),
				await reject(sender.mainFrame.frames[0], []),
				await reject(null, []),
			];
		});
		expect(rejections).toEqual([true, true, true]);
		await page.locator('iframe').evaluate((element) => element.remove());
		// A second window making a genuine ipcRenderer.invoke cannot borrow the app bridge.
		const hostilePreload = join(directory, 'hostile.cjs');
		await writeFile(
			hostilePreload,
			`const { ipcRenderer, contextBridge } = require('electron'); contextBridge.exposeInMainWorld('probe', { read: () => ipcRenderer.invoke('workspace:read').then(() => 'allowed', () => 'denied') });`
		);
		const hostileId = await application.evaluate(async ({ BrowserWindow }, preload) => {
			const w = new BrowserWindow({
				show: false,
				webPreferences: { preload, sandbox: true, contextIsolation: true },
			});
			await w.loadURL('data:text/html,<h1>Foreign window</h1>');
			return w.id;
		}, hostilePreload);
		const foreignResult = await application.evaluate(async ({ BrowserWindow }, id) => {
			const w = BrowserWindow.fromId(id)!;
			const result = await w.webContents.executeJavaScript('window.probe.read()');
			w.destroy();
			return result;
		}, hostileId);
		expect(foreignResult).toBe('denied');
		expect(errors).toEqual([]);
		expect(await readFile(join(projectDir, 'project.json'), 'utf8')).toBe(project);
	} finally {
		await application.close();
		await rm(directory, { recursive: true, force: true });
	}
});
/** About twenty surfaces listen to workspace:action; one ipcRenderer listener each would trip Node's
 * MaxListenersExceededWarning. The preload fans one listener out to every subscriber, and menu actions still reach them. */
test('switching tasks with the browser and console open adds no IPC listener warnings @area:shell', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-listeners-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		projectDir = join(data, 'projects/project');
	await mkdir(repo);
	for (const id of ['one', 'two']) {
		await mkdir(join(projectDir, `tasks/${id}`), { recursive: true });
		await writeFile(
			join(projectDir, `tasks/${id}/task.json`),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id,
					projectId: 'project',
					title: `Task ${id}`,
					provider: 'claude',
					status: 'queued',
				},
			})
		);
	}
	await writeFile(
		join(projectDir, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'Project', path: repo } })
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	const warnings: string[] = [],
		note = (text: string) => {
			if (/MaxListenersExceeded|memory leak detected/i.test(text)) warnings.push(text);
		};
	app.process().stderr?.on('data', (chunk) => note(String(chunk)));
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (message) => note(message.text()));
		const menu = (id: string) =>
			app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id);
		const open = async (title: string) => {
			await page
				.locator('aside')
				.getByRole('button', { name: new RegExp(title) })
				.first()
				.click();
			await expect(page.locator('section[class*=_task_]')).toBeVisible();
		};
		await open('Task one');
		await menu('browser');
		await expect(page.locator('[data-browser]')).toBeVisible();
		await menu('terminal');
		await expect(page.locator('.xterm')).toBeVisible();
		for (let round = 0; round < 4; round++) {
			await open('Task two');
			await open('Task one');
		}
		await open('Task two');
		await menu('browser');
		await expect(page.locator('[data-browser]')).toBeVisible();
		await menu('terminal');
		await expect(page.locator('.xterm')).toBeVisible();
		// Every subscriber still hears the one fanned-out listener: the menu's Work area switch hides the terminal (spec/task-window-workspace#layout-switch).
		await menu('layout-work');
		await expect(page.locator('.xterm')).toHaveCount(0);
		await page.waitForTimeout(500);
		expect(warnings).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
