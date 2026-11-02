# Brigadir specification

Brigadir is a cross-platform Electron app for orchestrating coding agents. This spec describes what the product does
today, one file per area. Start with [Overview](overview.md).

## Core

- [Overview](overview.md): product identity, the reference monorepo case, scope, non-goals, borrowings from Unpeel,
  delegated design decisions, open questions, items that need empirical checks and cross-cutting acceptance audits.
- [Projects and board](projects-and-board.md): projects as sets of git roots (monorepo scope, repo selection, custom
  and external folders, read-only scope, project knowledge, project icon) and the project screen with the task board,
  the all-projects board and PR mode.
- [Tasks](tasks.md): task model and states, launch sheet and fast start, isolation and worktree preparation, locks and
  conflicts, backlog, relay to a new task, live agents popup, worktree cleanup, archive, agent-created tasks and quick
  tasks from the main tree.
- [Sidebar](sidebar.md): layout, project frames and task cards, state icons and the unread dot, status bar chips,
  repo/scope section, filters, done-task rows, crew card rows, width, section rail and opening the last task.

## Task window

- [Task window](task-window.md): title strip and toolbar, two and three columns, side column and right part toggles,
  Files tree and file panel, surface state owned by the task, narrow-window behaviour and width rules.
- [Workspace and layouts](task-window-workspace.md): the workspace that groups terminal, browser and simulator as tabs,
  the layout switcher and panel tabs, reopening the window as it was closed, hiding an empty workspace and the chat as
  a pinned workspace tab.
- [Chat](chat.md): the activity view: shared row engine, activity rows and collapse rules, subagents, tool call rows
  and groups, MCP call rows, links and file links, code blocks, images in replies, context menu, scroll and navigation.
- [Turns, plans and questions](chat-turns-plans-and-questions.md): turn rail and scrollbar band, turn status row, turn
  footer chips, agent-started turns, background tasks deck, plan approval, Codex `update_plan`, plan checklist and
  agent questions.
- [Composer](composer.md): the composer island: options and chips, environment footer and agent capsule, attachments
  shelf, paste and drag, `@` mentions and folders, `/` commands anywhere and their highlighting, rich formatted input,
  editor selection to chat, drafts and focus.
- [Steering, queue and ghost](composer-steering-queue-and-ghost.md): sending mid-turn (steering, the host holding a
  message to a step boundary), the persistent prompt queue deck, ghost next-prompt suggestions and their model, and the
  quick question popover under a selection.

## Agents

- [Agents and providers](agents-and-providers.md): ACP transport and the domain event seam, Claude and Codex adapters
  and their verified behaviour, provider terms and login, usage and quota sources, model and effort catalog, one-shot
  calls, CLI updates and adapter cache, agent tools and permissions, `editor_state` / `pr_state`.
- [Crew](crew.md): the Foreman task type: MCP orchestration tools, workers as tasks, permissions, results integration,
  crew communication (`ask_foreman`, notes, verifier, review edges, subordinates), subtask acceptance, attention
  escalation and the reviewer rule.
- [Crew templates and editor](crew-templates-and-editor.md): agent templates, built-in roles, crews as a snapshot in
  the task, the tree and its resolution contract, crew roster, the crew editor (tree and inspector), template library
  and the multi-model implementation slices.

## Git & review

- [Diff and review](diff-and-review.md): snapshot-tree diff engine, task step boundaries, unified and side-by-side
  views, diff base, Changes panel, selection and comments, review loop and submit, review popup, ⌘+click from a diff,
  change counters and "why did this change" attribution.
- [Git](git.md): commit strip and commit modal, file actions in the change list, push, History with search, merge and
  conflict resolution, branch switching and pull, worktree `.env` copying and agent-chosen branch names.
- [Pull requests and CI](pull-requests-and-ci.md): GitHub via `gh`: PR as a property of a repo, creating PRs, PR list
  and panel, files and comments, review (also with an agent or a crew), merge card and conflicts, refresh, links,
  From/Into pickers, CI runs, steps, deploys and the run bell.

## Tools & modules

- [Editor](editor.md): CodeMirror editor: files and explicit save, shared documents and tabs, split groups, Markdown
  views, gutter change marks, wrap, indentation, new file, context menus, blame and file history, save during a turn
  and reopening closed tabs.
- [Editor code intelligence](editor-code-intelligence.md): language servers and fallback code intelligence, go to
  definition and usages, typing help, LSP toggle and restart, format on save, tree-sitter syntax and highlight weights,
  CSS/SCSS, CSS Modules and JSON.
- [Terminal and CLI agents](terminal-and-cli-agents.md): the task terminal and console (PTY, tabs, shell, selection,
  links, theme, font weight, last line, agent console tools) and an agent's own CLI TUI in a terminal (transport
  choice, hooks, chips, turns strip, scrolling, CLI task start).
- [Browser and simulator](browser-and-simulator.md): the in-task browser (desktop and mobile, node picking, console and
  network, DevTools, agent MCP tools including click and type, domain permission, background operation, page
  notifications and sound) and the iOS/Android simulator.
- [Notifications, Slack, notes and schedules](notifications-slack-notes-and-schedules.md): notifications and sound,
  macOS permission, toasts and message classes, notice chips including repo contention, the notification center, the
  Slack module, the Notes module and scheduled tasks.
- [Search, menus and commands](search-menus-and-commands.md): keyboard shortcuts and the menu-bar rule, Search
  Everywhere and related finders, native menu audit and menu glyphs, context confirmation via a native menu, and
  project commands (toolbar button, agent runs, `package.json` scripts, command editor).
- [Settings, modules and onboarding](settings-modules-and-onboarding.md): the settings window and its rows, launch
  defaults, modules that switch features off (browser and simulator, PR, Commands) with their popup settings, and the
  first-run intro.

## Platform

- [Architecture and platform](architecture-and-platform.md): Electron stack and processes, session hosts and sockets,
  the main/preload/renderer IPC boundary, the `~/.brigadir` data layout and JSON/JSONL
  persistence, crash recovery, exit, keep-awake, window frame on Windows/Linux, packaging (DMG, Linux), app name and
  icon, performance profiles and limits.
- [Remote access and mobile](remote-access-and-mobile.md): running Brigadir on one machine and working from another
  (pairing, password, mTLS gateway, phases R0–R5, menus, dialogs and files, browser and simulator from the device,
  networking between machines, the Connect chip) and the phone web version (W0–W3, Tailscale).
- [Appearance](appearance.md): theme, accent colour, fonts and chat text size, i18n and UI text style, design tokens
  and the "Evolution" visual direction, control size scale and one row one height, one look one component, the shared
  Popover and Esc, focus ring, hover, motion, dialogs, loading skeletons and copy cleanup.

## How this spec is maintained

- The spec describes the current product only. It is not a changelog or a design diary.
- A change to behaviour updates the spec first, then the code, in the same change.
- History lives in git, not in the spec: no dates, decision logs or superseded variants.
- Code comments reference the spec as `spec/<file>.md#<anchor>`, where the anchor is an `<a id="…"></a>` in that
  file. Anchors are stable; renaming one means updating every reference to it.
- Work that is still planned sits in each file's **Later** list, not in the body.
