# Agent and crew templates, crew editor

A crew is a named tree of agents, each with its own provider, model, effort, zone and extra instructions. Agent and crew templates live in a global library; when a task is created, its crew becomes an immutable snapshot (`CrewSpec`) in `task.json`. This file covers the data contract, the built-in roles, the roster the foreman reads, the crew editor, the template library and the implementation slices M1–M5. How a crew runs (orchestration tools, reviews, leads) is in [Crew](crew.md).

<a id="model"></a>
## Model

- A crew is a **tree of named agents**. The root is the foreman. Under it are N agents, each a separate node. Any non-reviewer node can get subordinates: it then becomes the foreman of its branch (a *lead*). A lead delegates, accepts and writes no code itself.
- **No counts, no `auto`, no ceiling.** Three developers are three nodes with three names, zones, models and additions. Provider limits are the only cap.
- A crew can mix providers and models. The foreman is an agent template too, so it has its own provider and model.
- A crew reaches a task in one of three ways: a library crew template, a one-off crew edited on the launch sheet, or **Foreman composes**, where the foreman proposes the crew in its plan (see [Crew](crew.md)). Composed crews also have no count or ceiling.

<a id="entities"></a>
### Entities

| Entity | What it is | Where it lives |
| --- | --- | --- |
| Agent template (`AgentTemplate`) | name, role, optional provider, launch choices, specialty, instructions | `~/.brigadir/templates/agents/<id>.json` |
| Crew agent (`CrewAgent`) | tree node: name, template, overrides, zone, specialty, extra instructions, subordinates, checkers | inside a crew template |
| Crew template (`CrewTemplate`) | the root `CrewAgent` (foreman) plus its tree | `~/.brigadir/templates/crews/<id>.json` |
| Crew snapshot (`CrewSpec`) | fully resolved tree, stored in the task | `task.json` → `crew` |

All types and checks are in `packages/core/src/crew.ts`. Pure editor operations are in `packages/core/src/crew-edit.ts`, and storage is in `packages/persistence/src/templates.ts`.

<a id="agent-template"></a>
### Agent template

```json
{
  "id": "reviewer-astra",
  "name": "Astra reviewer",
  "role": "reviewer",
  "provider": "codex",
  "choices": { "modeId": "read-only", "configOptions": { "model": "gpt-6-astra", "reasoning_effort": "high" } },
  "choiceNames": { "model": "6 Astra", "reasoning_effort": "High" },
  "summary": "Reviews API changes; give it every backend part to check",
  "instructions": "You do not write code. ...",
  "builtin": false
}
```

| Field | Rule |
| --- | --- |
| `role` | `foreman` \| `developer` \| `reviewer`. This is the tool set the host gives the agent. |
| `provider` | `claude` \| `codex`, optional. If it is missing, the agent uses the default agent from Settings ▸ Agents. |
| `choices` | `CrewChoices = { modeId?, configOptions?: Record<id, string \| boolean> }`. Ids and values come only from the provider catalog (`session/new` config options), never from a model table of our own. |
| `choiceNames` | Display names next to the ids, so a template stays readable on a machine that has not seen that provider's catalog. |
| `summary` | The specialty: one English line, at most 240 chars, no line breaks. It is written for the **parent**, not for the agent. |
| `instructions` | The agent's **role** in English ("who you are, how you work"), not the task. The foreman writes the task in `create_worker_task`. |
| `builtin` | `true` only for templates shipped in code. Those are never written to disk. |

<a id="crew-template"></a>
### Crew template

```json
{
  "schemaVersion": 1,
  "id": "ui-api-tests",
  "name": "UI + API + Tests",
  "builtin": false,
  "root": {
    "id": "root", "name": "Foreman", "template": "foreman-default",
    "extraInstructions": "Coordinate the named agents.",
    "agents": [
      { "id": "ui-lead", "name": "UI lead", "template": "foreman-default", "zone": ["apps/admin/src/ui/**"],
        "agents": [
          { "id": "ui-dev", "name": "Layout", "template": "developer", "checkedBy": ["ui-review"] },
          { "id": "ui-review", "name": "Designer", "template": "reviewer",
            "extraInstructions": "Check the screens against the design and the brief." }
        ] },
      { "id": "api", "name": "API", "template": "developer", "provider": "codex",
        "choices": { "configOptions": { "model": "gpt-6-astra" } }, "checkedBy": ["review"] },
      { "id": "tests", "name": "Tests", "template": "developer", "checkedBy": ["review"] },
      { "id": "review", "name": "Reviewer", "template": "reviewer" }
    ]
  }
}
```

`CrewAgent` fields are `id`, `name`, `template: string | null`, and optionally `provider`, `choices`, `choiceNames`, `summary`, `zone: string[]`, `extraInstructions`, `agents: CrewAgent[]`, `checkedBy: string[]` and `leafDraft`.

- The root has the same type as every other node. Its overrides are stored like any node's.
- `name` is what people see in the sidebar and on the board. It is also how the foreman addresses an agent in `create_worker_task(agent:)`; the host resolves the name to the node id from the snapshot.
- `provider` and `choices` **override** the template for this node only.
- `extraInstructions` is **appended** after the template's instructions. The template text is not copied into the node, so editing a template reaches every node that uses it, while each node keeps its own addition.
- `zone` uses the same path format as `files` in `create_worker_task`.
- `checkedBy` holds stable node ids. The UI shows names, and renaming a node never breaks an edge.
- `template: null` is an empty agent: a developer with no template that uses the provider defaults.
- `leafDraft` is editor state only and never reaches `CrewSpec` (see [Editor operations](#editor-operations)).

<a id="builtin-templates"></a>
## Built-in templates

The product works without any user template. There is one built-in **agent** template per tool set the host gives (Foreman, Developer, Reviewer), plus **Senior developer**: a Developer on a stronger model, so a crew can pay for strength only where a part needs it. Four **specialists** cover the roles people would otherwise write themselves: **Tester** and **Technical writer** write files, **Designer** and **Security reviewer** only check. A specialist is a Developer or a Reviewer with its own instructions and specialty; it has no rights of its own. Any other role is a person's own template, written from scratch or as a duplicate of a built-in. Every template that is not a foreman can also be the role of a task without a crew ([Tasks](tasks.md#sheet-role)) and the role of a subagent a task's agent starts when the person mentions the template in the composer ([Composer](composer.md#agent-blocks)).

| Id | Name | Role | Instructions |
| --- | --- | --- | --- |
| `foreman-default` | Foreman | `foreman` | Empty: the foreman brief in code is the whole role. Nodes with subordinates use this template too. |
| `developer` | Developer | `developer` | Implement your part; own the listed files only; `read_notes` / `post_note` around shared contracts; `ask_foreman` instead of guessing; run the check the prompt names before ending the turn and say what it showed; a check that fails for a reason outside the zone is reported, not worked around; do not commit. |
| `senior-developer` | Senior developer | `developer` | The Developer text, plus: read the code around the change first and say in the last message what was verified and how. Specialty: `Migrations, performance work, cross-module refactors and parts without a clear spec`. Claude `opus`, effort `high`. |
| `tester` | Tester | `developer` | Write and run the tests of a part and own only the listed test files; for a bug, first a test that fails because of it; test what a caller or a person can observe; never change the code under test: a defect stays as a failing test and is reported with what it shows; follow the project's test style; run the tests before ending the turn and say which passed and which failed; do not commit. Specialty: `Tests for a part: unit and integration tests, a failing test for a bug; changes no production code`. Claude `sonnet`. |
| `technical-writer` | Technical writer | `developer` | Write the documents of a change (README, guides, the spec, API comments) and own only the listed files; read the code and its diff first and describe what the code does now; keep the project's structure, terms and tone; never change behaviour: a disagreement between code and a document goes to `ask_foreman`; run every command and example written; do not commit. Specialty: `Documentation for a change: README, guides, the spec, API comments; changes no behaviour`. Claude `sonnet`. |
| `reviewer` | Reviewer | `reviewer` | Write no code; `read_report`, then `read_diff` one file at a time; look for what a check cannot show (wrong behaviour, a changed contract, work outside the files); the report must name the check that was run and its result; comment only on what must change before acceptance, because every round runs the developer again; `submit_review` with line comments; `approve` when nothing is left. |
| `designer` | Designer | `reviewer` | Write no code; `read_report` and `read_diff`, then open the changed screens in the running app with the browser or simulator tools; check light and dark themes, a narrow and a wide window, keyboard focus, hover, pressed and disabled states, loading, empty and error states, long text, and spacing against neighbouring screens and the project's tokens; with no tool to open a screen, say so instead of judging from the code; comment only on what must change before acceptance, naming the screen and the state; `submit_review`, then `approve`. Specialty: `Checks screens in the running app: themes, states, keyboard, layout`. |
| `security-reviewer` | Security reviewer | `reviewer` | Write no code; `read_report`, then `read_diff` one file at a time; follow untrusted input to where it is used (queries, commands, paths, markup, prompts); look for missing access checks, secrets and personal data in code, logs and URLs, unsafe file and network access, new dependencies and widened permissions, weakened validation; report only a defect with a path: the input, the line, the consequence; no style remarks; `submit_review`, then `approve`. Specialty: `Checks changes for security defects: untrusted input, access checks, secrets`. Claude `opus`, effort `high`. |

| Id | Name | Tree |
| --- | --- | --- |
| `default` | Crew | Foreman → `Developer 1`, `Developer 2`, `Reviewer`. The Reviewer checks both developers. |
| `tests` | Crew with tests | Foreman → `Developer`, `Tester`, `Reviewer`. The Reviewer checks both. |
| `review` | Review crew | Foreman → `Astra` (reviewer, Codex `gpt-6-astra`, high) and `Opus` (reviewer, Claude `opus`, high). This is the PR review crew; see [Pull requests and CI](pull-requests-and-ci.md). |

Rules:

- Built-in instructions are versioned with the code, like the foreman brief.
- Foreman, Developer and Reviewer have no fixed model: empty `choices` means the provider's default model at launch. Senior developer, Tester, Technical writer and Security reviewer ship with a model (and the first and the last with an effort), like the nodes of the Review crew; the values are catalog ids, and a catalog without them shows the usual amber substitution (see [Choices at launch](#launch-check)).
- A person **can change the provider, model and effort of every built-in role**, Senior developer and the specialists included. The name, rights, specialty and instructions stay the app's. The overlay is stored in `templates/builtin/<id>.json` as `{ schemaVersion: 1, template: { id, provider?, choices?, choiceNames? } }` and replaces the app's provider and choices whole. Saving an overlay equal to the app's values deletes the file. **Reset** in the library does that; it is offered while the role differs from the app's values. See also the built-in role overlay in [Agents and providers](agents-and-providers.md).
- A person **can edit a built-in crew in place**: its agents, their templates, models, zones, additions and check edges. The id and the name stay the app's. The edited crew is stored whole in `templates/builtin/<id>.json` as `{ schemaVersion: 1, template }`, a crew document under the built-in id with `builtin: true`, and stands in for the app's crew everywhere a crew is picked by id: the launch sheet, the PR review, schedules. Saving a tree equal to the app's deletes the file. **Reset** in the library does that; it is offered while the tree differs from the app's. A file that is not a valid crew, or fails `crewIssues` against the agent library, is reported as an issue and the app's crew is used. **Save as crew template** from the editor still saves a copy under a new id.
- Deleting a built-in crew only **hides** it (`templates/builtin/hidden-crews.json`, `{ schemaVersion: 1, crews: [...] }`); its edits stay on disk. **Restore default crews** brings every hidden crew back, edited as it was.
- Built-in names are stored in English and shown in the interface language (`crewLabel`, `builtinCrewNames`).
- These ids are reserved, and an own template cannot use them: `compose` plus every built-in agent id and built-in crew id.

<a id="snapshot"></a>
## Crew in the task: a snapshot, not a reference

When a task is created, its crew is resolved into a `CrewSpec` and stored whole in `task.json`. This includes backlog tasks. After that the task **never reads the template library again**.

- **Why.** A template is something a person keeps editing; a task is a record of one launch. If a second-wave worker re-read the template, two reviewers in one task could follow different rules. A backlog task starts with what was chosen when it was created, even if the template has since been deleted.
- `AgentTask.crew` is present on a foreman task and absent on a single-agent task. The task's `provider` is `crew.root.provider`.
- A worker task stores `crewTaskId` (the root foreman task), `crewNodeId` and `parentTaskId` (its direct foreman or lead).
- The tree defines the crew size. Plan parts belong to developers and leads only, never to reviewers.
- Each worker is a separate host process with its own provider. One process still hosts exactly one agent session, so providers never mix inside one ACP session.
- The worker's role text reaches it as a `.context` block of its first prompt: template instructions, then the node's addition, then its place in the tree. The agent reads it; the transcript and journal never show it. Because the source is `task.json`, it survives a restart. The foreman's prompt follows as `.text`. On the ACP wire `.context` is a plain text block, so Claude and Codex receive it the same way.

<a id="resolution-contract"></a>
## Tree and resolution contract

JSON is validated at the persistence boundary and on import. A TypeScript type alone is not treated as validation. Structural checks are `isAgentTemplate`, `isCrewTemplate`, `isCrewSpec` and the `*Document` wrappers. Semantic rules are `crewIssues`.

<a id="limits"></a>
### Limits

| Item | Limit |
| --- | --- |
| Agent or crew name | 1–80 chars after trim, no `\r`, `\n` or `\0` |
| `summary` | ≤ 240 chars, single line |
| `instructions`, `extraInstructions` | ≤ 100,000 chars |
| `zone` | ≤ 256 entries, each path ≤ 1024 chars |
| Children per node, `checkedBy` per node | ≤ 64 |
| Nodes per crew | ≤ 256 (structural depth ≤ 32) |
| `choiceNames`, `configOptions` | ≤ 64 keys |
| Recommended depth | 2 levels under the foreman. Deeper trees show a warning and are allowed (`crewRecommendedDepth`). |

<a id="tree-rules"></a>
### Tree rules

- **Ids** are unique within a crew and never change on rename. The editor creates UUIDs; built-ins use short ids. A duplicated crew gets a new template id and keeps its node ids, because node ids only need to be unique within one crew. A copied branch gets fresh ids, and edges inside it are rewritten to the copies (`cloneCrewBranch`).
- **Names** are non-empty and unique after trim and Unicode NFC (`crewName`). Renaming changes only the name.
- **Role** of a node (`crewAgentRole`): the root, or any node with children, is `foreman`. `template: null` is `developer`. Otherwise the node takes the template's role, and an unknown template falls back to `developer`.
- **Check edges** connect a developer to a reviewer among the children of one parent. These are not allowed: self-check, duplicate checkers, checking the root, checking a lead, edges across branches, and a reviewer with children.
- **Zones** are project-relative POSIX paths, optionally ending in a glob (`normalizeZonePath`). Normalization converts `\` to `/`, collapses repeated slashes and strips leading `./`, leading `/` and trailing `/`. Empty paths and paths with `.` or `..` segments are rejected. A child's zone must lie inside its parent's effective zone; for a glob, its static prefix is compared (`zoneCovers`). An empty zone inherits the parent's zone. At the root, an empty zone means the whole project.
- Deleting a node removes every edge pointing at it in the same editor operation. An imported crew with a missing checker is **rejected**, not repaired.

`crewIssues` codes and their English UI text (`crewIssueText`):

| Code | Text |
| --- | --- |
| `root_checked` | The foreman cannot be checked. |
| `duplicate_id` | Two agents have the same id: {name}. |
| `duplicate_name` | Two agents have the same name: {name}. |
| `unknown_template` | The agent template is not found: {name}. |
| `zone_outside_parent` | The zone goes beyond the zone of the agent above: {name}. |
| `reviewer_with_agents` | A reviewer cannot have subordinates: {name}. |
| `self_check` | An agent cannot check itself: {name}. |
| `duplicate_check` | The same checker is added twice: {name}. |
| `unknown_checker` | The checker is not under the same lead: {name}. |
| `checker_not_reviewer` | Only a reviewer can check: {name}. |
| `checked_not_developer` | Only a developer can be checked: {name}. |

<a id="resolution"></a>
### Resolution (`resolveCrew`)

`resolveCrew` refuses an invalid template, and it refuses a template with any issue. For each node:

1. `provider` is the node's provider, else the template's, else the default agent from Settings ▸ Agents.
2. Choices are merged in layers: optional per-provider defaults, then the template's choices, then the node's choices. `configOptions` merge by key, and `modeId` is merged separately. **If the node changes the template's provider, the template's choices and names are dropped.** Model, mode and effort never carry over between providers.
3. `instructions` come from the template, and `extraInstructions` from the node.
4. `summary` is the node's, else the template's, else empty, all after trim.
5. The effective `zone` is the node's normalized zone, else the parent's effective zone.

`CrewSpec`:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `templateId` | `string \| null`. Records origin only; it is never read back. `compose` for a composed crew. |
| `name`, `resolvedAt` | Crew name; ISO time of resolution |
| `root` | `CrewSpecAgent`: `id`, `name`, `template?` (origin, so the editor can reopen a resolved crew), `role`, `provider`, `requestedChoices`, `choiceNames`, `summary?`, `instructions`, `extraInstructions`, effective `zone`, `checkedBy`, `agents` |
| `compose?` | Present only for **Foreman composes**: a palette snapshot of templates and provider models (see [Crew](crew.md)) |

`isCrewSpec` also checks these invariants: the root is a `foreman`; ids and names are unique; a node has children if and only if it is a `foreman` (the root is the exception, since it may have none); every edge goes to a sibling `reviewer`; only developers are checked; the root has no checkers.

<a id="launch-check"></a>
### Choices at launch

The snapshot keeps the **requested** choices. When a worker actually starts, its host checks each requested option against the catalog of the freshly started session. It applies the valid options with `setOption` / `setMode`. It records `effectiveChoices` and `unavailableOptions` in the worker record (`crew-workers.json`), and the agent runs with the provider's default for anything it could not apply. `requestedChoices` and the snapshot are never rewritten. There is no automatic provider substitution.

Before the start, the launch sheet already checks the resolved crew against each provider's catalog. Each value is checked against the options of that agent's own model, because effort levels differ per model. Every node with an unknown value is shown in amber: "Model «{model}» is unavailable in {provider} — {agent} starts with the provider default." The substitution is always visible, never silent.

<a id="roster"></a>
## Crew roster in the brief

The foreman's brief is composed in `packages/orchestrator/src/brief.ts` (`foremanBrief`) from these parts:

1. The code core: role, how to split, the loop, the rules.
2. For a lead, its place in the larger tree.
3. The **roster** of its direct children, or the composing palette for **Foreman composes**.
4. The crew tools brief.
5. The template's `instructions`.
6. The node's `extraInstructions`.

The roster is the only place a foreman learns who its agents are. Each lead gets the same block for its own branch.

Each child is described as `` `Name` (summary; Provider · model · effort; leads `A`, `B`; zone `p/**`; checked by `R`) ``. A reviewer gets `checks `A`, `B``, or `reviewer, checks nobody yet` when it checks no one. The roster ends with an instruction to pass `agent` to `create_worker_task` / `propose_plan`, to match parts to specialty and zone, and the [model ladder](crew.md#model-ladder).

- **Model and effort** (`specModel`) come from `requestedChoices`: the name from `choiceNames`, else the id, or `provider default model` when no model is chosen. The host finds the effort option by the same kinds the controls use (`thought_level`, `effort`, `reasoning_effort`, `thinking_level`). If no effort is chosen, or the model has none, that part is omitted.
- A brief written before a worker started is not rewritten when that worker's model turns out to be unavailable.
- **Workers and reviewers never see their siblings' models or effort.** That data goes only to whoever distributes the work. The worker `.context` (`workerContext`) contains instructions, the addition, the zone, its checkers or checked agents, and its siblings, all without models.
- The roster does not include the mode, because the mode is about permissions, not strength, and permissions stay with the person. It also does not include full instructions, to save the foreman's context.

<a id="crew-editor"></a>
## Crew editor

`CrewEditor` (`apps/desktop/src/renderer/CrewEditor.tsx`) is a modal dialog. The tree with connectors is on the left, on a dotted background. The inspector for the selected node is on the right. It opens from **Set up…** on the launch sheet (as a one-off crew, mounted over the sheet so the sheet's draft is kept), from **Edit…** in Settings ▸ Templates, and for the crew of a running foreman (see [Crew](crew.md)).

<a id="editor-header-footer"></a>
### Header and footer

- **Header** (row size M): `Crew`, the editable crew name (≤ 80 chars; locked for a built-in crew edited from the library, whose name is the app's), and the summary `foreman + N agents · M levels` (plural forms through `crewAgentCountLabel` / `crewLevelCountLabel`). For a one-off crew it also shows `crew · own` or `crew · built-in`. It ends with the shared Esc close (`ui/PopupClose`).
- **Esc** closes an open popup first, then the editor.
- **Footer** (row size M): the first issue as a localized line, or the save error. Then **Save as crew template**, **Cancel** and **Done**. **Done** and **Save as crew template** are disabled while `crewIssues` is non-empty.
- **Done** returns the edited tree. From the launch sheet it becomes a one-off crew: the sheet shows `<name> · own`, and `task:create` sends `{ template }`. From the library it saves the template; a built-in crew is saved as its edit (see [Built-in templates](#builtin-templates)).
- **Save as crew template** writes the crew to the library. If the source is built-in, it is saved under a new UUID.

<a id="editor-tree"></a>
### Tree

| Element | Behaviour |
| --- | --- |
| Geometry | Root 180×34; nodes 104×54; 10 px between nodes; 100 px between levels. Each subtree is as wide as its row of children. |
| Root node | One line: helmet glyph, name, then the provider glyph and model in mono |
| Agent node | Provider glyph and name; second line: template name (or `Foreman` for a lead, `Agent` for an empty agent) · model · `N subordinates` for a lead (4 plural forms in Ukrainian). A reviewer has an amber frame; the selected node has an accent ring. |
| Lead | Carries the helmet glyph, because it is the foreman of its branch |
| Delegation lines | Solid, from parent to each child. Lines from the root use `--fg3`; lines from a lead use the accent colour. The legend reads "delegates and accepts". |
| Check edges | Amber dashed line with an arrow from the checker to the checked node. Each edge gets its own lane below the row (6 px apart). The legend reads "up to 2 review rounds, then escalation to the lead". |
| `+ Agent` | Dashed slot at the end of the foreman's row of children |
| `+` under a node | Appears on hover or selection, never on reviewers. It adds a subordinate. Hovering a node shows only this `+`; the card itself gets no hover fill. Pressing still has its state. |
| Depth warning | Beyond 2 levels: "More than two levels. Each level adds a context handoff." |
| Hint | "Drag an agent onto an agent to add a check." |
| Selection | The first agent is selected when the editor opens. Clicking empty canvas clears the selection, and the inspector then shows "Select an agent in the tree". |

**Add agent popup** (opened from `+ Agent`, the node `+` or the Subordinates `+`; titled "Agent templates"): first the built-ins in the library's order (Developer, Senior developer, Tester, Technical writer, Reviewer, Designer, Security reviewer), then Foreman with the tail "For a branch", each with its provider glyph. Then the person's own templates, with the pencil glyph and the model as the tail. Then **Empty agent…**. The popup does not use the words "built-in" or "own"; the pencil glyph marks the difference. Picking an item adds the node at once under a unique name (`Developer`, `Developer 2`, …), selects it and focuses the inspector's name field with the text selected, so the node can be renamed straight away. Pressing Esc while the name is empty removes that new node.

**Checks by drag.** Drag a reviewer onto a developer, or a developer onto a reviewer, among the children of one parent. While dragging over a valid target, a preview edge is drawn in the resulting direction: the same amber dashed line at 45 % opacity. An impossible pair gets no preview, and dropping it shows an error. A pair under different leads shows "Could not add the check: the agents are under different leads." To remove an edge, use the × on its horizontal segment (visible on hover) or the × on the checker's chip in **Checked by**.

<a id="editor-inspector"></a>
### Inspector

The inspector is 376 px wide, with row size M. Its rows, top to bottom:

| Row | Behaviour |
| --- | --- |
| Name | Editable title (weight 600, ≤ 80 chars). Next to it is the agent template popup (non-foreman templates only): built-ins first with an empty glyph slot so the names align, then own templates with the pencil glyph, then **Empty agent…**. The current value has a ✓ (`PopupMarks`); a closed popup on a built-in shows the name only. Changing the template changes only what the node has not overridden. For a lead or the root the popup is locked to **Foreman**; a lead also shows the caption `has subordinates`. |
| Provider | `Claude` \| `Codex` segments. If the node picks a provider other than the template's, that is its own override (caption `own`), and the node's choices are cleared. |
| Model, Effort, Mode | The same catalog-driven popups as the composer and the launch sheet. The effort list belongs to the node's chosen model, and changing the model drops an effort that model lacks. Values inherited from the template are shown as they are; a node override is captioned `own`. If the provider catalog is not known yet, the template's `choiceNames` are shown dimmed with "the catalog appears after the first launch". |
| Zone | Mono field, comma-separated paths. The placeholder is `parent zone` under a lead or when the parent has a zone, else `whole project · name folders`. |
| Specialty | One-line English field (≤ 240 chars; line breaks become spaces). Its placeholder is the template's `summary` when there is one, so the inherited text is visible; otherwise "In English." |
| Subordinates | Chips (clicking one selects that node), `none` when empty, and a square 24 px `+` chip. Not shown for reviewers. |
| Checked by | Amber chips with × (click removes the check), and `+` with a popup of the sibling reviewers not yet added (developers only). Empty shows `nobody`, or for a lead `nobody · the foreman accepts the branch`. |
| Lead note | "Manages subordinates in its zone. Writes no code. Without subordinates, uses the original template." |
| Template instructions «{name}» | Collapsed, read-only block (`· read-only`) that expands to the full text. Instructions are edited only through the template. For a lead or the root it shows the Foreman template. |
| Additionally for {name} | Multi-line English field, 64 px tall, placeholder "Additional instructions, in English." Caption `only this agent`, or for the root "Add to the briefing." |
| Actions | **Save as agent template** (leaf) or **Save branch as template** (lead); **Remove agent** or **Remove with subordinates**, in danger style. Not shown for the root. |

- **Root inspector**: name, template (locked to Foreman), provider, model, effort, mode, template instructions and the addition. It has no zone (the root owns the whole project), no Specialty and no Checked by. The caption says these instructions add to the briefing and do not replace it. For a running foreman the root shows only "The foreman is already working: its settings stay."
- **Catalog source**: the editor and the library call `readProviderCatalog` (IPC `templates:catalog`). Main probes the provider in a temporary directory. If that fails, it falls back to the catalog of the latest task of that provider in this workspace. A failed probe is retried after 5 minutes.
- While a save is in flight, every field is disabled.
- Small text (captions, labels, the node's second line, legend, notes, the issue line) is 10.5 px. Fields, popups, segments, buttons and chips use the shared `ui/` components at their own sizes; the editor adds no local copies.

<a id="editor-operations"></a>
### Editor operations

All of these are pure functions in `crew-edit.ts`. Each returns a new template.

| Operation | Rule |
| --- | --- |
| `addCrewAgent` | The new node gets a unique name. A leaf that gains its first child stores its `template`, `provider`, `choices` and `choiceNames` in `leafDraft`, takes `foreman-default`, and loses its own `checkedBy` and any edges that point at it. |
| `removeCrewAgent` | Removes the node, its branch and every edge to it. Removing a parent's last child restores the parent's `leafDraft` and deletes the field. The root cannot be removed. |
| `renameCrewAgent` | Rejects an empty or duplicate name. The id is unchanged. While typing, a temporarily empty or duplicate name is kept and blocks **Done**. |
| `updateCrewAgent` | A patch value of `undefined` removes the override (the field goes back to the template). A node with children keeps the Foreman template. |
| `addCrewCheck` / `removeCrewCheck` | Between children of one parent only; no self-checks. |
| `cloneCrewBranch` | Copies a branch next to the source with fresh ids and suffixed unique names. Inner edges follow the copy; edges to outside siblings are kept. |
| `duplicateCrewTemplate` | Deep copy with a new template id and `builtin: false`. Node ids are kept. |
| `branchAsCrewTemplate` | A lead's branch becomes a crew template with the lead as root (template Foreman). `leafDraft`, `checkedBy` and `zone` are dropped. |

**Save as agent template** creates a new own template from the node. It takes the node's effective role and specialty, `instructions = template instructions + "\n\n" + extraInstructions`, and the merged provider, choices and names. The node then points at the new template, and its overrides, specialty and addition are cleared.

<a id="template-library"></a>
## Template library

Templates are **global, not per project**. Repository-specific knowledge ("always require tests here") belongs in `CLAUDE.md`, which every worker inherits, and a role does not depend on the repository. The library is the **Templates** tab of Settings (`TemplatesSettings.tsx`). The app menu item **Templates…** opens that tab. The tab's layout is in [Settings, modules and onboarding](settings-modules-and-onboarding.md).

<a id="library-list"></a>
### List and actions

- The list is master-detail in two groups, **Agents** and **Crews**, in a 272 px column. Built-ins come first, then own templates sorted by name, each with the pencil glyph. Agents are cards ([Agent cards](#agent-cards)); crews are rows with a tail of the agent count and levels.
- The list footer has only `+ ▾` and `−`. The `+ ▾` menu offers **New agent** (a developer with empty instructions), **New crew** (a copy of the default crew), a separator, **Import…**, and **Restore default crews** while any built-in crew is hidden.
- `−` deletes an own template or hides a built-in crew. It is disabled for built-in agents.
- Detail header: **Reset** (only on a customized built-in agent or an edited built-in crew), **Duplicate** (adds ` 2` to the name), **Edit…** (crews, built-in ones included; disabled while the crew has issues) and **Export…**. A built-in template carries the tag `built-in`.
- **Agent detail**: Name, Specialty (not for foreman templates; on a built-in it is the app's line shown as text, and only when the built-in has one), Provider (a provider turned off in Settings ▸ Agents is disabled unless the template already uses it; changing the provider clears the choices), Model, Effort, Mode, **Rights ▸ Checker** (switch between `developer` and `reviewer`; caption "Reads reports and changes, submits reviews, and approves work. Writes no code."), and **Instructions** (caption "Agent role, in English").

<a id="agent-cards"></a>
### Agent cards

Every agent template in the list is a `ui/OptionCard` card without the radio mark, one under another; the group is one radio group, so the arrow keys walk it. The card of the selected template is chosen; pressing a card selects it.

- A **built-in** card is the role guide: the role's glyph and name, its work in one line, three strength dots (`ui/LevelDots`) with a hint for model and effort, and under them the model each enabled provider has for that work: the provider glyph and the model's catalog name. Dots and hints are the app's advice for the role, the [model ladder](crew.md#model-ladder) as a picture; they do not follow a changed provider or model.

  | Role | Work | Dots | Hint | Claude | Codex |
  | --- | --- | --- | --- | --- | --- |
  | Foreman | Splits the work, accepts the parts | 3 | `Strongest model · Medium` | `fable` | `astra` |
  | Developer | Parts with a clear spec | 1 | `Faster model · Medium` | `sonnet` | `terra` |
  | Senior developer | Migrations, refactors, unclear specs | 2 | `Strong model · High` | `opus` | `sol` |
  | Reviewer | Checks the work, writes no code | 2 | `Author's model or stronger` | `opus` | `astra` |
  | Tester | Writes tests, changes no production code | 1 | `Faster model · Medium` | `sonnet` | `terra` |
  | Technical writer | Writes docs, changes no behaviour | 1 | `Faster model · Medium` | `sonnet` | `terra` |
  | Designer | Checks screens in the running app | 2 | `Author's model or stronger` | `opus` | `astra` |
  | Security reviewer | Looks for security defects in changes | 2 | `Strong model · High` | `opus` | `sol` |

  The last two columns are words, not model ids (`roleModelWords`, `roleModelPick` in `packages/core/src/role-models.ts`): the model shown is the first entry of the provider's catalog whose value or name says the word, under the catalog's own name (`Opus 5.5`, `6.1 Sol`), the way the Helper agent finds its default ([Agents and providers](agents-and-providers.md#helper-agent)). A provider turned off shows nothing; a catalog that has no such entry shows nothing for that provider; before the catalog is known the word itself is shown. The cards only show: they change no template.
- An **own** card has the glyph of its rights (helmet for a foreman, review for a checker, code otherwise), the name with the pencil glyph at the end of the line, the Specialty as its line (without one: `Splits the work, accepts the parts`, `Checks the work, writes no code` or `Writes code` by its rights), and under it the provider glyph with the model and effort it names, or `Default model`.

- **Best for** row under Effort: `Clear parts · Hard parts · Leading and checking`, with the one that fits this template in full colour and the rest muted (`templateFit`). A foreman or a reviewer leads and checks; a developer fits hard parts when its effort is `high` or above, clear parts otherwise.
- **Effort dots** beside the Effort popup: one dot per level of the model (`default` is not a level), filled up to the chosen one. Levels past `high` fill amber, and a line under the row says "An effort above High costs about as much as a stronger model." `high` is found by the level's value or name, a presentation rule and not a table of levels (rule 7); a model without such a level never warns.
- A built-in agent is read-only apart from provider, model and effort: its name is locked, its Mode and Rights are disabled, and its instructions are shown read-only so they can still be read and copied in full.
- Agent edits **autosave** 300 ms after the last change, without a busy state, so the focused field keeps its focus.
- **Crew detail**: the Agents list and Levels, edited with the same `CrewEditor`. **New crew** copies the app's default crew, not its edit.
- Failures show as one line in the detail pane that names the action, for example "The template could not be saved." or "Could not export the template."

<a id="library-storage"></a>
### Storage, import and export

- Files are `{ schemaVersion: 1, template }` documents, written atomically with pretty-printed JSON. Directories are created with mode `0700`, and writes are serialized.
- Read rules: a file name must equal its `template.id`; symlinks, non-files and reserved built-in ids in `templates/agents` and `templates/crews` are reported as `issues` and skipped. Edits of built-ins live only in `templates/builtin/`. A crew that fails `crewIssues` against the current agent library is reported as an issue too.
- Deleting an agent template leaves crews that reference it invalid (listed as issues) until they are edited. Tasks keep their snapshots.
- `saveCrew` re-validates the crew against the library before writing. A crew with `builtin: true` and a built-in crew id is written as that crew's edit; any other use of a reserved id is refused.
- **Export…** uses the system save dialog and writes `<name>.json` (`/`, `:` and `\` replaced with `-`) with the document, indented by 2 spaces.
- **Import…** uses the system open dialog. The file must be at most 2,000,000 chars and a valid agent or crew document; it is validated before anything is written, and `builtin` is forced to `false`. Under remote access, both dialogs run on the device (see [Remote access and mobile](remote-access-and-mobile.md)).
- IPC: `templates:read`, `templates:save-agent`, `templates:save-crew`, `templates:delete` (`kind`, `id`), `templates:restore-crews`, `templates:export`, `templates:import`, `templates:catalog`. Every write returns the fresh `CrewLibrary` (`agents`, `crews`, `issues`, `hiddenCrews`).

<a id="launch"></a>
## Crew on the launch sheet

The launch sheet's crew row and roster are described in [Tasks](tasks.md). The parts that belong to this contract:

- `CrewLaunch` sent with `task:create` is one of `{ templateId }`, `{ template }` (a one-off crew) or `{ compose: true, template? }`. In the last form the template, if given, is a foreman alone. Main reads the library, checks `crewIssues`, resolves the crew and remembers the crew choice per project.
- The crew popup lists **Foreman composes**, the built-in crews and the own crews in one column of names; the selected crew has a ✓. **Set up…** opens the editor as a one-off crew. Adding agents in the editor while **Foreman composes** is selected turns the selection into a one-off crew.
- The roster on the sheet shows the foreman, then each child by name with its provider glyph and `(+N)` on a lead; the model is in the tooltip. Unavailable models are shown in amber (see [Choices at launch](#launch-check)).

<a id="after-launch"></a>
## Where the role shows after launch

- **Sidebar and board**: a worker row in the foreman card shows `<agent> · <part>` with the provider glyph. A lead's subordinates are indented by depth under its row. See [Sidebar](sidebar.md).
- **Plan card**: each part has an `Agent` column, chosen by the foreman from its own children and editable before confirmation. A mismatch between plan and crew (two parts for one agent, a part outside the agent's zone, a reviewer given code) is shown, and it blocks starting the workers. See [Turns, plans and questions in chat](chat-turns-plans-and-questions.md).

<a id="later"></a>
## Later

- Per-project template overrides, if a case appears that `CLAUDE.md` does not cover.
- Zone autocomplete from the project tree. The zone is plain text today.
- Collapsing a lead's branch in the sidebar crew card. Today the whole card collapses.

<a id="non-goals"></a>
## Non-goals

- An app-owned table of provider models. Models come only from the provider catalog.
- Role counts (`×N`), `auto` crew size or a node ceiling in templates.
- Templates in the cloud or synced. They are JSON files in `~/.brigadir`, exported as files.
- Swapping the role of a live worker. A session cannot be switched; a new role means a new worker.
- A free-form graph editor. There are only two edge kinds, and both have host semantics.
- Setting the foreman's model in Settings instead of in the crew. Different crews need different foremen.
- Showing workers the models of their siblings, or showing the foreman full instructions or modes in the roster.
