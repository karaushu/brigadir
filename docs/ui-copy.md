# UI copy style · UK / EN

How Brigadir writes interface text in English and Ukrainian. The rules apply to names, buttons, menus, tooltips,
placeholders, states, errors, notifications and accessible names.

Terms and their translations come from the [glossary](glossary.md). The spec summary of these rules is
[UI text style](spec/appearance.md#ui-text-style); the catalog and plural mechanics are in
[Languages](spec/appearance.md#i18n). Every example below is a real entry of the catalog,
`electron/packages/core/src/messages.ts`.

## Principle

Text names the action, setting or result directly. Names are short. A description says what the function does.
Shared UI does not assume a particular operating system. A person must understand an element on first reading.

Not used: stories about what the person will do next, promotional promises, metaphors, and technical detail that does
not help to make a choice.

## Length and form

| Element | Rule | EN | UK |
| --- | --- | --- | --- |
| Setting name | Usually 1–3 words | Code theme | Тема коду |
| Button | Verb + the object it needs, usually 1–4 words | Open in editor | Відкрити в редакторі |
| Switch | The function or the action; the same text in both states | Keep awake | Без сну |
| Description | One function, usually up to 12 words | Code font and colors in the editor and diff. | Шрифт і кольори коду в редакторі та змінах. |
| State | The current state, usually 1–4 words | Finding agents… | Пошук агентів… |
| Empty list | What is missing; an action only when needed | No tasks | Немає задач |
| Error | What failed; the needed action separately | Could not rename the task. | Не вдалося перейменувати задачу. |
| Consequence | Short facts, without dropping important conditions | Uncommitted changes in worktrees will be lost: {files}. | Незакомічені зміни у worktree буде втрачено: {files}. |

These are guides, not a mechanical limit. Do not shorten at the cost of meaning, grammar, or the difference between
two similar actions. Do not add a description when the name is enough.

## What to write

1. Name the object and the action. A description of a code theme names the editor **and** the diff, because the
   theme applies to both surfaces, not to the whole interface.
2. A setting's description says what the setting does. An instruction such as «Вибери теку» belongs only where a next
   step is really needed, never in place of the description.
3. One name for one concept, in both languages: `Options` is «Параметри», a PR `Title` is «Заголовок», `Task name` is
   «Назва задачі», `Preview` is «Перегляд».
4. Ukrainian buttons are infinitives («Надіслати» for `Send`); headings and sections are nouns («Налаштування»).
   Where an instruction is necessary, it uses the informal imperative («Вибери», «Відкрий»). Never mix «ти» and «ви».
   Drop pronouns when the meaning is clear.
5. App states have no «я» or «ми»: «Пошук…», «Збереження…» (`Searching…`, `Saving…`). In the transcript the agent is
   a real actor and can «читати», «писати», «працювати».
6. English uses sentence case. Buttons can be short phrases without articles (`Open in editor`, `Save as command…`);
   full sentences keep their articles. English follows applicable ASD-STE100: one word per meaning, active voice,
   present tense, imperative for actions, one action per sentence, no idioms, noun chains of 3 words or fewer,
   warnings before instructions.
7. Do not mix a result and an action. `Viewed` / `Not viewed` («Переглянуто» / «Не переглянуто») are states; an
   action that sets a state is a separate key with a verb (`Mark completed`, «Позначити завершеною»).
8. Do not promise what is not checked. If an action removes something (Archive removes clean worktrees), the text
   lists what stays and what goes.
9. Keep consequences: lost edits, sending to GitHub, use of the subscription, write access, recovery, restart, limits
   and the fallback.
10. Ukrainian uses a plain spoken register: no officialese, no verbal nouns, no passive where an actor exists.

## What to avoid

- Promotion: «Керуй задачами, а не хаосом», «усе, що потрібно», «легко й швидко».
- Narrating the UI: «Дивись на вікно», «Коли ти натиснеш, ти побачиш».
- Metaphors: «поїде в коміт», «гілка приїде», «checks біжать», «документ впав».
- Empty guarantees: «нічого не втрачено», «за звичним правилом».
- Internal terms in an ordinary tooltip: tool names such as `read_report`, «ребро», «поверхня», «живий host». Exact
  names belong in diagnostics.
- Repetition: the label `Font styles` («Накреслення») needs no description that says it changes font styles. A
  useful description, if one is needed, names the effect: «Жирний і курсив у коді».
- Explaining the obvious ([No explanations of the obvious](spec/appearance.md#no-newbie-explanations)). The reader
  knows what an agent, a note and Undo are. An empty state is a name or one short phrase. `Chat about this note`
  alone is enough; a second line about what the agent «бачить» and «може» is not written. When the input field
  already says what to do, the empty state has no text at all, and its markup goes with it.

## Punctuation and quotes

| | English | Ukrainian |
| --- | --- | --- |
| Quotes around a name | “ ” — `“{title}” completed` | « » — `Відкрити вікно «Архів»` |
| Apostrophe | ’ or ' — `task’s`, `task's` | ʼ (U+02BC) — «ревʼю», «компʼютер», «звʼязок» |
| Ellipsis | one character `…` | one character `…` |
| Decimal separator | point — `0.45 GB` | comma — `0,45 ГБ` |

- A full stop ends a sentence. Names, buttons, menu items and switch labels have no full stop.
- `…` marks a wait (`Searching…`) or a next step that needs input or a choice (`Save as command…`,
  `Вибрати теку…`). It is never decoration. Three dots `...` are not used.
- No exclamation marks.
- A colon stands only before a list, an example or a value (`Незакомічені зміни у worktree буде втрачено: {files}.`),
  not as a link in the middle of a sentence.
- English does not join clauses with a dash; it ends the sentence or uses a comma. Ukrainian uses « — » where grammar
  requires it, between a subject and a noun predicate («Чат — перша вкладка робочої області.»), not as a general
  link between thoughts.
- Arrows and abbreviations are written out in words in running text.
- Some older strings still use ’ in Ukrainian or « » in English keys. Fix them to the table above when you edit
  them.

## Plural forms

- Ukrainian always has four forms through `Intl.PluralRules('uk')`: `one` (1, 21), `few` (2–4, 22–24), `many`
  (0, 5–20, 25), `other` (fractions). Example, `draftCount`: «1 чернетка», «2 чернетки», «5 чернеток».
- English has `one` and `other`: `1 draft`, `2 drafts`.
- Check 0, 1, 2, 5, 11, 21, 22, 25 in Ukrainian; fractions only where a fraction is possible.
- Numbers go through `Intl.NumberFormat` for the UI locale; dates and times through the `Intl` formatters.
- Count helpers live next to the catalog in `messages.ts` (`taskCount`, `draftCount`, `newCommitCount`,
  `riskyCount`, …). A new countable phrase gets its own helper with all four Ukrainian forms.

## Platforms and names in code

- Shared functions say «компʼютер», «система», «файловий менеджер» (`computer`, `system`, `file manager`). `macOS`,
  `Finder`, `Xcode` and `Windows` appear only in an action that belongs to that platform.
- Shortcuts come from the active keymap and platform. The catalog text holds `{shortcut}`, never a literal `⌘`:
  `{shortcut} відкриває в редакторі`. `renderer/ui/shortcut-hint.ts` fills it (`⌘+click` on macOS, `Ctrl+click`
  elsewhere).
- Sleep prevention is **Keep awake / Без сну**, with the switch text «Keep the computer awake while agents work» /
  «Тримати компʼютер активним, поки працюють агенти» ([Keep awake](spec/architecture-and-platform.md#keep-awake)).
  The code names `agents.keepAwake`, `KeepAwakeStatus`, `KeepAwakeRow` and `keep-awake` already describe the
  behaviour and stay as they are.
- Do not promise that the computer stays awake with the lid closed, or the same sleep policy on every OS.

## Localization

- UK and EN carry the same action, condition and consequence. Translate the meaning, not the structure of the
  English sentence.
- All of the app's own text goes through the catalog, including `title`, `aria-label`, placeholders, menus and the
  Settings search.
- Not translated: names the person gave, code, commands, paths, model names and agent output.
- Common developer terms and abbreviations are not spelled out just to translate them: `regex`, `diff`, `PR`, `repo`,
  `branch`, `stash`, `rebase`, `run`, `workflow`, `push`, `pull`, `fast-forward`. «Неправильний regex» for
  `Invalid regex` is a correct short text. An established transliteration is also fine: «мердж», «ревʼю»,
  «деплой». The glossary decides which form a term takes. A technical term is not a defect: fix inaccurate meaning,
  metaphors and extra words around it, not the term itself. Internal names that a person cannot know still need a
  plain word.
- Keep the set and the count of placeholders. Changing `{count}` from a ready phrase to a bare number needs a change
  at the call site. Do not translate a sentence in pieces.
- Ukrainian strings run 15–30 % longer: no fixed widths on buttons, labels or segments.
- Prompts and review framing that the app writes for agents are always English, whatever the UI language.
- When a text changes, check the menu item, tooltip, accessible name, search entry and intro that show it, in both
  languages and in a narrow window.

## Keys and visible text

- `MessageKey` is a stable identifier. `t(locale, key)` returns the `uk` table entry for Ukrainian and, for English,
  the `english` table entry or the key itself when there is none.
- The `english` table holds the visible English wherever it differs from the key. For example the key `Mac sleep`
  shows `Keep awake`, and `Retry (turn)` shows `Retry`. A key is not the current interface text.
- Do not rename keys during ordinary copy editing. Change the visible text in `english` and `uk`. This keeps wording
  apart from call sites and stored data, and a UI rename never renames a stored field.
- Identical texts share one key (`No matches`, `Optional`, `View only`). Unused keys are deleted.
- A key change is updated in every call, the search index and the tests in the same change.
