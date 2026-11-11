# Glossary

The UI terminology reference for Brigadir. Read it before you write any text that a user sees: labels,
buttons, menu items, tooltips, accessible names, toasts, empty states, error messages. Read it together
with the style guide for short UI text, [ui-copy.md](ui-copy.md).

Every visible string lives in `electron/packages/core/src/messages.ts`. The English text is the key (or its
entry in the `english` override map); the Ukrainian text is the value. When this file and that file disagree,
`messages.ts` is correct and this file must be fixed.

Each table has four columns:

- **English**: the English UI text.
- **Ukrainian**: the Ukrainian UI text.
- **Meaning**: one line about what the term names and where it appears.
- **Avoid**: synonyms that must not be used for this concept, in either language.

## Rules

**One term per concept.** Do not use synonyms "for variety" in either language. One word must not have two
meanings in visible text. When two concepts need similar words, this file gives each its own term
(for example, *Console* and *Page console*, *Stop* and *Force quit process*).

**English follows ASD-STE100 (Simplified Technical English).** One word has one meaning and one part of
speech. Use the active voice and the present tense. One action per sentence. No idioms, no phrasal verbs.
A noun chain has three words or fewer. A warning comes before the instruction. Short labels can drop the
article (`Open diff`, `Pin task`); full sentences keep it.

**Ukrainian uses a plain spoken register.** Use the word a developer says out loud. No officialese
(«перевірити», not «здійснити перевірку»), no passive voice («агент змінив файл», not «файл було змінено»),
no bookish words («запустити», not «ініціювати»), no needless Latinisms («перевірка», not «верифікація»).
Address the user with the informal «ти»: «Вибери проєкт», «Додай repo».

**Buttons are verbs, headings are nouns.** Buttons use the infinitive in Ukrainian («Надіслати»,
«Створити worktree») and the imperative in English. Section headings and tab names are nouns
(«Налаштування», «Задачі»). The one exception is the question-shaped action *Why did this change?*

**Ukrainian plurals have four forms:** `one` (1, 21), `few` (2–4, 22–24), `many` (0, 5–20), `other`
(fractions). Never write two forms only. Use the count helpers in `messages.ts` (`fileCount`,
`commentCount`, `taskCount`, `uncommittedCount`, and others).

**Ukrainian quotes are «».** Do not use “curly” quotes in Ukrainian text.

**The apostrophe in Ukrainian is ʼ (U+02BC):** `ревʼю`, `компʼютер`, `запамʼятати`.

**Prompts to the agent are in English,** whatever the UI language.

## Technical names

These names stay in English (or in a fixed transliteration) in the Ukrainian UI. They are the "Technical
Names" category of STE.

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| commit / Commit | коміт / Закомітити | A git commit. The noun is «коміт», the verb button is «Закомітити». | |
| diff | диф | Running text only: «у дифі», «Переглянути диф». The diff surface is called *Changes* (see Git). | |
| hunk | хунк | One block of changes in a diff. | «фрагмент», «гунк» |
| branch | branch | A git branch: «Нова branch», «Перемкнути branch», «Вибери branch». | «гілка» (reserved for a branch of the crew tree) |
| submodule | submodule | A git submodule. | «підмодуль» |
| worktree | worktree | A git worktree that isolates a task. | «робоче дерево» (that is the git working tree) |
| working tree | робоче дерево | The checked-out files of a repo, as in `git status`. | |
| Push | Відправити | The push button and menu item: `Відправити`, `Відправити коміти…`, `Відправити все`. As a noun, `push` stays: «Перший push», «push 2 год тому». | «залити» |
| Pull | Pull | Fetch and fast-forward a branch. | «підтягнути» as a button (it is used only in sentences: «підтягне 3 коміти з origin») |
| Rebase | Rebase | | |
| merge / Merge | мердж / Змерджити | The noun is «мердж», the verb is «змерджити», the past participle is «змерджено». | «злиття», «злити» |
| stash / Stash | stash / Stash | `Stash і перемкнути`, `Повернути зі stash…`. | |
| repo / repos | repo | One git root in a project. It does not decline and has no plural form: `1 repo`, `2 repo`, `5 repo`. | «scope», «репо» |
| repository | репозиторій | Only in full sentences about git in general. | |
| pull request | PR / Pull requests | `PR` in labels; `Pull requests` as the name of the section, tab, and module. Plural in running text: «PR'и». | «пул-реквест» |
| Checks | Checks | GitHub status checks on a PR: `Checks пройшли`, `Checks не пройшли`. | «перевірки» (that word is a crew check edge) |
| run | run | One GitHub Actions workflow run in the CI list: `Run завершено`, `До переліку run'ів`. | |
| CI | CI | | |
| Effort | Effort | The reasoning level of a model. | |
| Fast | Fast | The fast mode of an agent. | |
| DevTools | DevTools | The developer tools window of a page. | «Web Inspector» |
| GUI | GUI | The ACP transport of a task (chat and composer). | |

## Product and tasks

### Core concepts

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Project | Проєкт | A folder with one or more repos. | |
| Projects | Проєкти | | |
| All projects | Усі проєкти | A sidebar row and a board with tasks of every open project. | |
| Task | Задача | One unit of agent work. | «завдання», «тікет» |
| Agent | Агент | | |
| Provider | Провайдер | Claude, Codex, and the next ones. | |
| Default agent | Типовий агент | The provider a new task starts with. | |
| Helper agent | Помічник | The agent that writes one-off texts (commit messages, titles, suggestions). | |
| Session | Сесія | The agent process under a task: «Нова сесія», «Сесія закінчилась». | |
| Turn | Турн | One exchange: a prompt and the answer to it. | |
| Prompt | Промпт | | |
| Subagent | Сабагент | A nested agent inside one session, shown as its own block in the chat. | «підлеглий» (that is a crew term) |
| Model | Модель | | |
| Mode | Режим | A mode that the agent reports (`availableModes`). | |
| Isolation | Ізоляція | How a task works on files: `No isolation` or `worktree`. | |
| No isolation | Без ізоляції | The agent works directly in the project folder. | «На місці» |
| Main tree | Основне дерево | The repo working tree on its current local branch, not a worktree. | |
| Read-only | Лише читання | A repo the agent cannot write to; a lock mark in the row. | |
| Read and write | Читання й запис | A repo the agent can write to (the default). | |
| Mixed changes | Змішані зміни | Several tasks change one repo without isolation. | «конфлікт», «контенція» |
| Busy | Зайнято | The state of a repo that another task holds. | |
| Work despite the lock | Працювати попри лок | Start a task in a repo that another task locks. | |
| Snapshot | Знімок | A git tree at one point in time; the diff engine compares snapshots: «знімки змін». | «снапшот», «чекпоінт» |
| Project knowledge | Знання проєкту | Suggested additions to the project instruction file, mined from repeated questions. | |

### Task states and lists

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Backlog | Беклог | A saved task whose agent has not started. | |
| Add to backlog | У беклог | The switch in the new task sheet footer. | |
| Start task | Почати задачу | Start a backlog task. | |
| Queued | У черзі | The task waits for a repo lock or a free agent slot. | |
| Working | Працює | | |
| Needs you | Потрібен ти | The agent waits for an answer, a permission, or a plan approval. | |
| Done | Готово | The turn finished; the task waits for the next prompt. | |
| Interrupted | Перервано | | |
| Error | Помилка | A turn or tool call failed. | |
| Stopped | Зупинена | | |
| Not started | Не розпочата | | |
| Unreviewed | Непроглянуті зміни | The task finished and its changes are not reviewed yet. | «не прорецензовано» |
| Unread | Непрочитане | The agent wrote to the chat since you last looked. | |
| In progress | У роботі | A board column and list section: a task that has or had an agent. | |
| Completed | Завершені | A board column and list section. One task in it is «Завершена». | «Закінчені», «Готові» |
| Mark completed | Позначити завершеною | | |
| Move to in progress | Перенести у роботу | | |
| Complete | Завершити | The swipe action on a sidebar card. | |
| Pin task / Unpin task | Закріпити задачу / Відкріпити задачу | | |
| Delete task | Видалити задачу | Delete the task, its worktree, and its change snapshots. Crew workers go with it. | |
| Clear the list | Очистити список | Delete the shown tasks of the Completed column. | |
| Archive (noun) | Архів | Hidden tasks: the `Архів · N` section and the Archive window. Nothing is deleted. | |
| Archive | Архівувати | Hide a task in the archive. Menu bar: `Archive task` / `Архівувати задачу`. | |
| Archive… | Архів… | Opens the Archive window. | |
| Restore from archive | Повернути з архіву | Short form in toasts and the archive window: `Restore` / `Повернути`. | «Розархівувати», «Відновити» |
| Archive completed | Архівувати завершені | The setting that archives completed tasks after a number of days. | |
| Description | Опис | The start of the prompt on a task card; also the description of a PR. | |
| Task name | Назва задачі | The placeholder of the title field in the new task sheet. | |

### New task sheet

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| New task | Нова задача | The sheet that starts a task, and the agent card that proposes one. | |
| New quick task | Нова швидка задача | A task without isolation in the main tree. | |
| Options | Параметри | The expand strip of the sheet. | |
| Repos and folders | Repo і теки | The row with the repos and folders of the task. | |
| Add folder… | Додати теку… | Add a folder outside git; it can be added to a running task too. | |
| no git | без git | The tail of a folder chip with no git repo: the agent reads it, it gives no diff. | |
| Folder unavailable | тека недоступна | An external folder that is not on disk. | |
| Copy .env | Копіювати .env | Copy ignored `.env*` files into a new worktree before setup. | |
| Attach files… | Прикріпити файли… | | |
| Description from a .md file… | Опис з файла .md… | Insert the text of a `.md` file into the description once. | «Імпорт» |
| brigadir/auto | brigadir/auto | The placeholder of an empty branch field: the agent names the branch. | |
| Naming the branch… | Добір назви branch… | The preparation step that names the branch. | |
| Switching the branch | Перемикаю branch | The preparation step of a task without isolation. | |
| Set up… | Налаштувати… | Open the crew editor for one-off changes. | |
| Task options… | Параметри задачі… | Open the sheet filled from a proposed task. | |
| Continue in a new task | Продовжити в новій задачі | A new task that starts with the summary of this one. | |
| Task summary | Підсумок задачі | The attachment chip with the summary of the previous task. | |
| Task diff | Зміни задачі | The attachment chip with the changes of the previous task. | |
| Full patch | Повний патч | Add hunk bodies to the change summary. | |

### Proposed tasks

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| New task (card) | Нова задача | An agent proposes a task in the same project. The task exists only after `Create`. | |
| Create | Створити | | |
| Decline | Відхилити | The task is not created; the agent learns about the refusal. | |
| Task created / Task not created | Задачу створено / Задачу не створено | The collapsed card after the answer. | |
| Created from | Створено з | The link from the new task to the task that proposed it. | |
| Proposed in | Запропоновано в | The row above the sheet text opened from the card. | |

### Schedules

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Schedule / Schedules | Розклад / Розклади | A project object: a task form and a rule. Also a sidebar section. | «планувальник» |
| Schedule (verb) | Запланувати | | |
| New schedule | Новий розклад | | |
| Scheduled tasks | Задачі за розкладом | | |
| Runs · {n} | Запуски · {n} | Tasks that a schedule created. One is a «запуск». | |
| Run now | Запустити зараз | An extra run; it works when the schedule is paused. | |
| Pause / Resume | Призупинити / Відновити | The schedule does not run; the rule stays. | |
| When | Коли | The sheet group: `Now` · `Later` · `Repeat`. | |
| Now · Later | Зараз · Пізніше | | |
| Repeat… | Повторювати… | The task menu item: a copy of the task with a repeat rule. | |
| If missed | Якщо пропущено | What to do with a run the computer missed: `Catch up` · `Skip` · `Ask`. | |
| Catch up | Наздогнати | | |

## Sidebar and project screen

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Sidebar | Сайдбар | `Show sidebar` / `Hide sidebar`. | |
| Sections | Розділи | The narrow rail left of the sidebar: Tasks, Pull requests, Notes, Schedules. | |
| Tasks | Задачі | The section with projects and tasks. | |
| Filter tasks | Фільтр задач | The search field at the top of the sidebar. | |
| Filter by status | Фільтр за станом | The glyph button with the status menu. | |
| All tasks | Усі задачі | The first row of the status menu; it resets the filter. | |
| Collapse project / Expand project | Згорнути проєкт / Розгорнути проєкт | | |
| Project icon | Іконка проєкту | The tile before the project name: an icon, a monogram, or an image. | |
| Picked by the agent | Вибрав агент | The row with the icon that the agent picked. | |
| Pick again | Вибрати ще раз | | |
| Monogram | Монограма | Two letters of the project name in its color. | |
| Your image | Своє зображення | An image file the user picked as the icon. | |
| Generate with Codex | Згенерувати в Codex | Codex draws an icon. | |
| Task card | Картка задачі | A task as a card on the board and in the sidebar. | |
| Brigadir card | Картка бригадира | A sidebar container: the foreman header and its workers inside. | «Картка плану» |
| Active workers | Активні воркери | The tooltip of the number next to the helmet. | |
| A worker is waiting for you | Воркер чекає на тебе | The second line of a foreman card. | |
| In the background · {count} | У фоні · {count} | Background commands of a task. | |
| Project view | Вигляд проєкту | `Board` or `List`. | |
| Board | Дошка | The project screen with columns. Only this screen. | «дошка» for crew records |
| List | Список | | |
| Draft · Open · In review · Closed | Чернетки · Відкриті · На ревʼю · Закриті | Columns of the PR board. One PR is `Чернетка` · `Відкритий` · `Змерджено` · `Закрито`. | |

## Chat and composer

### Chat

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Chat | Чат | The transcript and the composer together. «Розмова» is only an accessible name (`Conversation`, `Conversation turns`). | «розмова» in visible text |
| Composer | Композер | The input field. `To composer` / `У композер` adds a selection to it. | |
| Message | Повідомлення | | |
| Send | Надіслати | | «Відправити» (that is push) |
| Stop | Зупинити | Stop the turn. The process lives and the session continues. | «Вбити» |
| Force quit process | Завершити примусово | End the session. It cannot continue. | «Зупинити» |
| Active agents | Активні агенти | The popup with live agent processes of all projects. | |
| Thinking / thought | Думає / думав | The collapsed thought stream of the agent. | |
| Writing | Пише | The turn status while the agent writes the answer. | |
| Working | Працює | The turn status while the agent runs tools. | «лоадер» |
| Tool | Інструмент | What the agent calls. | |
| Tool calls | Виклики інструментів | A group of calls under one header; the header says «N викликів». | |
| Background commands | Фонові команди | A command the agent left running after its call. | «фонова задача» (a task is a sidebar card) |
| Output | Вивід | The output of a background command. | «лог», «консоль» |
| Turns | Турни | The turn marks on the right edge of the chat. Accessible name: `Conversation turns` / `Турни розмови`. | |
| Next turn / Previous turn | Наступний турн / Попередній турн | | |
| Turn completed | Турн завершено | | |
| Copy message | Копіювати повідомлення | Copy one reply. | «Копіювати відповідь» (that copies the whole turn) |
| Copy link / Open link | Копіювати посилання / Відкрити посилання | | |
| Why did this change? | Чому це змінилось? | A hunk action that finds the turn that made the change. | |
| Show in Files | Показати у Файлах | Open the folder in the Files tab. | |

### Composer and steering

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Send now | Надіслати зараз | ↩ during a turn: the message goes into this turn at the next agent step. | |
| To the queue | В чергу | ⌘↩ during a turn: the message waits for the turn to end. | |
| Suggest the next prompt | Підказувати наступний промпт | The ghost suggestion switch. | «автодоповнення» |
| Mention | Згадка | An `@` insert in the prompt: a file, a task, an agent, a model. | «тег», «посилання» |
| Slash commands | Slash-команди | The `/` menu group with agent commands. | «Команди» (those are project commands) |
| Skills | Скіли | The `/` menu group with agent skills. | «навички», «вміння» |
| Attach screenshot | Прикріпити знімок | | |
| Pasted image | Вставлене зображення | The name of an image from ⌘V. The agent gets it in English. | |
| Image | Зображення | | |
| Task repos | Repo задачі | The composer popover with the repos, branches, and changes of the task. | |
| {count} repos | {count} repo | The repo counter. | |

### Questions, permissions, and plans

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Question | Питання | The agent asks you; a card with options. | |
| Answer | Відповісти | The button of the question card. | |
| Your answer… | Своя відповідь… | The free-text field of the question card. | |
| Skip | Пропустити | Do not answer; the agent continues alone. | |
| answered by the foreman | відповів бригадир | | |
| Permission | Дозвіл | | |
| Allow / Deny | Дозволити / Відмовити | The buttons of the permission card. | |
| Plan | План | The step plan of the agent, one row in the chat. | |
| Plan for approval | План на погодження | The plan an agent in Plan mode sends before work. | |
| Approve plan | Погодити | The main action of the plan for approval. | «Схвалити» (that is the PR review verdict) |
| Plan further… | Планувати далі… | Reject the plan with text about what to change. | |
| Send edits | Надіслати правки | Replaces `Approve plan` when the user edited the plan. | |
| Plan approved / Plan rejected | План погоджено / План відхилено | | |

### Quick question

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Ask the agent | Спитати агента | The selection action: a separate agent session answers under the lines. | |
| Quick question | Швидке питання | A question outside the task chat. | «побічне питання», «запит» |
| Revert | Відкотити | Restore the files that the quick question changed. | |

## Crew

The crew is a foreman and its workers. `Brigadir` is the product; `Foreman` / `Бригадир` is the agent that
leads a crew.

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Crew | Бригада | A foreman and its workers as one team. | «команда», «ростер» |
| Crews | Бригади | | |
| Foreman | Бригадир | The agent that splits work, assigns parts, and accepts them. | |
| Worker / Workers | Воркер / Воркери | A task that does one part under the foreman. | |
| Developer / Reviewer | Розробник / Ревʼюер | Built-in agent templates. | |
| Senior developer | Старший розробник | Built-in agent template: a Developer on a stronger model. | |
| Tester | Тестувальник | Built-in agent template: writes and runs the tests of a part. | «тестер», «QA» |
| Technical writer | Технічний письменник | Built-in agent template: writes the documents of a change. | «техрайтер» |
| Designer | Дизайнер | Built-in agent template: checks screens in the running app, writes no code. | |
| Security reviewer | Ревʼюер безпеки | Built-in agent template: checks changes for security defects. | «безпечник» |
| Crew with tests | Бригада з тестами | Built-in crew: a developer, a tester and a reviewer. | |
| Crew members | Склад | The plan card section with the members the foreman proposes. | «ростер», «слот» |
| Foreman composes | Бригадир збере | The crew popup item: the foreman proposes the members. | «Авто» |
| crew from the foreman | склад від бригадира | | |
| Edit crew… | Редагувати склад… | | |
| Templates | Шаблони | The settings tab with agent and crew templates. | |
| Agent templates / Crew templates | Шаблони агентів / Шаблони бригад | | |
| Own template | Свій шаблон | A template a user made. | «мій», «кастомний» |
| built-in | вбудований | A template that ships with the app. | |
| Reset | Скинути | Return provider, model, and effort to the defaults. | |
| Save as crew template / Save as agent template | Зберегти як шаблон бригади / Зберегти як шаблон агента | | |
| Save branch as template | Зберегти гілку як шаблон | A branch of the crew tree, not a git branch. | |
| New agent / New crew | Новий агент / Нова бригада | | |
| Instructions | Інструкції | The role text of an agent template, in English. | «промпт» |
| Specialty | Спеціалізація | One sentence for the foreman: what the agent is good at. | «Опис» |
| Zone | Зона | The files an agent owns. | |
| Subordinates | Підлеглі | The agents under a lead in the crew tree. | «сабагенти» |
| Checker | Перевіряльник | An agent that reviews others and writes no code. | |
| Checked by | Перевіряють | The inspector field with the checkers of an agent. | |
| check | перевірка | The edge from a checker to an agent: `Remove check`. | |
| round {n} of 2 | коло {n} з 2 | One fix-and-report exchange between an agent and its checker. | |
| delegates and accepts | делегує й приймає | The solid line of the crew tree. | |
| Remove with subordinates | Прибрати з підлеглими | | |
| Restore default crews | Повернути типові бригади | | |
| Review crew | Бригада ревʼю | The default crew: a foreman and two reviewers. | |
| Crew log | Записи бригади | Notes the crew agents leave for each other. One item is a «запис». | «дошка», «нотатки» |
| report | звіт | The structured summary of a worker. | |

## Git, changes, and review

### Changes panel

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Files | Файли | The panel tab with the file tree. | |
| Diff | Зміни | The panel tab, toolbar segment, and menu: the changes of the task. | «Диф» as a label |
| Changes | Зміни | The list of changed files. | |
| History | Історія | The history of one branch of one repo. | |
| Open diff | Відкрити зміни | Open the diff tab of a file. | |
| Open in editor | Відкрити в редакторі | | |
| Revert file changes… | Відкотити зміни у файлі… | The confirmation names the file. | |
| Revert change | Відкотити зміну | Return one hunk in the buffer to the base. | |
| Next hunk / Previous hunk | Наступний хунк / Попередній хунк | | |
| Base snapshot | Базовий знімок | The snapshot the changes are counted from. | |
| Repo actions | Дії repo | The `⋯` menu of a repo row. | |
| Create PR | Створити PR | | |
| Push commits… | Відправити коміти… | | |
| Checks… | Checks… | The checks state of the open PR. | |

### Commit

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Commit… | Закомітити… | Opens the commit dialog. | |
| Commit message | Повідомлення коміту | | |
| New commit | Новий коміт | A future commit in the commit dialog. | «кошик» |
| Not in a commit | Поза комітами | A file removed from every planned commit. | |
| Split with the agent | Поділити з агентом | The helper agent proposes commits. | |
| Hook failed | Хук не пройшов | A git hook stopped the commit sequence. | |
| Generate | Згенерувати | A one-off agent call writes text into the field. | «Написати» |
| Generating… | Генерація… | | |
| Generate again | Згенерувати ще раз | | |
| Try again | Спробувати ще раз | Retry where no agent writes (network, `gh`). | |

### Branches

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Switch branch… / New branch… | Перемкнути branch… / Нова branch… | | |
| Stash and switch | Stash і перемкнути | | |
| Bring the changes | Взяти зміни з собою | | |
| Discard and switch… | Відкинути й перемкнути… | | |
| Stash changes | Stash змін | | |
| Restore from stash… | Повернути зі stash… | | |
| Discard changes… | Відкинути зміни… | | |
| Local branches | Локальні | A group in the branch list. | |
| Pull · {commits} | Pull · {commits} | The `↓N` chip: commits on origin that are not local. | |
| Push commits · {commits} | Push commits · {commits} | The `↑N` chip: commits that are not on origin. | |

### Merge and conflicts

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Merge… | Змерджити… | Opens the merge dialog of the changes panel. | |
| Merge | Змерджити | The main action of the merge dialog. | |
| Into / From | Куди / Звідки | | |
| No conflicts expected | Конфліктів не очікується | | |
| Conflict / Conflicts | Конфлікт / Конфлікти | | |
| Resolve conflicts… | Розвести конфлікти… | Open the conflicts. To resolve a merge conflict is «розвести». | «вирішити» for merge conflicts |
| Resolve with the agent | Розвести з агентом | | |
| Resolve manually | Вирішити вручну | Open the conflict places in the editor. | |
| Conflicts resolved | Конфлікти розведено | | |
| Accept yours / Accept theirs | Взяти твоє / Взяти їхнє | Take the whole file from one side. | |
| Accept both | Взяти обидва | | |
| Yours · Result · Theirs | Твоє · Результат · Їхнє | The three columns of a manual merge. | |
| Ours / Theirs / Both | Наше / Їхнє / Обидва | The sides of a conflict place in the editor. | |
| Non-conflicting | Неконфліктні | Apply the changes that have no conflict. | |
| Back to the conflict | Повернути конфлікт | Undo the resolution of one file. | |
| Abort merge | Скасувати мердж | `git merge --abort`. | |
| Finish merge | Завершити мердж | | |

### Line author and file history

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Line author | Автор рядка | The author and date of the line with the caret (git blame). | «blame» |
| File history | Історія файла | History filtered to one file. | |
| Commit of this line | Коміт цього рядка | | |
| Open commit | Відкрити коміт | | |
| Copy hash | Копіювати хеш | | |

### Review

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Review | Ревʼю | A set of comments on the changes. | |
| Comment / Comments | Коментар / Коментарі | | |
| Review comments | Коментарі рев’ю | The popup with files that have comments. | |
| Send to chat | Надіслати в чат | Give the comment to the agent now. | |
| Submit review | Надіслати ревʼю | | |
| Resolve thread | Вирішити тред | Mark a GitHub thread as resolved. To resolve a thread is «вирішити». | |
| Resolved | Вирішено | | |
| Outdated | Застарілий | | |
| Viewed | Переглянуто | | |

## Pull requests and CI

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Pull requests | Pull requests | The section, panel, and module. | «пул-реквести» |
| All pull requests | Усі pull requests | | |
| Filter pull requests | Фільтр pull requests | | |
| PR open · PR draft · PR merged · PR closed | Відкритий · Чернетка · Змерджено · Закрито | The state of one PR. | |
| Overview | Огляд | The PR page as an editor tab. | |
| Comments · Files · Commits · Checks | Коментарі · Файли · Коміти · Checks | The PR tabs. | |
| From · Into | Звідки · Куди | The head and base pickers of a new PR. | |
| Ready for a PR | Готові до PR | Pushed branches without a PR. | |
| Hide until the next push | Сховати до наступного push | | |
| Ready for review | Готовий до ревʼю | Mark a draft PR as ready. | |
| Approve | Схвалити | The approving verdict of a GitHub review. | «Погодити» (that is a plan) |
| Request changes | Попросити змін | | |
| Hand to the agent to fix | Передати агенту на виправлення | Give the review comments to the agent; nothing goes to GitHub. | |
| Review with an agent | Ревʼю з агентом | A split button: a review task, `Quickly` or `In a worktree`. | |
| Quickly | Швидко | The agent reads the PR code from git and does not switch the branch. | |
| In a worktree | У worktree | | |
| Your review | Твоє ревʼю | | |
| Generate a summary | Згенерувати підсумок | The agent summary of a PR. | |
| Resolve conflicts | Розвести конфлікт | The split button of the merge card on the PR overview. | |
| Resolve in the dialog | Розвести в діалозі | | |
| Older runs are on GitHub | Старші запуски — на GitHub | | |
| Back to the runs | До переліку run'ів | | |

## Editor

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Editor | Редактор | | |
| Go to definition | Перейти до визначення | | |
| Find references | Знайти використання | | |
| Language server / Language servers | Мовний сервер / Мовні сервери | | «LSP» in visible text |
| Format on save | Форматувати при збереженні | | «автоформат» |
| Format document | Форматувати документ | | |
| Formatting | Форматування | The composer submenu: Bold, Italic, Code, Link. | «стилі», «розмітка» |
| Code | Код | The raw-text view of a Markdown file; the settings section with language servers. | |
| Bracket pairs | Пари дужок | | «автодужки» |
| Closing tags | Закривальні теги | | |
| Call parentheses | Дужки виклику | | |
| Indentation | Відступи | The settings section. | |
| Indent style | Відступ | `Auto` · `Tabs` · `Spaces`: what indents, not how much. | |
| Tab width | Ширина табу | How many columns one tab character takes. Here «таб» is the character. | |
| Tabs / Spaces | Таби / Пробіли | | |
| Default | Типово | Use the global setting. | |
| Close other tabs / Close all tabs | Закрити інші вкладки / Закрити всі вкладки | Here a tab is a document tab: «вкладка». | |
| Close unmodified tabs | Закрити вкладки без правок | | «незмінені» («зміни» is the git diff) |
| Editor group | Група редактора | One split of the document area, with its own tab row. | «панель», «спліт» |
| Split right / Split down | Розділити праворуч / Розділити вниз | | |
| Unsplit / Unsplit all | Зняти поділ / Зняти всі поділи | | |
| Preview | Перегляд | The rendered Markdown view. | «превʼю», «рендер» |
| Side by side | Поруч | Code and preview side by side. | |
| Find in file | Пошук у файлі | The floating find bar of the editor. | |
| Unsaved | Не збережено | The dot on a tab with unsaved changes. | |
| Discard changes | Відкинути правки | Drop unsaved buffer edits. | |

## Task window, tools, and modules

### Layout

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Layout | Макет | The toolbar switch: Chat · Work area · Panel. | |
| Task layout | Макет задачі | `Two columns` or `Three columns`. | |
| Two columns / Three columns | Два стовпці / Три стовпці | | «колонки» |
| Chat as a tab / Chat as a column | Чат вкладкою / Чат стовпцем | | |
| Work area | Робоча область | The middle column with tab groups of files, diffs, terminals, browsers, and the simulator. | «Workspace» |
| Show all | Показати все | | |
| Reset column widths | Скинути ширини стовпців | | |
| Tools… | Інструменти… | The toolbar menu: new terminal, browser, simulator, open tools. | |
| Task tools | Інструменти задачі | | |
| Where to open | Куди відкривати | | |
| Icons only / Icons and names | Лише іконки / Іконки з назвами | The title bar mode. | |

### Console and commands

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Terminal | Термінал | The terminal emulator, and the CLI transport of a task. | |
| Console | Консоль | The terminals of the task. | |
| Session ended | Сеанс завершено | One shell in the console is a «сеанс». | «сесія» (that is the agent) |
| Clear | Очистити | Clear the terminal buffer. | |
| Commands | Команди | The toolbar button and search tab with project commands. | |
| Command | Команда | A saved shell command with a name, repo, and folder. | «скрипт», «пресет» |
| Run / Stop / Restart | Запустити / Зупинити / Перезапустити | Stop sends `SIGINT`. | |
| Transport | Транспорт | How the task agent is driven: `GUI` or `Terminal`. | |

### Browser and simulator

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Browser | Браузер | A work area tab with a web page. | |
| Agent in the browser | Агент у браузері | The frame label while the agent acts on the page. | |
| Select element | Вибрати елемент | Pick a page element and attach it to the prompt. | «вузол» |
| Page console | Консоль сторінки | The console messages of a page. | «Консоль» (that is the task terminals) |
| Network | Мережа | The requests of a page. | |
| Screenshot to chat | Знімок у чат | | |
| Desktop / Mobile | Компʼютер / Мобільний | The browser mode. | |
| Site notifications | Сповіщення сайту | `Ask` · `Allow` · `Block` for the page domain. | |
| Mute tab / Unmute tab | Вимкнути звук вкладки / Увімкнути звук вкладки | | |
| Simulator | Симулятор | iOS Simulator and Android Emulator. | «емулятор» |

### Modules and remote access

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Modules | Модулі | App parts that turn off with their agent tools: Browser, Simulator, Pull requests, Commands, Remote access. | |
| Module turned on / Module turned off | Модуль увімкнено / Модуль вимкнено | | |
| Remote access | Віддалений доступ | The module that controls this machine from other devices. | |
| Remote | Віддалено | The sidebar icon while remote access is on. | |
| Device | Пристрій | A paired computer or phone that controls the working machine. | «симулятор» |
| Machines | Машини | Computers where agents work. In text, use the machine name. | «хост» |
| Allow control from other devices | Дозволити керування з інших пристроїв | | |
| Turn off remote access | Вимкнути віддалений доступ | | |

### Notes

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Notes | Нотатки | A section of Markdown notes, each with its own agent chat. | |
| New note | Нова нотатка | | |
| No project | Без проєкту | A note without a project. | |
| From the note | З нотатки | A task created from a note. | |
| Chat about the note | Чат нотатки | | |
| Edited the note | Змінив нотатку | The agent edit card. | |

## Search

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Search Everywhere… | Шукати всюди… | The global search dialog. | |
| All | Усе | The first search tab. | «Усі» |
| Text | Текст | Search in file contents. | «Вміст», «Пошук у файлах» |
| Find in Files… | Знайти в файлах… | Opens the Text tab. | |
| Find Action… | Знайти дію… | Opens the Actions tab. | |
| Recently opened | Нещодавні | | |
| Match case / Whole word / Regular expression | Враховувати регістр / Ціле слово / Регулярний вираз | | |
| Mask | Маска | File name globs, comma-separated; `!` excludes. | |
| All repos | Усі repo | | |

## Settings

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Settings | Налаштування | | |
| General · Appearance · Agents · Editor · Notifications · Modules · Keyboard · Templates | Загальні · Вигляд · Агенти · Редактор · Сповіщення · Модулі · Клавіші · Шаблони | The settings tabs. | |
| Language | Мова | | |
| Follow system | Як у системі | | |
| Theme / Light / Dark | Тема / Світла / Темна | | |
| Interface | Інтерфейс | The font and text size of the whole app. | |
| System font | Системний шрифт | | |
| Accent | Акцент | The color of selection, buttons, switches, and links. | «акцентний колір» |
| Code theme | Тема коду | Syntax colors only. | |
| Font styles | Накреслення | Bold keywords and italic comments. | «стиль шрифту» |
| Font weight | Насиченість | The terminal font weight. | «вага», «товщина» |
| Scroll speed | Швидкість прокрутки | | |
| Keymap | Набір | A set of shortcuts: Brigadir, VS Code, IntelliJ. | |
| Change shortcut | Змінити поєднання | One shortcut is a «поєднання». | |
| Providers | Провайдери | | |
| Customize per action | Налаштувати для кожної дії | Pick an agent per action. | |
| Same as Default agent / Same as Helper agent | Як типовий агент / Як помічник | | |
| One-off texts | Разові тексти | | |
| CLI updates | Оновлення CLI | | |
| Update in the background | Оновлювати у фоні | | |
| Check now | Перевірити зараз | | |
| Keep awake | Без сну | Keep the computer awake while agents work. | |
| Concurrent agents | Одночасних агентів | How many agents run at the same time. | |
| Subscription limits | Ліміти підписки | | |
| Context | Контекст | The context window of a session. | |
| Initial setup | Початкові налаштування | | |
| Application menu | Меню застосунку | The ☰ button on Windows and Linux. | |
| Help | Довідка | | |
| Updates | Оновлення | Brigadir's own updates, not the agents' CLIs. | |
| Check for Updates… | Перевірити оновлення… | Menu item that checks the releases now. | |
| Download in the background | Завантажувати у фоні | Setting: a new version downloads itself; checking always happens. | |
| Restart to update | Перезапустити й оновити | Installs a downloaded version; waits for running turns. | |
| Download update | Завантажити оновлення | Shown when the build cannot install by itself. | |
| Cancel restart | Скасувати перезапуск | Stops a restart that waits for turns. | |

## Notifications

There are two kinds: in-app notifications (toasts and the notification center) and system notifications
of the OS. In both languages they are *Notifications* / «Сповіщення».

| English | Ukrainian | Meaning | Avoid |
|---|---|---|---|
| Notifications | Сповіщення | Toasts, the notification center, and system notifications. | «нотифікації», «тости» |
| Mark all as read | Позначити все прочитаним | | |
| Clear | Очистити | Clear the history; live requests stay. | |
| No notifications | Немає сповіщень | | |
| When | Коли | When an event notifies. | |
| Never | Ніколи | The event does not notify. | |
| Turn ended | Кінець турну | Notify at the end of each turn. | |
| Sound / None | Звук / Немає | | |
| System permission | Системний дозвіл | | |
| Allowed / Not requested yet | Дозволено / Ще не запитано | | |
| Notifications are off in system settings | Сповіщення вимкнено в системі | | |
| Turn on notifications | Увімкнути сповіщення | | |
| Retry | Спробувати ще | A failure toast action. | «Повторити» |
| Slack | Slack | | |

## Agent tool calls

A tool call row of the `brigadir` server shows a verb by its state: **running**, **done**, **failed**. The
failure form is impersonal and says what did not happen; the reason is on the second line. The subject is the
agent, so the Ukrainian past tense is masculine (`Прийняв`). A crew member name comes after the verb and does
not decline. Tools of other servers are not translated: `server · tool`, as the server names it.

| Tool | Running (en · uk) | Done (en · uk) | Failed (en · uk) |
|---|---|---|---|
| `propose_plan` | Proposing a split · Пропонує розбиття | Proposed a split · Запропонував розбиття | Could not propose a split · Розбиття не запропоновано |
| `create_worker_task` | Assigning a part · Доручає частину | Assigned a part · Доручив частину | Could not assign the part · Частину не доручено |
| `prompt_task` | Sending a prompt · Надсилає промпт | Sent a prompt · Надіслав промпт | Could not send the prompt · Промпт не надіслано |
| `prompt_task` (answer) | Answering the worker · Відповідає воркеру | Answered the worker · Відповів воркеру | Could not send the answer · Відповідь не надіслано |
| `task_status` | Checking the status · Перевіряє стан | Checked the status · Перевірив стан | Could not get the status · Стан не отримано |
| `read_report` | Reading the report · Читає звіт | Read the report · Прочитав звіт | Could not read the report · Звіт не прочитано |
| `read_transcript` | Reading the chat · Читає чат | Read the chat · Прочитав чат | Could not read the chat · Чат не прочитано |
| `read_diff` | Reading the changes · Переглядає зміни | Read the changes · Переглянув зміни | Could not read the changes · Зміни не прочитано |
| `submit_review` | Sending the review · Надсилає ревʼю | Sent the review · Надіслав ревʼю | Could not send the review · Ревʼю не надіслано |
| `approve` | Approving the work · Схвалює роботу | Approved the work · Схвалив роботу | Could not approve the work · Роботу не схвалено |
| `accept_task` | Accepting the part · Приймає частину | Accepted the part · Прийняв частину | Could not accept the part · Частину не прийнято |
| `ask_foreman` | Asking the foreman · Питає бригадира | Asked the foreman · Спитав бригадира | Could not ask the foreman · Питання бригадиру не надіслано |
| `post_note` | Writing a log entry · Пише запис | Left a log entry · Залишив запис | Could not leave the log entry · Запис не залишено |
| `read_notes` | Reading the crew log · Читає записи бригади | Read the crew log · Прочитав записи бригади | Could not read the crew log · Записи бригади не прочитано |
| `ask_user` | Asking you · Питає тебе | Asked you · Спитав тебе | Could not ask you · Питання тобі не надіслано |
| `create_task` | Proposing a task · Пропонує задачу | Proposed a task · Запропонував задачу | Could not propose a task · Задачу не запропоновано |
| `add_folder` | Adding a folder · Додає теку | Added a folder · Додав теку | Could not add the folder · Теку не додано |
| `browser_open` | Opening the page · Відкриває сторінку | Opened the page · Відкрив сторінку | Could not open the page · Сторінку не відкрито |
| `browser_read` | Reading the page · Читає сторінку | Read the page · Прочитав сторінку | Could not read the page · Сторінку не прочитано |
| `browser_console` | Reading the page console · Читає консоль сторінки | Read the page console · Прочитав консоль сторінки | Could not read the page console · Консоль сторінки не прочитано |
| `browser_screenshot` | Taking a page screenshot · Знімає сторінку | Took a page screenshot · Зняв сторінку | Could not take a page screenshot · Знімок сторінки не зроблено |
| `browser_ui` | Reading the page elements · Читає елементи сторінки | Read the page elements · Прочитав елементи сторінки | Could not read the page elements · Елементи сторінки не прочитано |
| `browser_act` | Clicking · Клікає (and other verbs per action) | Clicked · Клікнув | Could not act on the page · Дію на сторінці не виконано |
| `simulator_open` | Starting the simulator · Запускає симулятор | Started the simulator · Запустив симулятор | Could not start the simulator · Симулятор не запущено |
| `simulator_act` | Tapping · Торкається (and other verbs per action) | Tapped · Торкнувся | Could not act on the simulator · Дію на симуляторі не виконано |
| `simulator_screenshot` | Taking a simulator screenshot · Знімає екран симулятора | Took a simulator screenshot · Зняв екран симулятора | Could not take a simulator screenshot · Знімок екрана не зроблено |
| `pr_comment` | Writing a draft comment · Пише чернетку коментаря | Left a draft comment · Залишив чернетку коментаря | Could not save the draft comment · Чернетку коментаря не збережено |
| `editor_state` | Reading the editor · Читає редактор | Read the editor · Прочитав редактор | Could not see your editor · Редактор не прочитано |

Other browser and simulator tools follow the same pattern; their exact strings are in `messages.ts`.
Worker states in the second line: `in the queue` / «у черзі», `waits for you` / «чекає тебе»,
`finished` / «завершено» (not «готово»), `stopped with an error` / «з помилкою», `at the limit` / «на ліміті».

## Time and numbers

**Duration** is how long something took. It stands next to an operation (a chat row, a turn footer).
English keeps the unit tight; Ukrainian puts the unit after a narrow no-break space (U+202F).

| | English | Ukrainian |
|---|---|---|
| milliseconds | `600ms` | `600 мс` |
| seconds < 10 | `8.4s` | `8,4 с` |
| seconds ≥ 10 | `12s` | `12 с` |
| minutes | `2m 4s` | `2 хв 4 с` |

**Age** is how much time has passed. It appears in lists that the eye scans (board, tooltips, lock age).
Both languages put the unit as a separate word.

| English | Ukrainian |
|---|---|
| `3 min` | `3 хв` |
| `2 hr` | `2 год` |
| `1 d` | `1 дн` |

Only durations under 10 s have a fractional part. A whole number never gets one (`12 с`, not `12,0 с`).
Abbreviated units take no plural forms. While a duration is unknown, show nothing, not zero.

**Numbers follow the interface language, not the system region.** The decimal separator, the thousands
separator, and the percent sign come from the selected UI language: a Ukrainian window on a US region writes
`8,4 с`, an English window on a Ukrainian region writes `8.4s`.

**Exception: the `+N −M` change counter from 1,000.** The short form is the same in both languages: a dot,
the suffix `k` or `M` with no space, one digit after the dot truncated (not rounded), no `.0`:
`+5k −2.4k`, `+1.2M`. The exact value in the tooltip and accessible name follows the locale:
`+5 036 −2 480` / `+5,036 −2,480`.

**Limits always show what is left,** not what is used: `{n}% left` / «{n}% лишилось».

## What is not localized

Terminal output. Diff contents. Branch names and paths. Repo names. Task titles that the agent writes.
Logs. Permission card button labels, because the agent sends them in `request_permission`.

Prompts to the agent, the XML framing of a review, and the injected repo manifest are always in English.
The text of user comments can be in any language.
