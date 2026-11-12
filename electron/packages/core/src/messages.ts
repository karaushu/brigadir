import { formatTokenCount } from './change-count';
const uk = {
	// spec/search-menus-and-commands#search-tabs: Search Everywhere — All, Text, PR, Actions.
	in: 'у',
	line: 'рядок',
	'PR open': 'Відкритий',
	'PR draft': 'Чернетка',
	'PR merged': 'Змерджено',
	'PR closed': 'Закрито',
	'Find in Files…': 'Знайти в файлах…',
	'Find Action…': 'Знайти дію…',
	Text: 'Текст',
	PR: 'PR',
	'All repos': 'Усі repo',
	'Change shortcut': 'Змінити поєднання',
	'Invalid regular expression': 'Неправильний регулярний вираз',
	'Line to chat': 'Рядок у чат',
	Mask: 'Маска',
	'Match case': 'Враховувати регістр',
	'Whole word': 'Ціле слово',
	'Regular expression': 'Регулярний вираз',
	'Next file': 'Наступний файл',
	'No task is open: searching the main tree of': 'Пошук в основному дереві',
	'Nothing found for «{query}»': 'Нічого не знайдено за «{query}»',
	'Open at the line': 'Відкрити на рядку',
	'Open in Settings': 'Відкрити в налаштуваннях',
	'Open in the PR panel': 'Відкрити в панелі PR',
	'Open in the main tree': 'Відкрити в основному дереві',
	Options: 'Параметри',
	'Searching further…': 'Пошук далі…',
	'Select a project': 'Вибери проєкт',
	'Show task': 'Показати задачу',
	'Showing the first 2,000 matches': 'Показано перші 2 000 збігів',
	'Tasks, files, text, PR, actions…': 'Задачі, файли, текст, PR, дії…',
	'Type to search the text of the files': 'Пошук у вмісті файлів',
	'Whole group': 'Уся група',
	'in the file': 'у файлі',
	'no matches': 'збігів немає',
	of: 'з',
	'searching the text…': 'пошук у тексті…',
	'searching…': 'пошук…',
	'Searched tasks of every project, files, text, PR, actions and settings.':
		'Перевірено задачі всіх проєктів, файли, текст, PR, дії й налаштування.',
	'Searched tasks of every project, files, text, actions and settings.':
		'Перевірено задачі всіх проєктів, файли, текст, дії й налаштування.',
	'Recently opened': 'Нещодавні',
	'Toggle the setting': 'Перемкнути',
	'Run the action': 'Виконати',
	'Set up…': 'Налаштувати…',
	Prompt: 'Промпт',
	check: 'перевірка',
	'Remove check': 'Прибрати перевірку',
	'Templates…': 'Шаблони…',
	Templates: 'Шаблони',
	Crews: 'Бригади',
	'Agent templates': 'Шаблони агентів',
	'Empty agent…': 'Порожній агент…',
	'For a branch': 'для гілки',
	'Save as crew template': 'Зберегти як шаблон бригади',
	'Save as agent template': 'Зберегти як шаблон агента',
	'Save branch as template': 'Зберегти гілку як шаблон',
	'Remove agent': 'Прибрати агента',
	'Remove with subordinates': 'Прибрати з підлеглими',
	Duplicate: 'Дублювати',
	'Import…': 'Імпортувати…',
	'Export…': 'Експортувати…',
	'New agent': 'Новий агент',
	'New crew': 'Нова бригада',
	'New template…': 'Новий шаблон…',
	Zone: 'Зона',
	Subordinates: 'Підлеглі',
	'Checked by': 'Перевіряють',
	nobody: 'ніхто',
	'nobody · the foreman accepts the branch': 'ніхто · гілку приймає бригадир',
	none: 'немає',
	'whole project · name folders': 'весь проєкт · вкажи теки',
	'parent zone': 'зона батька',
	Specialty: 'Спеціалізація',
	'What the foreman reads about this agent. In English.': 'Англійською.',
	own: 'своє',
	'has subordinates': 'має підлеглих',
	'read only': 'лише читання',
	'only this agent': 'лише цей агент',
	'from the catalog': 'з каталогу',
	'the catalog appears after the first launch': 'каталог зʼявиться після першого запуску',
	'Template instructions «{name}»': 'Інструкції шаблону «{name}»',
	'Additionally for {name}': 'Додатково для {name}',
	'What this agent does differently from the template. In English.':
		'Додаткові інструкції, англійською.',
	'Has subordinates: it gets the foreman tools in its zone: split, delegate, read reports and diffs, accept. It writes no code itself. Remove the subordinates and the template comes back.':
		'Керує підлеглими у своїй зоні. Код не пише. Без підлеглих використовує початковий шаблон.',
	'delegates and accepts': 'делегує й приймає',
	'checks directly, up to 2 rounds, then up': 'до 2 перевірок, потім передача ліду',
	'«+» under an agent adds a subordinate. Drag an agent onto an agent to add a check.':
		'Перетягни агента на агента, щоб додати перевірку.',
	'Select an agent in the tree': 'Вибери агента в дереві',
	'A branch deeper than two levels. Each level is one more relay and one more context.':
		'Понад два рівні. Кожен рівень додає передачу контексту.',
	'Instructions here add to the briefing, they do not replace it.': 'Доповнюють брифінг.',
	Rights: 'Права',
	Checker: 'Перевіряльник',
	'writes no code · read_report · read_diff · submit_review · approve on the agents it checks':
		'Читає звіти й зміни, надсилає ревʼю та схвалює роботу. Код не пише.',
	Instructions: 'Інструкції',
	'in English: who you are, not what to do': 'Роль агента, англійською',
	'Model «{model}» is unavailable in {provider} — {agent} starts with the provider default.':
		'Модель «{model}» недоступна в {provider} — {agent} стартує з дефолтом провайдера.',
	'The template could not be saved.': 'Не вдалося зберегти шаблон.',
	'Edit…': 'Редагувати…',
	'Remove?': 'Прибрати?',
	Foreman: 'Бригадир',
	Developer: 'Розробник',
	'Developer 1': 'Розробник 1',
	'Developer 2': 'Розробник 2',
	'Senior developer': 'Старший розробник',
	Tester: 'Тестувальник',
	'Technical writer': 'Технічний письменник',
	Designer: 'Дизайнер',
	'Security reviewer': 'Ревʼюер безпеки',
	'Crew with tests': 'Бригада з тестами',
	'Splits the work, accepts the parts': 'Ділить роботу, приймає частини',
	'Parts with a clear spec': 'Частини з чіткою специфікацією',
	'Migrations, refactors, unclear specs': 'Міграції, рефактори, нечіткі специфікації',
	Role: 'Роль',
	'No role': 'Без ролі',
	'Checks the work, writes no code': 'Перевіряє роботу, коду не пише',
	'Writes code': 'Пише код',
	'Default model': 'Типова модель',
	'Writes tests, changes no production code': 'Пише тести, робочий код не змінює',
	'Writes docs, changes no behaviour': 'Пише документацію, поведінку не змінює',
	'Checks screens in the running app': 'Перевіряє екрани в запущеному застосунку',
	'Looks for security defects in changes': 'Шукає дефекти безпеки у змінах',
	'Strongest model · Medium': 'Найсильніша модель · Medium',
	'Faster model · Medium': 'Швидша модель · Medium',
	'Strong model · High': 'Сильна модель · High',
	"Author's model or stronger": 'Модель автора або сильніша',
	'Best for': 'Найкраще для',
	'Clear parts': 'Чіткі частини',
	'Hard parts': 'Складні частини',
	'Leading and checking': 'Керування й перевірка',
	'An effort above High costs about as much as a stronger model.':
		'Effort вище High коштує приблизно як сильніша модель.',
	'Subagent model': 'Модель субагентів',
	'Same as the agent': 'Як в агента',
	"Claude's own subagents search and read on this model.":
		'На цій моделі власні субагенти Claude шукають і читають.',
	Reviewer: 'Ревʼюер',
	'The plan has no parts.': 'У плані немає частин.',
	'No agent named {agent}. Crew agents: {agents}.':
		'Немає агента {agent}. Агенти бригади: {agents}.',
	'{agent} is a reviewer and takes no part of the code.':
		'{agent} перевіряє код і не виконує частини плану.',
	'{agent} already has part {n}. One agent works on one part at a time.':
		'{agent} уже має частину {n}. Один агент працює над однією частиною за раз.',
	'{agent} owns {zone}; outside the zone: {files}.': '{agent} володіє {zone}; поза зоною: {files}.',
	'{agent} has no part.': '{agent} без частини.',
	'assigned to': 'виконує',
	'Whole prompt': 'Весь промпт',
	'Collapse prompt': 'Згорнути промпт',
	'Edit prompt': 'Редагувати',
	'{names} checks each': '{names} перевіряє кожну',
	'{names} check each': '{names} перевіряють кожну',
	'Part {n}: differences with the crew. Start waits for a fix.':
		'Частина {n} не відповідає бригаді. Виправ перед запуском.',
	'Parts {n}: differences with the crew. Start waits for a fix.':
		'Частини {n} не відповідають бригаді. Виправ перед запуском.',
	'Every part needs a title and a prompt.': 'Кожній частині потрібні назва й промпт.',
	'the foreman will make a new plan': 'бригадир складе новий план',
	Plan: 'План',
	done: 'виконано',
	'Plan parts': 'Частини плану',
	// spec/crew#compose: the foreman composes the crew and proposes it with the plan.
	'Foreman composes': 'Бригадир збере',
	'Crew templates': 'Шаблони бригад',
	'Crew members': 'Склад',
	'Edit crew…': 'Редагувати склад…',
	edited: 'змінено',
	'checks {names}': 'перевіряє {names}',
	'crew from the foreman': 'склад від бригадира',
	'Could not apply the edited crew.': 'Не вдалося застосувати змінений склад.',
	'The templates could not be read.': 'Не вдалося прочитати шаблони.',
	'The foreman is already working: its settings stay.':
		'Бригадир уже працює: його налаштування не змінюються.',
	'The foreman proposes a split': 'Бригадир пропонує розбиття',
	'Start workers': 'Запустити воркерів',
	'Plan approved': 'План погоджено',
	'Plan rejected': 'План відхилено',
	'The plan does not match the crew.': 'План не збігається з бригадою.',
	// spec/notifications-slack-notes-and-schedules#message-classes: the crew editor words each crewIssues code itself; the agent's name stands undeclined after the text.
	'The foreman cannot be checked.': 'Бригадира не можна перевіряти.',
	'Two agents have the same id: {name}.': 'Два агенти мають однаковий id: {name}.',
	'Two agents have the same name: {name}.': 'Два агенти мають однакову назву: {name}.',
	'The agent template is not found: {name}.': 'Шаблон агента не знайдено: {name}.',
	'The zone goes beyond the zone of the agent above: {name}.':
		'Зона виходить за зону агента рівнем вище: {name}.',
	'A reviewer cannot have subordinates: {name}.': 'Ревʼюер не може мати підлеглих: {name}.',
	'An agent cannot check itself: {name}.': 'Агент не може перевіряти сам себе: {name}.',
	'The same checker is added twice: {name}.': 'Того самого перевіряльника додано двічі: {name}.',
	'The checker is not under the same lead: {name}.':
		'Перевіряльник не під тим самим лідом: {name}.',
	'Only a reviewer can check: {name}.': 'Перевіряти може лише ревʼюер: {name}.',
	'Only a developer can be checked: {name}.': 'Перевіряти можна лише розробника: {name}.',
	'Could not add the check: the agents are under different leads.':
		'Не вдалося додати перевірку: агенти під різними лідами.',
	Part: 'Частина',
	report: 'звіт',
	note: 'нотатка',
	question: 'питання',
	worker: 'воркер',
	'merge aborted, part withdrawn': 'мердж скасовано, частину знято',
	accepted: 'прийнято',
	stopped: 'зупинено',
	'waiting for the foreman': 'чекає бригадира',
	'answered by the foreman': 'відповів бригадир',
	'answered by you': 'твоя відповідь',
	approved: 'схвалено',
	disputed: 'спір',
	'round {n} of 2': 'коло {n} з 2',
	'outside the zone: {n}': 'поза зоною: {n}',
	'new notes: {n}': 'нових нотаток: {n}',
	'The foreman did not answer in five minutes. You can answer for it.':
		'Бригадир не відповів за 5 хвилин. Можеш відповісти замість нього.',
	'Merge conflicts: {files}': 'Конфлікти merge: {files}',
	'The worker stopped: {reason}': 'Воркер зупинився: {reason}',
	'Collapse crew': 'Згорнути бригаду',
	'Expand crew': 'Розгорнути бригаду',
	'Completed · {n}': 'Завершені · {n}',
	'Collapse completed': 'Згорнути завершені',
	'Expand completed': 'Розгорнути завершені',
	Workers: 'Воркери',
	'Workers working now': 'Активні воркери',
	checks: 'перевіряє',
	'Own template': 'Свій шаблон',
	'Levels: {n}': 'Рівні: {n}',
	'no branch · queued': 'без branch · черга',
	'Saving…': 'Збереження…',
	'Rename task…': 'Перейменувати задачу…',
	'Rename task': 'Перейменувати задачу',
	'Task title': 'Назва задачі',
	'Pin task': 'Закріпити задачу',
	'Unpin task': 'Відкріпити задачу',
	Pinned: 'Закріплено',
	'Rate limited': 'Ліміт вичерпано',
	'Subscription limit reached.': 'Досягнуто ліміту підписки.',
	'Reset time is unavailable. Waiting for the provider.':
		'Час скидання невідомий. Очікуємо даних провайдера.',
	'Resets in {minutes} min': 'Скидання за {minutes} хв',
	'Queued messages will resume after the reset.':
		'Надсилання з черги відновиться після скидання ліміту.',
	'Agents in work': 'Активні агенти',
	'Waiting for a prompt': 'Чекає промпт',
	'No live agents': 'Немає активних агентів',
	'Some agents could not be read.': 'Не вдалося отримати дані частини агентів.',
	'Agent actions': 'Дії агента',
	'Kill process…': 'Завершити примусово…',
	'Kill process': 'Завершити примусово',
	'End this session?': 'Завершити цю сесію?',
	'Stop the turn; keep the session alive.': 'Зупиняє турн без завершення сесії.',
	'Live sessions across all projects': 'Активні сесії всіх проєктів',
	'Stop all': 'Зупинити всіх',
	'Open Recent': 'Недавні проєкти',
	'Clear Recent': 'Очистити список недавніх',
	'No recent projects': 'Немає недавніх проєктів',
	'Recent projects could not be read.': 'Не вдалося прочитати недавні проєкти.',
	'The project could not be opened.': 'Не вдалося відкрити проєкт.',
	Unreviewed: 'Непроглянуті зміни',
	'Filter by status': 'Фільтр за станом',
	'All tasks': 'Усі задачі',
	'Collapse project': 'Згорнути проєкт',
	'Expand project': 'Розгорнути проєкт',
	'Current file': 'Поточний файл',
	'Project knowledge…': 'Знання проєкту…',
	'Project knowledge': 'Знання проєкту',
	'Repeated question': 'Повторне запитання',
	'Add the answer to the project instructions so future tasks can use it.':
		'Додай відповідь в інструкції для наступних задач.',
	'Show text': 'Показати текст',
	Reject: 'Відхилити',
	Add: 'Додати',
	Addition: 'Доповнення',
	Destination: 'Куди',
	'Instruction file': 'Файл інструкцій',
	'At the end of the file': 'У кінець файлу',
	Sources: 'Джерела',
	'An agent writes this text using your subscription. You can edit it before adding.':
		'Використовує підписку.',
	'Refresh the preview': 'Оновити перегляд',
	'The file changed. Review it again.': 'Файл змінився. Переглянь його ще раз.',
	'Choose a text file smaller than 128 KB.': 'Вибери текстовий файл розміром до 128 КБ.',
	'The proposal is no longer available': 'Пропозиція вже недоступна',
	'Review the destination again.': 'Переглянь місце запису ще раз.',
	'The agent did not return an addition.': 'Агент не надав доповнення.',
	'Enter the addition.': 'Введи доповнення.',
	'Added to': 'Додано у',
	'Uncommitted change': 'Незакомічена зміна',
	'Show the file': 'Показати файл',
	'Rejected proposals': 'Відхилені пропозиції',
	'No rejected proposals': 'Немає відхилених пропозицій',
	Restore: 'Повернути',

	'New file': 'Новий файл',
	Collapse: 'Згорнути',

	'Prompt suggestion': 'Підказка промпту',
	'Suggest the next prompt': 'Підказувати наступний промпт',
	'CLI updates': 'Оновлення CLI',
	'Update in the background': 'Оновлювати у фоні',
	'Check now': 'Перевірити зараз',
	'Checking…': 'Перевірка…',
	'Not checked yet': 'Ще не перевірено',
	'Checked {time} · no new versions': 'Перевірено {time} · нових версій немає',
	'{agent} updated to {version}': '{agent} оновлено до {version}',
	'{agent} to {version}': '{agent} — до {version}',
	'Could not update {agent}': 'Не вдалося оновити {agent}',
	'today at {time}': 'сьогодні о {time}',
	'yesterday at {time}': 'вчора о {time}',
	'{date} at {time}': '{date} о {time}',
	// spec/architecture-and-platform#auto-update: Brigadir's own updates — the menu item, Settings ▸ Language ▸ Updates and the toasts.
	'Check for Updates…': 'Перевірити оновлення…',
	Updates: 'Оновлення',
	'Download in the background': 'Завантажувати у фоні',
	'Restart to update': 'Перезапустити й оновити',
	'Download update': 'Завантажити оновлення',
	'Cancel restart': 'Скасувати перезапуск',
	'Brigadir {version} is ready': 'Бригадир {version} готовий до встановлення',
	'Brigadir {version} is available': 'Доступний Бригадир {version}',
	'Brigadir is up to date': 'Встановлено останню версію Бригадира',
	'Could not check for updates.': 'Не вдалося перевірити оновлення.',
	'Could not download the update.': 'Не вдалося завантажити оновлення.',
	'Could not install the update.': 'Не вдалося встановити оновлення.',
	'Downloading {version}… {percent}%': 'Завантаження {version}… {percent}%',
	'Version {version}': 'Версія {version}',
	'checked {time}': 'перевірено {time}',
	'This build does not check for updates.': 'Ця збірка не перевіряє оновлення.',
	'Turns running: {count}. Brigadir restarts when they end.':
		'Турнів у роботі: {count}. Бригадир перезапуститься, коли вони завершаться.',
	'Mac sleep': 'Без сну',
	'Keep the Mac awake while agents work': 'Тримати компʼютер активним, поки працюють агенти',
	'The display still sleeps; closing a laptop lid still puts the Mac to sleep.':
		'Екран може вимикатися. Сон при закритті кришки визначає система.',
	'Now working: {count} — the Mac stays awake.': 'У роботі: {count}',
	// spec/appearance#evolution-redesign: the Helper agent (spec/composer-steering-queue-and-ghost#ghost-headless) and its in-place capsule.
	'Helper agent': 'Помічник',
	'Short one-off jobs: PR summaries, commit and PR texts, branch names, prompt suggestions. Change it for one run where you start it.':
		'Короткі разові дії: підсумки PR, тексти комітів і PR, назви гілок, підказки промпту.',
	'New tasks, Review with an agent, Agent fixes it, resolving conflicts.':
		'Нові задачі, ревʼю з агентом, виправлення агентом, розвʼязання конфліктів.',
	'Written by the helper agent.': 'Пише помічник.',
	'Only this time. Default: Helper agent in Settings ▸ Agents.':
		'Лише цього разу. Типово — помічник у Налаштування ▸ Агенти.',
	'Only this review. Default: Default agent.': 'Лише для цього ревʼю. Типово — типовий агент.',
	'Summary agent': 'Агент підсумку',
	// spec/appearance#evolution-redesign: an agent per action — Settings ▸ Agents ▸ Customize per action and `Remember for …` in the capsule.
	'Customize per action': 'Налаштувати для кожної дії',
	'One-off texts': 'Разові тексти',
	'Suggestions in review': 'Пропозиції в ревʼю',
	'And the verdict hint': 'І підказка вердикту',
	'PR title and description': 'Назва й опис PR',
	'Prompt hint': 'Підказка промпту',
	'Same as Default agent': 'Як типовий агент',
	'Same as Helper agent': 'Як помічник',
	'Reset all': 'Скинути все',
	'Saved in Settings ▸ Agents.': 'Збережено в Налаштування ▸ Агенти.',
	'Remember for reviews with an agent': 'Запамʼятати для ревʼю з агентом',
	'Remember for agent suggestions in review': 'Запамʼятати для пропозицій у ревʼю',
	// spec/pull-requests-and-ci#review-crew: review by a crew — the Agent · Crew switch of «Review with an agent ▾».
	'Agent · Crew': 'Агент · Бригада',
	'No crews': 'Бригад немає',
	'Settings ▸ Templates': 'Налаштування ▸ Шаблони',
	'Only this review. The foreman merges the findings.': 'Лише для цього ревʼю.',
	'Remember for PR summaries': 'Запамʼятати для підсумків PR',
	'Remember for commit messages': 'Запамʼятати для повідомлень комітів',
	'Remember for PR titles and descriptions': 'Запамʼятати для назв і описів PR',
	'Remember for splitting with the agent': 'Запамʼятати для поділу з агентом',
	lowest: 'найнижчий',
	'Agent for this run': 'Агент для цього запуску',
	'· off': '· вимкнено',
	'Catalog unavailable': 'Каталог недоступний',
	'{provider} is off. The helper uses {model}.': '{provider} вимкнено. Помічник: {model}.',
	'Model “{model}” is unavailable in {provider}. The helper uses {default}.':
		'Моделі «{model}» немає в {provider}. Помічник: {default}.',
	'{provider} is off. Helper jobs are unavailable.':
		'{provider} вимкнено. Дії помічника недоступні.',
	Title: 'Заголовок',
	'GitHub status could not be read.': 'Не вдалося прочитати стан GitHub.',
	'Install GitHub CLI (gh) to create pull requests.':
		'Установи GitHub CLI (gh), щоб створювати PR.',
	'Sign in with gh auth login to use GitHub.':
		'Увійди через gh auth login, щоб користуватися GitHub.',
	'GitHub is unavailable': 'GitHub недоступний',
	'Push commits': 'Відправити коміти',
	Checks: 'Checks',
	Merged: 'Змерджено',
	Closed: 'Закрито',
	'A branch will be created automatically.': 'Branch буде створено автоматично.',
	'Uncommitted changes stay local and are not included in this PR.':
		'Незакомічені зміни залишаться локально й не ввійдуть у цей PR.',
	'Create PR': 'Створити PR',
	'Create branch…': 'Створити branch…',
	'Commits to push': 'Коміти для відправлення',
	'Update branch': 'Оновлення branch',
	'First push': 'Перший push',
	'Showing the most recent 100 commits.': 'Показано останні 100 комітів.',
	'New pull request': 'Новий PR',
	'Create branch': 'Створити branch',
	'This push updates PR': 'Цей push оновить PR',
	Description: 'Опис',
	Generate: 'Згенерувати',
	'Generate the title and description': 'Згенерувати заголовок і опис',
	'The description could not be generated. You can edit it and create the PR.':
		'Не вдалося згенерувати опис. Введи його вручну й створи PR.',
	'Submodule commits must be available upstream before merging:':
		'Перед злиттям коміти submodule мають бути доступні у віддаленому репозиторії:',
	'Create a branch, commit your changes, then create the PR.':
		'Створи branch, закоміть зміни, а потім створи PR.',
	passed: 'пройшло',
	failed: 'помилка',
	pending: 'триває',
	skipped: 'пропущено',
	cancelled: 'скасовано',
	'No checks': 'Перевірок немає',
	'This pull request has merge conflicts.': 'Цей PR має конфлікти злиття.',
	'Open on GitHub': 'Відкрити на GitHub',
	'Open PR': 'Відкрити PR',
	'Open form in browser': 'Відкрити форму в браузері',
	'Working…': 'Виконання…',
	Push: 'Відправити',
	'No origin remote': 'Немає remote origin',
	'Commit changes first': 'Спочатку закоміть зміни',
	'Create a branch first': 'Спочатку створи branch',
	'Base branch is unavailable': 'Базова branch недоступна',
	'No commits ahead of base': 'Немає комітів попереду базової branch',
	'A pull request is already open': 'PR уже відкритий',
	// spec/pull-requests-and-ci#from-into: the `From → Into` pickers of the «New pull request» dialog; `Into` is the merge dialog's.
	From: 'Звідки',
	'Choose different branches': 'Вибери різні branch',
	// spec/pull-requests-and-ci#ready-card: «New PR» in the PR panel's header and the card of a branch ready for a PR.
	'New PR': 'Новий PR',
	'Ready for a PR': 'Готові до PR',
	'Hide until the next push': 'Сховати до наступного push',
	'pushed {time} ago': 'push {time} тому',
	'pushed just now': 'push щойно',
	'pushed yesterday': 'push вчора',

	Commit: 'Коміт',
	'Commit message': 'Повідомлення коміту',
	'Committing…': 'Створення коміту…',
	Committed: 'Закомічено',
	'Generate message': 'Згенерувати',
	'Generating…': 'Генерація…',
	'Generate again': 'Згенерувати ще раз',
	'Commit preview': 'Перегляд коміту',

	'Wait for the agent to finish before committing':
		'Зачекай завершення роботи агента перед комітом',

	'Continue in a new task': 'Продовжити в новій задачі',
	'Continuation of': 'Продовження ←',
	'Continued in': 'Продовжено в →',
	'Task summary': 'Підсумок задачі',
	'Task diff': 'Зміни задачі',
	'Full patch': 'Повний патч',
	'As in': 'Як у',
	'Generating summary…': 'Підготовка підсумку…',
	'The summary could not be generated. You can start without it.':
		'Не вдалося підготувати підсумок. Можна запустити задачу без нього.',
	'Try again': 'Спробувати ще раз',
	'Remove summary': 'Прибрати підсумок',
	'Remove diff': 'Прибрати зміни',
	'The patch was shortened to fit the attachment limit.': 'Патч скорочено до ліміту вкладення.',
	'Previous task unavailable': 'Попередня задача недоступна',
	'Related tasks': 'Повʼязані задачі',

	Repos: 'Repo',
	'Shown repos': 'Repo зі змінами',
	'Project defaults': 'Типові параметри проєкту',
	'Stop the task before changing write access.': 'Зупини задачу перед зміною прав запису.',
	Writable: 'Читання й запис',
	'Read-only': 'Лише читання',
	'read-only': 'лише читання',
	'Repo actions': 'Дії repo',
	// spec/task-window#repo-line: the lock of a repo another task holds; entering the main tree from the project menu.
	Busy: 'Зайнято',
	'Open main tree': 'Відкрити основне дерево',
	'Could not open the main tree.': 'Не вдалося відкрити основне дерево.',
	// spec/projects-and-board#repo-selection: a repo is either in the task or not.
	'Add to the task': 'Додати в задачу',
	'Remove from the task…': 'Прибрати із задачі…',
	'Outside the task': 'Поза задачею',
	'outside the task': 'поза задачею',
	'Stop the task before changing its repos.': 'Зупини задачу перед зміною repo.',
	// spec/projects-and-board#external-folders: a folder from outside the project, with or without git.
	'Add folder…': 'Додати теку…',
	'no git': 'без git',
	'Repos and folders': 'Repo і теки',
	'The folder is unavailable': 'Тека недоступна',
	// spec/tasks#sheet-layout, spec/tasks#sheet-footer: the launch sheet in two columns.
	from: 'від',
	'file, agent or someone from the crew': 'файл, агент або учасник бригади',
	Mention: 'Згадка',
	'Slash commands': 'Slash-команди',
	'Commands appear once the agent starts': 'Команди доступні після запуску агента',
	Skills: 'Скіли',
	'MCP tools': 'MCP-інструменти',
	'skill (kind)': 'скіл',
	'slash command (kind)': 'slash-команда',
	'MCP tool (kind)': 'MCP-інструмент',
	'Works only as the first word of the message.': 'Лише на початку повідомлення.',
	Actions: 'Дії',
	'MCP server': 'MCP-сервер',
	'Preliminary list: the agent has not started': 'Попередній список. Агент не запущено.',
	'Browser screenshot': 'Знімок браузера',
	'Simulator screenshot': 'Знімок симулятора',
	'Worktree actions': 'Дії worktree',
	'Remove worktree…': 'Прибрати worktree…',
	'Remove the worktree?': 'Прибрати worktree?',
	Remove: 'Прибрати',
	"The task's copy of the repos will be removed. Branches and commits stay, and the next start prepares a new worktree.":
		'Копії repo буде видалено. Branch і коміти зберігаються. Наступний запуск створить worktree.',
	'Stop the task before removing its worktree.': 'Зупини задачу, перш ніж прибирати її worktree.',
	'The agent may write to this repo': 'Агент може писати в це репо',
	'Hidden from the diff': 'Поза змінами',
	'Push commits…': 'Відправити коміти…',
	'Create PR…': 'Створити PR…',
	'Checks…': 'Checks…',
	'Open first change': 'Відкрити першу зміну',
	'A repo found after setup comes in read-only.':
		'Нові repo після налаштування доступні лише для читання.',

	'Detached HEAD': 'Detached HEAD',
	'No repositories': 'Немає репозиторіїв',
	'Repo warnings': 'Попередження repo',
	'A read-only repo changed.': 'Змінився repo лише для читання.',
	'Repo locks could not be read.': 'Не вдалося перевірити блокування repo.',
	'Repo is busy': 'Repo зайнятий',
	'is busy with the task': 'зайнятий задачею',
	'It took the lock {minutes} min ago.': 'Заблоковано {minutes} хв тому.',
	'Isolate in a worktree': 'Ізолювати у worktree',
	'Wait in queue': 'Стати в чергу',
	'Work despite the lock': 'Працювати попри лок',
	'Waiting for the lock': 'Чекає звільнення repo',
	// spec/agents-and-providers#tools-awareness: the line of a crew worker queued for the project's one simulator device.
	'Waiting for the simulator': 'Чекає симулятор',
	'This task has already used its workspace. Create a new task to use a worktree.':
		'Ця задача вже працювала у своєму середовищі. Щоб використати worktree, створи нову задачу.',
	'The task works in its own copy of every repo and takes no locks. Preparation takes longer, because each repository gets a branch and the setup command runs.':
		'Окремі копії repo без блокувань. Створення branch і команда підготовки подовжують запуск.',
	'The task waits and starts by itself when the lock is free. If the task that holds the lock dies, the queue notices within 3 seconds.':
		'Запуск після звільнення repo. Збій іншої задачі виявляється протягом 3 секунд.',
	'Both tasks write to one repo. The diff of this task will show the changes of the other one, and the other way round. While this lasts, the repo is marked contended and both diffs carry a warning.':
		'Обидві задачі змінюють один repo. Їхні зміни змішуються; обидві показують попередження.',
	// spec/notifications-slack-notes-and-schedules#repo-contention: a contended repo is a chip (composer footer, Changes heading) with a popover, not a banner.
	'Mixed changes': 'Змішані зміни',
	'{repo} · mixed changes': '{repo} · змішані зміни',
	'{repos} · mixed changes': '{repos} · змішані зміни',
	'Mixed changes: {repos}': 'Змішані зміни: {repos}',
	'this task': 'ця задача',
	'Got it': 'Зрозуміло',
	'The tasks write to one repo without isolation. Each diff also shows the others’ changes.':
		'Задачі змінюють один repo без ізоляції. Кожен диф містить зміни всіх задач.',
	'Opened because another task writes to this repo.':
		'Автоматично відкрито через запис іншої задачі в repo.',
	'Opens by itself when another task joins the repo.':
		'Відкривається, коли інша задача починає запис у repo.',

	'Running setup…': 'Налаштування…',
	'Creating working copies…': 'Створення робочих копій…',
	'Setup log': 'Журнал налаштування',
	'No setup output yet.': 'Виводу налаштування ще немає.',
	'Preparing…': 'Підготовка…',
	'Preparing workspace': 'Підготовка середовища',
	'Cancel preparation': 'Скасувати підготовку',
	'Preparation failed': 'Підготовка не вдалася',
	'Launch options': 'Параметри запуску',
	Isolation: 'Ізоляція',
	'No isolation': 'Без ізоляції',
	Worktree: 'Worktree',
	'Branch name': 'Назва branch',
	'Base ref': 'Базова ревізія',
	'Setup command': 'Команда підготовки',
	Repo: 'Repo',
	'Launch settings are saved for this project.': 'Зберігає параметри запуску для проєкту.',
	'Enter a valid ASCII branch name.': 'Введи коректну назву branch символами ASCII.',
	'A Git repository is required for worktree isolation.':
		'Для ізоляції у worktree потрібен Git-репозиторій.',
	Provider: 'Провайдер',
	'Launch in': 'Запускати в',
	'Close task': 'Закрити задачу',
	'Reopen closed tab': 'Відкрити закриту вкладку',
	'Jump to source': 'Перейти до файла',
	'Next agent mode': 'Наступний режим агента',
	// spec/notifications-slack-notes-and-schedules#notification-center: the notification center.
	Earlier: 'Раніше',
	'Mark all as read': 'Позначити все прочитаним',
	'Clear (notices)': 'Очистити',
	'Dismiss (notice)': 'Прибрати',
	'Answer (notice)': 'Відповісти',
	'Notification settings': 'Налаштування сповіщень',
	'No notifications': 'Немає сповіщень',
	'No unread notifications': 'Немає непрочитаних',
	'History is empty': 'Історія порожня',
	'{n} m': '{n} хв',
	'{n} h': '{n} год',
	'Next agent needing you': 'Наступний агент, що чекає відповіді',
	'Previous agent needing you': 'Попередній агент, що чекає відповіді',
	'Next document': 'Наступний документ',
	'Previous document': 'Попередній документ',
	'Toggle sidebar': 'Показати/сховати сайдбар',
	'Toggle the right side': 'Показати/сховати праву частину',
	'Toggle the editor': 'Показати/сховати редактор',
	'Hide the editor': 'Сховати редактор',
	'Show the editor': 'Показати редактор',
	'Hide the right side': 'Сховати праву частину',
	'Show the right side': 'Показати праву частину',
	'Hide panel': 'Сховати панель',
	'Hide sidebar': 'Сховати сайдбар',
	'Show sidebar': 'Показати сайдбар',
	'Filter tasks': 'Фільтр задач',
	Substitutions: 'Заміни',
	'Show Substitutions': 'Показати заміни',
	'Smart Quotes': 'Розумні лапки',
	'Smart Dashes': 'Розумні тире',
	'Text Replacement': 'Заміна тексту',
	Speech: 'Мовлення',
	'Start Speaking': 'Почати читання',
	'Stop Speaking': 'Зупинити читання',
	Edit: 'Правка',
	Cut: 'Вирізати',
	Copy: 'Копіювати',
	Paste: 'Вставити',
	'Paste and match style': 'Вставити й узгодити стиль',
	'Select all': 'Вибрати все',
	Window: 'Вікно',
	Minimize: 'Згорнути',
	Zoom: 'Змінити розмір',
	'Bring all to front': 'Усі вікна наперед',
	'Toggle full screen': 'Повноекранний режим',
	'Developer tools': 'Інструменти розробника',
	Theme: 'Тема',
	System: 'Системна',
	Light: 'Світла',
	Dark: 'Темна',
	Accent: 'Акцент',
	Blue: 'Синій',
	Indigo: 'Індиго',
	Purple: 'Фіолетовий',
	Pink: 'Рожевий',
	Teal: 'Бірюзовий',
	Yellow: 'Жовтий',
	Graphite: 'Графіт',
	Terminal: 'Термінал',
	Font: 'Шрифт',
	'System mono': 'Системний моно',
	Size: 'Розмір',
	'Line height': 'Висота рядка',
	'Scroll speed': 'Швидкість прокрутки',
	'Font weight': 'Насиченість',
	'Light weight': 'Світла',
	Regular: 'Звичайна',
	Medium: 'Середня',
	Semibold: 'Напівжирна',
	Ligatures: 'Лігатури',
	Interface: 'Інтерфейс',
	// spec/appearance#chat-text-size: Settings ▸ Appearance ▸ Chat — back to following the interface's size.
	'Match interface': 'Як в інтерфейсі',
	'System font': 'Системний шрифт',
	'Search fonts': 'Пошук шрифтів',
	'No fonts match': 'Шрифтів не знайдено',
	'This font is unavailable. Using the system font.': 'Шрифт недоступний. Застосовано системний.',
	'Installed fonts could not be loaded.': 'Не вдалося завантажити встановлені шрифти.',
	'This font is unavailable. Using system mono.':
		'Шрифт недоступний. Застосовано системний моноширинний.',
	'This font does not include every box-drawing character.':
		'У цьому шрифті бракує деяких символів для малювання рамок.',
	'Unavailable fonts: {fonts}. Using the system font.':
		'Недоступні шрифти: {fonts}. Використовується системний шрифт.',
	'Increase font size': 'Збільшити розмір шрифту',
	'Decrease font size': 'Зменшити розмір шрифту',
	'Reset font size': 'Скинути розмір шрифту',
	'Toolbar labels': 'Підписи кнопок',
	'Icons only': 'Лише іконки',
	'Icons and names': 'Іконки з назвами',
	'Compact toolbar. Hover over an icon to see its name.': 'Назви кнопок при наведенні.',
	'Names beside surface icons. Labels collapse in narrow windows.': 'У вузьких вікнах приховані.',
	'Interface language': 'Мова інтерфейсу',
	'Follow system': 'Як у системі',
	'Settings sections': 'Розділи налаштувань',
	'The language will change after restart.': 'Зміна мови потребує перезапуску.',
	Restart: 'Перезапустити',
	'The settings could not be loaded.': 'Не вдалося прочитати налаштування.',
	'The settings could not be saved.': 'Не вдалося зберегти налаштування.',
	'The app could not restart.': 'Не вдалося перезапустити застосунок.',
	'About Brigadir': 'Про Бригадир',
	Services: 'Служби',
	'Hide Brigadir': 'Сховати Бригадир',
	'Hide Others': 'Сховати інші',
	'Show All': 'Показати всі',
	'Quit Brigadir': 'Завершити Бригадир',

	'The agent exited with code {code}.': 'Агент завершив роботу з кодом {code}.',
	'The terminal could not be opened.': 'Не вдалося відкрити термінал.',
	'Starting {agent}…': 'Запускається {agent}…',
	'Opening terminal…': 'Відкривається термінал…',
	'Checking the saved session.': 'Перевірка збереженої сесії.',
	'The agent is starting in this task’s terminal.': 'Агент запускається в терміналі цієї задачі.',
	'Continue the saved agent session in the terminal.': 'Продовж збережену сесію в терміналі.',
	'Start the agent to work on this task in the terminal.': 'Запусти агента в терміналі задачі.',
	tokens: 'токенів',
	'The agent reports total context usage without a breakdown.': 'Без розбивки.',
	'This file was edited by you. There is no agent turn.': 'Твоя правка. Без турну агента.',
	'These lines were edited by you. There is no agent turn.': 'Твої правки. Без турну агента.',
	'will be deleted along with the general note. This cannot be undone.':
		'буде видалено разом із загальною нотаткою. Це не скасувати.',
	'will be deleted. This cannot be undone.': 'буде видалено. Це не скасувати.',
	'The review changed. Cancel and check the comments before deleting.':
		'Ревʼю змінилося. Скасуй видалення й перевір коментарі.',
	'The general note draft will be deleted. This cannot be undone.':
		'Чернетку загальної нотатки буде видалено. Це не скасувати.',
	'Review comments': 'Коментарі рев’ю',
	'No review comments yet': 'Ще немає коментарів рев’ю',
	'Select lines in the editor or diff to add a comment.':
		'Виділи код у редакторі чи дифі, щоб прокоментувати.',
	'Continue with a new agent': 'Продовжити з новим агентом',
	'Duplicate task…': 'Дублювати…',
	'Show task diff': 'Показати зміни',
	'Open task': 'Відкрити задачу',
	'Copy task title': 'Копіювати назву задачі',
	'Delete task…': 'Видалити задачу…',
	'Delete task': 'Видалити задачу',
	'Remove project…': 'Прибрати проєкт…',
	'Remove project': 'Прибрати проєкт',
	'Local history will move to Trash. Repository files will stay in place. Running agents and terminals will stop.':
		'Локальну історію буде перенесено до Смітника. Файли репозиторію залишаться на місці. Запущені агенти й термінали буде зупинено.',
	'Task worktrees will be removed; branches stay.':
		'Worktree задач буде прибрано, branch лишаються.',
	'Crew workers are deleted too: {n}.': 'Воркерів бригади теж буде видалено: {n}.',
	'Uncommitted changes in worktrees will be lost: {files}.':
		'Незакомічені зміни у worktree буде втрачено: {files}.',
	'Diff options': 'Параметри змін',
	'Compare snapshots': 'Порівняння знімків',
	'From first to latest snapshot': 'Від першого до останнього знімка',
	Navigate: 'Навігація',
	'Next tool or hunk': 'Наступний виклик або хунк',
	'Previous tool or hunk': 'Попередній виклик або хунк',
	'Next turn': 'Наступний турн',
	'Previous turn': 'Попередній турн',
	'Conversation turns': 'Турни розмови',
	'Expand conversation': 'Розгорнути розмову',
	'Collapse conversation': 'Згорнути розмову',
	'To latest': 'До останнього',
	'Only the last 128 KiB are shown.': 'Показано лише останні 128 KiB.',
	'Tool output': 'Вивід інструмента',
	'Tool output is unavailable.': 'Вивід інструмента недоступний.',
	'Copy response': 'Копіювати відповідь',
	'Turn actions': 'Дії турну',
	'Open current diff': 'Відкрити поточні зміни',
	'This file has no changes in the current snapshot.': 'У поточному знімку цей файл не має змін.',
	'Open link': 'Відкрити посилання',
	'Open in system browser': 'Відкрити в системному браузері',
	'Open in task browser': 'Відкрити в браузері задачі',
	'⌘+click opens the link': '{shortcut} відкриває посилання',
	'Copy link': 'Копіювати посилання',
	// spec/appearance#evolution-redesign: the menu of a PR list row.
	'Start review…': 'Почати ревʼю…',
	'Continue review…': 'Продовжити ревʼю…',
	'Copy branch name': 'Копіювати назву branch',
	'Copy message': 'Копіювати повідомлення',
	'Copy image': 'Копіювати зображення',
	'Copy code': 'Копіювати код',
	'Collapse code': 'Згорнути код',
	'Expand code': 'Розгорнути код',
	Code: 'Код',
	Copied: 'Скопійовано',
	'The text could not be copied.': 'Не вдалося скопіювати текст.',
	'Attach files': 'Прикріпити файли',
	'The files could not be attached. Check the attachment limits.':
		'Не вдалося прикріпити файли. Перевір ліміти вкладень.',
	'Pasted image': 'Вставлене зображення',
	'could not be opened': 'не вдалося відкрити',
	'The image could not be opened': 'Не вдалося відкрити зображення',
	'The attachment file is gone from the task data or has changed.':
		'Файла вкладення вже немає в даних задачі або його змінено.',
	'Previous image': 'Попереднє зображення',
	'Next image': 'Наступне зображення',
	'Message images': 'Зображення повідомлення',
	'Release to attach': 'Відпусти, щоб прикріпити',
	'Up to 10 files, 8 MB together; images up to 4 MB':
		'До 10 файлів, разом 8 МБ. Зображення до 4 МБ.',
	'The image could not be attached. Check the attachment limits.':
		'Не вдалося прикріпити зображення. Перевір ліміти вкладень.',
	'Up to 10 files, 8 MB total; images up to 4 MB.': 'До 10 файлів, разом 8 МБ. Зображення до 4 МБ.',
	'Agent options': 'Параметри агента',
	'Fast on': 'Fast on',
	'Fast off': 'Fast off',
	// spec/composer#agent-capsule: the capsule shows Fast only when it is on, so the segment is the name alone.
	Fast: 'Fast',
	'Task repos': 'Repo задачі',
	Compact: 'Компактно',
	Full: 'Повністю',
	'Capsule view': 'Вигляд капсули',
	On: 'Увімкнено',
	repos: 'repo',
	on: 'увімкнено',
	off: 'вимкнено',
	'Add context from files': 'Додати контекст із файлів',
	'Queued messages': 'Повідомлення в черзі',
	'The queue is paused.': 'Чергу призупинено.',
	'Resume queue': 'Продовжити чергу',
	'Add to queue': 'Додати в чергу',
	// spec/composer-steering-queue-and-ghost#steering-hold: send now or queue while the agent works.
	'Send now': 'Надіслати зараз',
	'To the queue': 'В чергу',
	'The agent sees it at its next step': 'Надсилання на наступному кроці агента',
	'Waits until the agent finishes': 'Надсилання після завершення турну',
	'Send now · ↩ · To the queue · {queue}': 'Надіслати зараз · ↩ · В чергу · {queue}',
	'↩ send now · {queue} to the queue': '↩ надіслати зараз · {queue} в чергу',
	'↩ send now': '↩ надіслати зараз',
	'↩ to the queue': '↩ в чергу',
	// spec/composer#agent-capsule: the empty composer teaches its keys; {send} and {newline} come from the keymap helper.
	'{send} send · {newline} new line · @ files · / commands':
		'{send} надіслати · {newline} новий рядок · @ файли · / команди',
	// spec/composer#agent-capsule: the context popover sends /compact.
	'Compact (conversation)': 'Стиснути',
	'Sends /compact: the agent summarises the conversation and frees context':
		'Стиснути розмову (/compact)',
	'Waiting for the agent': 'Чекає агента',
	'Arrives after you answer the request': 'Надсилання після відповіді на запит',
	'Edit message': 'Редагувати повідомлення',
	'Remove message': 'Прибрати повідомлення',
	'Edit queued message': 'Редагувати повідомлення в черзі',
	'Edit queued review': 'Редагувати ревʼю в черзі',
	'Remove queued message': 'Прибрати повідомлення з черги',
	'The draft cannot hold this queued message.': 'Це повідомлення не вміщується в чернетку.',
	'Comment location is unavailable.': 'Позиція коментаря недоступна.',
	'The chat draft could not be saved.': 'Не вдалося зберегти чернетку чату.',
	'The chat draft could not be read.': 'Не вдалося прочитати чернетку чату.',
	'The general note draft will also be removed.': 'Чернетку загальної нотатки також буде видалено.',
	'Delete all review comments?': 'Видалити всі коментарі ревʼю?',
	'Delete all': 'Видалити всі',
	'Remove file comments': 'Прибрати коментарі файла',
	'Show comments': 'Показати коментарі',
	'Review files': 'Файли ревʼю',
	'Unknown repository': 'Невідомий репозиторій',
	You: 'Ти',
	Pending: 'Очікує',
	Draft: 'Чернетка',
	'Base snapshot': 'Базовий знімок',
	'To composer': 'У композер',
	'Open terminal here': 'Відкрити термінал тут',
	'Copy relative path': 'Копіювати відносний шлях',
	'Copy absolute path': 'Копіювати абсолютний шлях',
	'Copy path:line': 'Копіювати шлях:рядок',
	'Hide console': 'Сховати консоль',
	'Hide browser': 'Сховати браузер',
	'Select result': 'Вибрати',
	'Open result': 'Відкрити',
	'Switch tab': 'Змінити вкладку',
	'Filter the tree': 'Фільтр файлів',
	'Open Changes': 'Відкрити Зміни',
	'Hide ignored files': 'Сховати ігноровані файли',
	'Ignored files are shown': 'Ігноровані файли показані',
	'Ignored files are hidden': 'Ігноровані файли сховані',
	Hide: 'Сховати',
	Show: 'Показати',
	'Create snapshot and refresh changes': 'Створити знімок і оновити зміни',
	'Open in default browser': 'Відкрити в системному браузері',
	'Show ignored files': 'Показати ігноровані файли',
	Ignored: 'Ігнорується',
	Modified: 'Змінено',
	Added: 'Додано',
	Deleted: 'Видалено',
	Renamed: 'Перейменовано',
	Untracked: 'Не відстежується',
	Conflict: 'Конфлікт',
	'Expand folder': 'Розгорнути теку',
	'Collapse folder': 'Згорнути теку',
	'Tool diff': 'Зміни інструмента',
	'The tool diff could not be read.': 'Не вдалося прочитати зміни інструмента.',
	'You can give a task to one agent or to a crew. The foreman divides the task between the agents and accepts their work.':
		'Один агент або бригада.',
	'gives work and accepts it': 'доручає й приймає',
	'Select a provider': 'Вибери провайдера',
	// spec/settings-modules-and-onboarding#intro-steps: the Crew step's footer when the built-in templates could not be read.
	'Could not read the role templates.': 'Не вдалося прочитати шаблони ролей.',
	Developers: 'Розробники',
	'Turn on a second agent to use two providers in one crew.':
		'Увімкни другого агента, щоб розвести бригаду між провайдерами.',
	'One crew can use agents from different providers. Set the model and effort in Settings ▸ Templates.':
		'Агенти різних провайдерів в одній бригаді.',
	'To use a crew, press ⌘N and select Foreman. You make your own crew in the crew editor.':
		'Вибери «Бригадир» у новій задачі.',
	'divides and accepts': 'ділить і приймає',
	'writes code': 'пише код',
	'writes no code': 'коду не пише',
	'CSV export': 'CSV-експорт',
	'Table button': 'Кнопка в таблиці',
	'checks both': 'перевіряє обидві',
	'There are two independent parts. I give them to two developers. The reviewer checks both.':
		'Тут дві незалежні частини. Даю їх двом розробникам, ревʼюер перевірить обидві.',
	'2 parts': '2 частини',
	'Export button in the table': 'Кнопка в таблиці',
	'The reviewer checks both': 'Ревʼюер перевіряє обидві',
	Started: 'Запущено',
	'Developer 1 started · CSV export': 'Розробник 1 почав · CSV-експорт',
	'Developer 2 started · Table button': 'Розробник 2 почав · Кнопка в таблиці',
	'Chat and changes': 'Чат і зміни',
	'Chat, editor and changes': 'Чат, редактор і зміни',
	Next: 'Далі',
	'Other font…': 'Інший шрифт…',
	crew: 'бригада',
	'12 min': '12 хв',
	'2 d': '2 дн',
	'2 parts for 2 agents · The reviewer checks both':
		'2 частини для 2 агентів · Ревʼюер перевіряє обидві',
	'A button in the orders table toolbar.': 'Кнопка в тулбарі таблиці замовлень.',
	'A free second coffee for regular guests.': 'Друга кава в подарунок для постійних гостей.',
	'Add an Export button to the orders table toolbar. It calls ordersToCsv. Your files: orders/OrdersTable.tsx.':
		'Додай кнопку «Експорт» у тулбар таблиці замовлень, вона викликає ordersToCsv. Твої файли: orders/OrdersTable.tsx.',
	'Add ordersToCsv(rows) to orders/export.ts: an id,total header and one line for each order. Your files: orders/export.ts.':
		'Додай ordersToCsv(rows) в orders/export.ts: заголовок id,total і рядок на кожне замовлення. Твої файли: orders/export.ts.',
	'Color tokens from kit and a switch in the profile.':
		'Токени кольорів з kit і перемикач у профілі.',
	'Daily reports count from UTC, not from the venue time.':
		'Звіти за день рахують від UTC, а не від часу закладу.',
	Default: 'Типовий',
	'Drag a folder here, or': 'Перетягни теку сюди або',
	'Full prompt': 'Весь промпт',
	'Put kit and apps/* in one workspace and remove duplicate dependencies.':
		'Перенести kit і apps/* на один workspace, прибрати дублікати залежностей.',
	'Ready · signed in with ChatGPT': 'Готовий · вхід через ChatGPT',
	'Ready · signed in with Claude Code': 'Готовий · вхід через Claude Code',
	'The menu comes from a CDN and refreshes on publish.':
		'Меню віддається з CDN, інвалідація при публікації.',
	'does it': 'виконує',
	'One agent will work. You can see it in the chat.': 'Один агент у чаті.',
	'Both agents are ready. The chat shows the default one.': 'Обидва агенти готові.',
	Settings: 'Налаштування',
	'Settings…': 'Налаштування…',
	'Show the intro again…': 'Повторити налаштування…',
	General: 'Загальні',
	Keyboard: 'Клавіші',
	Keymap: 'Набір',
	'Customize…': 'Налаштувати…',
	changed: 'змінено',
	'Code theme': 'Тема коду',
	'Font styles': 'Накреслення',
	'Default agent': 'Типовий агент',
	'Isolation for new tasks': 'Ізоляція нових задач',
	'Choose a keymap and change any shortcut. You see conflicts at once.':
		'Набір поєднань, редагування й перевірка конфліктів.',
	'Search an action or a shortcut': 'Шукати дію або поєднання',
	'Nothing found': 'Нічого не знайдено',
	'Press keys…': 'Натисни клавіші…',
	'Reset to keymap': 'Повернути з набору',
	'{key} is already used by “{name}”.': '{key} уже використовується для «{name}».',
	'{key} is reserved by macOS: {name}.': '{key} зайняте macOS: {name}.',
	'{key} is reserved by the app: {name}.': '{key} зайняте застосунком: {name}.',
	Spotlight: 'Spotlight',
	'App Switcher': 'перемикач програм',
	Quit: 'вихід з програми',
	'Toggle Developer Tools': 'інструменти розробника',
	'VS Code': 'VS Code',
	IntelliJ: 'IntelliJ',
	Ready: 'Готовий',
	'Not found': 'Не знайдено',
	'Sign in…': 'Увійти…',
	'Get started': 'Почати',
	Folder: 'Тека',
	'Separate repo': 'Окремий репо',
	Submodule: 'Сабмодуль',
	Root: 'Корінь',
	'5 hr': '5 год',
	'3 min': '3 хв',
	'1 d': '1 дн',
	'214 lines': '214 рядків',
	'Add a CSV export for orders': 'Додай експорт замовлень у CSV',
	'All set': 'Усе готово',
	'Another folder…': 'Інша тека…',
	'Brigadir runs agents through their CLIs and works only with your subscription. API keys are not supported.':
		'Агенти працюють через CLI з підпискою. API-ключі не підтримуються.',
	'Checking git and GitHub CLI…': 'Перевірка Git і GitHub CLI…',
	'Choose a folder with code. Brigadir finds every git repository inside it.':
		'Вибери теку з кодом для пошуку repo.',
	'Choose a folder…': 'Вибрати теку…',
	'Choose how you follow your tasks.': 'Дошка або список задач.',
	'Code font and colors. The diff uses the same theme.':
		'Шрифт і кольори коду в редакторі та змінах.',
	'Completion, go to definition, problems. About 0.45 GB of memory for each project.':
		'Доповнення коду, визначення й діагностика. Орієнтовно 0,45 ГБ на проєкт.',
	'Dark theme for the admin': 'Темна тема для адмінки',
	'Done. The Export button is now in the table toolbar.':
		'Готово. Кнопка «Експорт» тепер у тулбарі таблиці.',
	'Each task gets its own worktree and branch.':
		'Кожна задача у своєму worktree і на своїй branch.',
	'First project': 'Перший проєкт',
	'Fix the time zone in reports': 'Виправити часовий пояс у звітах',
	'Format on save': 'Форматувати при збереженні',
	'Found ': 'Знайшли ',
	'Git and GitHub': 'Git і GitHub',
	'Git and GitHub CLI are ready.': 'Git і GitHub CLI готові.',
	'Git is ready. You can install GitHub CLI later.': 'Git готовий.',
	'I will look at how the orders table is built now.':
		'Подивлюсь, як зараз будується таблиця замовлень.',
	Intro: 'Початкові налаштування',
	'Keyboard shortcuts': 'Клавіші',
	Larger: 'Більше',
	Later: 'Пізніше',
	'Look at the window: it changes as you choose.': 'Тема, акцент, розмір тексту й макет.',
	'Looking for agents on this Mac…': 'Пошук агентів…',
	'Loyalty 1+1': 'Loyalty 1+1',
	'Menu cache on a CDN': 'Кеш меню на CDN',
	'Move to a pnpm workspace': 'Міграція на pnpm workspace',
	'No banners. A task that waits for you glows in the sidebar.':
		'Без банерів. Задачі, що чекають відповіді, позначені в сайдбарі.',
	'Not found. You need it for pull requests and checks.': 'Не знайдено. Потрібен для PR і checks.',
	'Not requested yet. macOS asks one time.': 'Дозвіл ще не запитано.',
	'Notifications are allowed': 'Сповіщення дозволено',
	'Orders CSV export': 'Експорт замовлень у CSV',
	'Orders export': 'Експорт замовлень',
	'Go through again': 'Пройти ще раз',
	'Settings are always in ': 'Налаштування будь-коли в ',
	'Signed in to github.com': 'Увійшли в github.com',
	Smaller: 'Менше',
	'Start work': 'Почати роботу',
	'Text size': 'Розмір тексту',
	'The agent asks: “Remove the old API?”': 'Агент питає: «Прибрати старий API?»',
	'The agent finished a turn · 2 files, +48 −3': 'Агент закінчив турн · 2 файли, +48 −3',
	'The agent works in the project folder. You can change this for each task.':
		'Робота в теці проєкту.',
	'The chat shows the default one.': 'Типового видно в чаті.',
	'The diff shows all that the agent changed since the task started.':
		'Усі зміни від початку задачі.',
	'The diff shows only uncommitted changes, as git status does.': 'Незакомічені зміни.',
	'The project Prettier. If there is none, the language server.':
		'Prettier проєкту або мовний сервер, якщо Prettier немає.',
	'The repositories appear in the sidebar on the left.': 'Знайдені repo в сайдбарі.',
	'There is no agent. You need at least one.': 'Потрібен хоча б один агент.',
	'You need an agent to continue. Install Claude Code or Codex, then check again.':
		'Установи Claude Code або Codex і перевір ще раз.',
	now: 'зараз',
	'since last commit': 'від останнього коміту',
	'since task start': 'від старту задачі',
	'this is how a task looks': 'так виглядатиме задача',
	'Looking…': 'Пошук…',
	'Not found on this Mac': 'Не знайдено на компʼютері',
	'Found. You need to sign in.': 'Знайдено. Потрібно увійти.',
	'Downloads on the first launch': 'Завантажиться при першому запуску',
	// The environment check itself failed (intro, Settings ▸ Agents).
	'Not checked': 'Не перевірено',
	'Could not check the agents.': 'Не вдалося перевірити агентів.',
	'Check again. You can also set up the agents later in Settings ▸ Agents.':
		'Перевір ще раз. Агентів можна налаштувати й пізніше: Налаштування ▸ Агенти.',
	'How to install': 'Як встановити',
	Check: 'Перевірити',
	'Task layout': 'Макет задачі',
	'Two columns': 'Два стовпці',
	'Three columns': 'Три стовпці',
	// spec/task-window-workspace#two-columns: the layout choice — Layout ▾, Settings ▸ Appearance, the intro — and the pinned Chat tab of two columns.
	'The chat is the first tab of the work area.': 'Чат — перша вкладка робочої області.',
	'The chat, the work area and the panel side by side.': 'Чат, робоча область і панель поруч.',
	'Chat as a tab': 'Чат вкладкою',
	'Chat as a column': 'Чат стовпцем',
	'Open chat': 'Відкрити чат',
	'Resize chat': 'Змінити ширину чату',
	'Resize the files': 'Змінити ширину файлів',
	'Resize the step column': 'Змінити ширину колонки кроку',
	'Resize sidebar': 'Змінити ширину сайдбару',
	// spec/task-window#narrow-toolbar: «…» of the narrow task toolbar and the Panel section of its menu.
	More: 'Ще',
	Panel: 'Панель',
	Panels: 'Панелі',
	'Panels (closed)': 'Панелі (закрито)',
	'Close panel': 'Закрити панель',
	Documents: 'Документи',
	'Close diff': 'Закрити зміни',
	'Files panel': 'Панель файлів',
	'Open a project…': 'Відкрити проєкт…',
	'Some repositories are unavailable.': 'Деякі репозиторії недоступні.',
	'Toggle diff layout': 'Перемкнути вигляд змін',
	'Expand all context': 'Розгорнути весь контекст',
	'Collapse all context': 'Згорнути весь контекст',
	'Comment on selection': 'Коментувати виділення',
	'Next hunk': 'Наступний хунк',
	'Previous hunk': 'Попередній хунк',
	'Focus address': 'Фокус на адресу',
	'Find in view': 'Пошук у поточній панелі',
	'Previous match': 'Попередній збіг',
	'Next match': 'Наступний збіг',
	'No matches': 'Збігів немає',
	'Selected lines': 'Вибрані рядки',
	'These lines': 'Ці рядки',
	'Some history could not be checked.': 'Частину історії не вдалося перевірити.',
	Submit: 'Підтвердити',
	'Submit and go or allow always': 'Підтвердити й перейти або дозволяти завжди',
	'Deny permission': 'Відмовити в доступі',
	'Request details': 'Деталі запиту',
	'Response headers': 'Заголовки відповіді',
	'Response body': 'Тіло відповіді',
	'Response body is unavailable.': 'Тіло відповіді недоступне.',
	'Response body was truncated.': 'Тіло відповіді скорочено.',
	'Resize files panel': 'Змінити ширину панелі файлів',
	'Resize browser': 'Змінити ширину браузера',
	'Resize console': 'Змінити висоту консолі',
	'The layout could not be saved or restored.':
		'Не вдалося зберегти або відновити розміри панелей.',
	'Selected code': 'Вибраний код',
	'Send to chat': 'Надіслати в чат',
	'Screenshot to chat': 'Знімок у чат',
	DevTools: 'DevTools',
	'Send to chat and go': 'Надіслати в чат і перейти',
	'Attach comment': 'Прикріпити коментар',
	'Attach comment and go': 'Прикріпити коментар і перейти',
	Running: 'Виконується',
	Turn: 'Турн',
	'No turns': 'Ще немає турнів',
	Failed: 'Помилка',
	'This turn is no longer in the terminal buffer.': 'Цього турну вже немає в буфері термінала.',
	'Attach files…': 'Прикріпити файли…',
	'Description from a .md file…': 'Опис з файла .md…',
	'⌘V or drag: images and files': '{shortcut} або перетягни файли й зображення',
	'The .md file could not be read.': 'Не вдалося прочитати файл .md.',
	Attachments: 'Вкладення',
	'Attach screenshot': 'Прикріпити знімок',
	'Remove attachment': 'Прибрати вкладення',
	'Context attached to your next CLI prompt.': 'Контекст прикріплено до наступного промпту CLI.',
	'Copy path': 'Копіювати шлях',
	'Reveal in Finder': 'Показати у файловому менеджері',
	'This file': 'Цей файл',
	'Your edit': 'Твоя правка',
	'During agent turn': 'Під час турну агента',
	'Unattributed change': 'Джерело зміни невідоме',
	'Go to turn': 'Перейти до турну',
	'Earlier checkpoints are not shown.': 'Попередні знімки не показано.',
	'Back to diff': 'Назад до змін',
	'File comment': 'Коментар у файлі',
	'In composer and go': 'Додати в композер і перейти',
	'Revert file changes…': 'Відкотити зміни у файлі…',
	'Restore the file to the base of the displayed diff.': 'Відновити файл до бази показаних змін.',
	Revert: 'Відкотити',
	Checkpoints: 'Знімки',
	'All changes': 'Усі зміни',
	Base: 'База',
	End: 'Кінець',
	'Why did this change?': 'Чому це змінилось?',
	// spec/settings-modules-and-onboarding#modules, spec/browser-and-simulator#simulator: modules and the simulator column.
	Modules: 'Модулі',
	// spec/remote-access-and-mobile#module-and-settings: the remote access module.
	'Remote access': 'Віддалений доступ',
	// spec/settings-modules-and-onboarding#module-settings-popup: the ⚙ of a module row in Settings ▸ Modules — its popup of settings; the providers card of Settings ▸ Agents.
	'Browser settings': 'Налаштування браузера',
	'Pull request settings': 'Налаштування pull requests',
	'Remote access settings': 'Налаштування віддаленого доступу',
	Providers: 'Провайдери',
	Simulator: 'Симулятор',
	Home: 'Home',
	'Send screenshot to chat': 'Надіслати знімок у чат',
	'Shut down simulator': 'Вимкнути симулятор',
	'Xcode not found': 'Xcode не знайдено',
	'Install Xcode from the App Store to run iOS simulators.':
		'Встанови Xcode з App Store, щоб запускати iOS-симулятори.',
	// spec/architecture-and-platform#linux-package: Linux has no iOS simulators; without the Android SDK the column says what to install.
	'Android SDK not found': 'Android SDK не знайдено',
	'Install Android Studio to run Android simulators. iOS simulators need macOS.':
		'Встанови Android Studio, щоб запускати Android-симулятори. iOS-симулятори потребують macOS.',
	'{device} is off': '{device} вимкнений',
	'{device} is starting…': '{device} стартує…',
	'Shut down {device}': 'Вимкнути {device}',
	'Hide simulator': 'Сховати симулятор',
	Rotate: 'Повернути',
	'No simulators': 'Немає симуляторів',
	'Create a simulator in Xcode or Android Studio, then check again.':
		'Створи симулятор у Xcode чи Android Studio й перевір ще раз.',
	'Create a simulator in Xcode, then check again.': 'Створи симулятор у Xcode й перевір ще раз.',
	'Create a virtual device in Android Studio, then check again.':
		'Створи віртуальний пристрій в Android Studio й перевір ще раз.',
	'Simulator screen': 'Екран симулятора',
	'Resize simulator': 'Змінити ширину симулятора',
	'Reload app': 'Перезавантажити',
	'React Native DevTools': 'React Native DevTools',
	'No Metro': 'Немає Metro',
	'Metro is not running in this task': 'Metro не запущено в цій задачі',
	'Commands…': 'Команди…',
	Browser: 'Браузер',
	Address: 'Адреса',
	Go: 'Перейти',
	Back: 'Назад',
	Forward: 'Уперед',
	Mobile: 'Мобільний',
	Desktop: 'Компʼютер',
	'Page console': 'Консоль сторінки',
	Network: 'Мережа',
	'Select node': 'Вибрати елемент',
	Screenshot: 'Знімок',
	'Web Inspector': 'Web Inspector',
	'Agent is not running.': 'Агент не запущений.',
	'Next terminal': 'Наступний термінал',
	'Previous terminal': 'Попередній термінал',
	Console: 'Консоль',
	Transport: 'Транспорт',
	'New terminal': 'Новий термінал',
	'Close terminal': 'Закрити термінал',
	'Clear terminal': 'Очистити термінал',
	'Terminal output': 'Вивід термінала',
	'Show the agent': 'Показати агенту',
	Exit: 'Завершення',
	'Stop this terminal process?': 'Зупинити процес цього термінала?',
	'Show diff': 'Показати зміни',
	'Disk and buffer': 'Файл на диску та незбережені правки',
	Search: 'Пошук',
	'Open Quickly…': 'Відкрити швидко…',
	'Open Quickly (alias)': 'Відкрити швидко (аліас)',
	'Search Everywhere…': 'Шукати всюди…',
	'Search Everywhere': 'Шукати всюди',
	'Search files': 'Пошук файлів',
	Agents: 'Агенти',
	'No results': 'Немає результатів',
	'Search is incomplete.': 'Пошук охопив лише частину файлів.',
	'Show changes': 'Показати зміни',
	'Show files': 'Показати файли',
	'Focus composer': 'Фокус у композер',
	Indent: 'Збільшити відступ',
	Outdent: 'Зменшити відступ',
	'Toggle comment': 'Перемкнути коментар',
	'Go to definition': 'Перейти до визначення',
	'Find references': 'Знайти використання',
	'Show completions': 'Показати доповнення',
	'Show parameters': 'Показати параметри',
	'Next problem': 'Наступна проблема',
	'Previous problem': 'Попередня проблема',
	'Previous location': 'Попереднє місце',
	'Next location': 'Наступне місце',
	References: 'Використання',
	'By name': 'За назвою',
	'No definition found.': 'Визначення не знайдено.',
	'Could not find the definition.': 'Не вдалося знайти визначення.',
	'No references found.': 'Використань не знайдено.',
	'Searching…': 'Пошук…',
	'Found by name: no language server for {language}.':
		'Знайдено за назвою: мовного сервера для {language} немає.',
	'Text matches: no language server for {language}.':
		'Текстові збіги: мовного сервера для {language} немає.',
	'This file is outside the project. Read only.': 'Файл поза проєктом. Лише читання.',
	'The list is shortened.': 'Список скорочено.',
	'Outside the project': 'Поза проєктом',
	'Open the location': 'Відкрити місце',
	'This file is too large for review.': 'Цей файл завеликий для коментарів ревʼю.',
	'Select up to 100 lines for a comment.': 'Для коментаря виділи не більше 100 рядків.',
	'Select a declaration': 'Виділити оголошення',
	'Syntax highlighting is unavailable.': 'Підсвітка синтаксису недоступна.',
	'Syntax highlighting limit reached.': 'Досягнуто межі підсвітки синтаксису.',
	'This file is outside the task repos.': 'Файл поза repo задачі.',
	'Save or refresh the file to add a comment.':
		'Збережи файл або онови знімок, щоб додати коментар.',
	'File comments': 'Коментарі файла',
	'current match': 'поточний збіг',
	'on line': 'у рядку',
	'replaced match on line $': 'Замінено збіг у рядку $',
	'replaced $ matches': 'Замінено збігів: $',
	Replace: 'Замінити',
	next: 'далі',
	previous: 'назад',
	all: 'усі',
	'match case': 'враховувати регістр',
	regexp: 'регулярний вираз',
	'by word': 'ціле слово',
	replace: 'замінити',
	'replace all': 'замінити все',
	close: 'закрити',
	// spec/editor#editor-chrome: the floating find panel and the change map of the editor.
	'Find in file': 'Пошук у файлі',
	'Show replace': 'Показати заміну',
	'Hide replace': 'Сховати заміну',
	'Select all matches': 'Вибрати всі збіги',
	'Replace all': 'Замінити все',
	'Invalid regex': 'Неправильний regex',
	'Changes in this file': 'Зміни у файлі',
	'Added · {lines} · +{count}': 'Додано · {lines} · +{count}',
	'Changed · {lines}': 'Змінено · {lines}',
	'Deleted · after {line} · −{count}': 'Видалено · після {line} · −{count}',
	'Deleted · before {line} · −{count}': 'Видалено · перед {line} · −{count}',
	File: 'Файл',
	Save: 'Зберегти',
	Find: 'Знайти',
	'Find and replace': 'Знайти й замінити',
	// spec/search-menus-and-commands#menu-structure: Editor ▸ Find next / Find previous, the open find panel's steps.
	'Find next': 'Знайти наступний',
	'Find previous': 'Знайти попередній',
	Undo: 'Скасувати правку',
	Redo: 'Повторити правку',
	'Open in editor': 'Відкрити в редакторі',
	'Show in Files': 'Показати у Файлах',
	'⌘+click opens in editor': '{shortcut} відкриває в редакторі',
	'File content': 'Вміст файла',
	'Project files': 'Файли проєкту',
	'Plain text': 'Звичайний текст',
	'Large file. Plain text mode.': 'Великий файл. Режим звичайного тексту.',
	'This file changed on disk.': 'Цей файл змінився на диску.',
	'A stray carriage return (CR) in this line': 'Зайвий символ CR у рядку',
	Reload: 'Перечитати',
	'Keep mine': 'Лишити мої правки',
	'This file is open in another task.': 'Цей файл відкрито в іншій задачі.',
	// spec/editor#save-during-turn: Save during a turn is held by the host until the turn ends.
	'Save after the turn': 'Зберегти після турну',
	'The save waits for the turn to end.': 'Збереження чекає кінця турну.',
	'Worktree removed': 'Worktree прибрано',
	'The files return when the task continues and its worktree is created again.':
		'Продовження задачі відновить worktree й файли.',
	'Discard changes': 'Відкинути правки',
	'Keep editing': 'Продовжити редагування',
	'There are unsaved changes.': 'Є незбережені правки.',
	'Close file': 'Закрити файл',
	// spec/editor#tab-menu: the document tab's menu, JetBrains' close group.
	'Close other tabs': 'Закрити інші вкладки',
	'Close all tabs': 'Закрити всі вкладки',
	'Close unmodified tabs': 'Закрити вкладки без правок',
	'Close tabs to the right': 'Закрити вкладки праворуч',
	// spec/editor#editor-groups: editor groups, JetBrains' split items; «Перенести» moves the tab, «Розділити» shows it in both groups.
	'Split right': 'Розділити праворуч',
	'Split down': 'Розділити вниз',
	'Split and move right': 'Перенести праворуч',
	'Split and move down': 'Перенести вниз',
	'Move to the other group': 'Перенести в іншу групу',
	Unsplit: 'Зняти поділ',
	'Unsplit all': 'Зняти всі поділи',
	'Next group': 'Наступна група',
	'Previous group': 'Попередня група',
	'Editor group': 'Група редактора',
	'Editor groups': 'Групи редактора',
	'Resize editor groups': 'Змінити розмір груп',
	'Move here': 'Перенести сюди',

	'New comment': 'Новий коментар',
	'What is wrong with these lines?': 'Коментар до виділеного коду',
	Comment: 'Коментар',
	'Add a comment': 'Додати коментар',
	'Edit comment': 'Редагувати коментар',
	'Remove comment': 'Прибрати коментар',
	'Send review': 'Надіслати ревʼю',
	Review: 'Ревʼю',
	Addressed: 'Змінено агентом',
	Resolve: 'Вирішити',
	Reopen: 'Відкрити знову',
	Sent: 'Надіслано',
	Outdated: 'Застарілий',
	Relocated: 'Переміщений',
	'In composer': 'У композер',
	'Select a function': 'Виділити функцію',
	'The draft has not been added.': 'Чернетку ще не додано.',
	'Select lines again to attach this draft.': 'Виділи код знову, щоб прикріпити цю чернетку.',
	'Compact review': 'Компактне ревʼю',
	'Expand review panel': 'Розгорнути панель ревʼю',
	'Collapse review panel': 'Згорнути панель ревʼю',
	'Attach review': 'Прикріпити ревʼю',
	'Review attached to your next CLI prompt.': 'Ревʼю додане до наступного промпту в CLI.',
	'Remove queued review': 'Прибрати ревʼю з черги',
	'Add note': 'Додати нотатку',
	'General note': 'Загальна нотатка',

	Changes: 'Зміни',
	Refresh: 'Оновити',
	'Refresh pull requests': 'Оновити PR',
	Unified: 'Єдиний',
	'Side by side': 'Поруч',
	'Wrap lines': 'Переносити рядки',
	wrap: 'перенос',
	// spec/editor#markdown-views: Markdown preview in the editor and the diff.
	Preview: 'Перегляд',
	'Markdown view': 'Вигляд Markdown',
	'Markdown preview': 'Перегляд Markdown',
	'Changes preview': 'Перегляд змін',
	'Lines always wrap in the preview': 'У перегляді рядки переносяться завжди',
	'The file is too large for the preview': 'Файл завеликий для перегляду',
	'No snapshots yet': 'Знімків ще немає',
	'No changes': 'Немає змін',
	'No Git snapshots': 'Немає Git-знімків',
	'Select a file': 'Вибери файл',
	'Before the task': 'До задачі',
	'Current snapshot': 'Поточний знімок',
	'Binary file': 'Бінарний файл',
	'Submodule reference': 'Посилання на submodule',
	'This file is too large to display.': 'Цей файл завеликий для перегляду.',
	'Show unchanged lines': 'Показати незмінені рядки',
	'Generated file': 'Згенерований файл',
	'No newline at end of file': 'Немає переносу в кінці файла',
	'Filter files': 'Фільтр файлів',
	'Saved snapshots': 'Збережені знімки',
	'The file changed. Refresh the changes.': 'Файл змінився. Онови зміни.',

	'Add a project…': 'Додати проєкт…',
	Claude: 'Claude',
	Message: 'Повідомлення',
	Send: 'Надіслати',
	Stop: 'Зупинити',
	Resume: 'Продовжити',
	'Starting…': 'Запуск…',
	Conversation: 'Розмова',
	Thinking: 'Думає',
	thinking: 'думає',
	thought: 'думав',
	Writing: 'Пише',
	Permission: 'Дозвіл',
	Question: 'Питання',
	Skip: 'Пропустити',
	'No answer': 'Без відповіді',
	'Your answer…': 'Своя відповідь…',
	Answer: 'Відповідь',
	'Submit answer': 'Відповісти',
	'waiting {age}': 'чекає {age}',
	'{key} to answer': '{key} відповісти',
	'{n} selected': 'Вибрано: {n}',
	Dismiss: 'Відхилити',
	'The request failed.': 'Не вдалося виконати запит.',
	'Could not rename the task.': 'Не вдалося перейменувати задачу.',
	Details: 'Подробиці',
	'The host is disconnected.': 'Зв’язок із сесією втрачено.',
	'The conversation cannot be continued.': 'Не вдалося продовжити розмову.',
	'Write a message…': 'Напиши повідомлення…',
	'No messages': 'Немає повідомлень',
	'Tool calls': 'Виклики інструментів',
	Codex: 'Codex',
	Mode: 'Режим',
	Context: 'Контекст',
	Resolved: 'Вирішено',

	Brigadir: 'Бригадир',
	Projects: 'Проєкти',
	Tasks: 'Задачі',
	'No projects': 'Немає проєктів',
	'No tasks': 'Немає задач',
	'Select a task': 'Вибери задачу',
	'No task is selected.': 'Задачу не вибрано.',
	'The workspace is empty.': 'Поки немає проєктів і задач.',
	'Some data could not be read.': 'Не вдалося прочитати частину даних.',
	'The file is invalid.': 'Файл має неправильний формат.',
	'The file uses a newer schema.': 'Файл має новішу версію формату.',
	'The file could not be read.': 'Не вдалося прочитати файл.',
	// spec/remote-access-and-mobile#remote-button: the phone's errors in its own words, not the host's.
	'The changes could not be read.': 'Не вдалося прочитати зміни.',
	'The folder could not be read.': 'Не вдалося прочитати теку.',
	'The data location is not allowed.': 'Це розташування даних недоступне.',
	'Loading…': 'Завантаження…',
	Retry: 'Спробувати ще',
	Queued: 'У черзі',
	Working: 'Працює',
	'Needs you': 'Потрібен ти',
	Done: 'Готово',
	Interrupted: 'Перервано',
	Error: 'Помилка',
	View: 'Вигляд',
	Workspace: 'Проєкти й задачі',
	Kit: 'Kit',
	Controls: 'Елементи керування',
	Typography: 'Типографіка',
	Colors: 'Кольори',
	Create: 'Створити',
	Cancel: 'Скасувати',
	Name: 'Назва',
	'built-in': 'вбудований',
	Reset: 'Скинути',
	'Task name': 'Назва задачі',
	'From the prompt': 'З промпту',
	'Task name (optional)': 'Назва задачі (необовʼязково)',
	'Write a message… (optional)': 'Напиши повідомлення… (необовʼязково)',
	Notifications: 'Сповіщення',
	Disabled: 'Недоступно',
	Buttons: 'Кнопки',
	Fields: 'Поля',
	Toggle: 'Перемикач',
	'The task is saved.': 'Задачу збережено.',
	// spec/appearance#bundled-fonts: the control kit.
	'Control kit': 'Набір елементів',
	'Shared controls in both themes, as on the canvas. The light column answers the pointer and the keyboard; the dark one mirrors it.':
		'Спільні елементи в обох темах, як на канві. Світла колонка відповідає курсору й клавіатурі, темна — її дзеркало.',
	'Palette, type and spacing': 'Палітра, шрифт і відступи',
	'Controls: sizes and states': 'Контроли: розміри й стани',
	'Menus, popovers, containers and rows': 'Меню, поповери, контейнери й ряди',
	Surfaces: 'Поверхні',
	'fg — main, fg2 — second line and glyphs, fg3 — placeholder and off.':
		'fg — основний, fg2 — другий рядок і гліфи, fg3 — плейсхолдер і недоступне.',
	'A fill under selfg; the soft sel marks the selected row.':
		'Заливка під selfg; мʼякий sel — вибраний рядок.',
	States: 'Стани',
	'amber — waits for you, red — failure, green — done.':
		'amber — чекає на тебе, red — збій, green — готово.',
	'Warning and danger fills': 'Заливки warning і danger',
	'Contrast of 4.5:1 or more in both themes.': 'Контраст від 4,5:1 в обох темах.',
	Continue: 'Продовжити',
	Layers: 'Шари',
	'Hover and press lie over a fill, not in place of it.':
		'Ховер і натиск лягають шаром над заливкою, а не замість неї.',
	Syntax: 'Синтаксис',
	'The Brigadir code theme; bold keywords, italic comments.':
		'Тема коду «Бригадир»; ключові слова жирні, коментарі курсивом.',
	'Shadow and scrim': 'Тінь і затемнення',
	Fonts: 'Шрифти',
	'Geist and Geist Mono on every OS.': 'Geist і Geist Mono на всіх ОС.',
	'Code ligatures': 'Лігатури коду',
	'Stylistic Set 11 in the editor, the diff and code blocks, behind a switch.':
		'Stylistic Set 11 у редакторі, дифі й блоках коду, з перемикачем.',
	'--text-N × --ui-scale; the chat is 13.5 / 22.': '--text-N × --ui-scale; чат — 13,5 / 22.',
	Spacing: 'Відступи',
	Radii: 'Радіуси',
	Motion: 'Рух',
	'No motion with Reduce motion on.': 'Без руху, коли ввімкнено «Зменшити рух».',
	Scale: 'Шкала',
	'One size sets everything; a control with none takes its group’s, then M.':
		'Один розмір задає все; без розміру — розмір групи, далі M.',
	'Icon button': 'Іконкова кнопка',
	'Neutral is soft by default; primary is solid.': 'Типово neutral — soft, primary — solid.',
	Rest: 'Спокій',
	Hover: 'Ховер',
	Pressed: 'Натиск',
	Selected: 'Вибрано',
	'Ghost; selected is aria-pressed; a dot over the glyph.':
		'Ghost; вибрана — aria-pressed; точка над гліфом.',
	Filter: 'Фільтр',
	Dot: 'Точка',
	'Split button': 'Split-кнопка',
	'One capsule, a 1 px line; hover and focus take the whole capsule.':
		'Одна капсула, лінія 1 px; ховер і фокус — на всю капсулу.',
	'Menu open': 'Меню відкрито',
	'A glyph for the second part': 'Друга частина — гліф',
	'No second part': 'Без другої частини',
	Popup: 'Попап',
	'A tint fill without a border; open and focused — a 2 px accent ring inside.':
		'Заливка tint без рамки; відкритий і у фокусі — кільце 2 px accent усередині.',
	'Popup list': 'Попап · список',
	'The row under the pointer is accent-fill under selfg.':
		'Рядок під курсором — accent-fill під selfg.',
	'List under the field': 'Список під полем',
	'A 10 px fg2 label; a branch is mono; invalid — a 1 px red frame.':
		'Підпис 10 px fg2; гілка — моно; помилка — рамка 1 px red.',
	Placeholder: 'Плейсхолдер',
	Value: 'Значення',
	'The buttons take the full height; typed digits are a draft until Return.':
		'Кнопки на всю висоту; набрані цифри — чернетка до Enter.',
	Minimum: 'Мінімум',
	'A tint track with 2 px inside; the chosen one is the card with a shadow. Arrows, Home and End move it.':
		'Підкладка tint, відступ 2 px; вибраний — card із тінню. Стрілки, Home і End переносять вибір.',
	'With glyphs': 'З гліфами',
	'Glyphs only': 'Лише гліфи',
	'In a Settings row the hover covers the whole row.': 'У рядку налаштувань ховер — на весь рядок.',
	'The mark grows with the size; the target is the row with its label.':
		'Позначка росте з розміром; ціль — рядок із підписом.',
	'A chip is always S 24.': 'Чип завжди S 24.',
	Warning: 'Попередження',
	'Popover shell': 'Оболонка поповера',
	'One shell for every popover on a button; Esc first, focus goes back to the anchor.':
		'Одна оболонка для поповерів на кнопці; Esc першим, фокус повертається на якір.',
	'Choice menu': 'Меню вибору',
	'Focus opens on the chosen row; hover is accent-fill under selfg.':
		'Фокус відкривається на вибраному; ховер — accent-fill під selfg.',
	'Choice with a second line': 'Вибір із другим рядком',
	'An XL row; the second line is 11 fg2, selfg under the pointer.':
		'Пункт XL; другий рядок 11 fg2, під курсором — selfg.',
	'Actions: section, count, unavailable, dangerous':
		'Дії: секція, лічильник, недоступна, небезпечна',
	'The reason under an unavailable row; a dangerous one is red.':
		'Причина під недоступним пунктом; небезпечний — червоний.',
	'Checks and shortcuts': 'Галочки й шорткати',
	'A 14 fg2 glyph, a count, an 11 fg2 shortcut.': 'Гліф 14 fg2, лічильник, шорткат 11 fg2.',
	'Esc in the header': 'Esc у шапці',
	'No frame; in the header with the name; S 24; title «Close (Esc)».':
		'Без рамки; у шапці з назвою; S 24; підказка «Close (Esc)».',
	'Esc takes the row size': 'Esc бере розмір ряду',
	'A header of M controls declares M, and Esc is M 28 (spec/appearance#one-row-one-height).':
		'Шапка з M-контролами оголошує M — і Esc M 28 (spec/appearance#one-row-one-height).',
	'One row, one height': 'Один ряд — одна висота',
	'The row declares data-size and its controls set none; the composer row too, Send M 28.':
		'Ряд оголошує data-size, контроли свого не ставлять; ряд композера теж, Send M 28.',
	'Hover covers the whole target': 'Ховер на всю ціль',
	'The fill reaches the divider: name, second line and empty space.':
		'Заливка доходить до роздільника: назва, другий рядок і порожнє місце.',
	'Target at least 24 × 24': 'Ціль від 24 × 24',
	'A 14–16 glyph, the button around it with its hover, never smaller than S.':
		'Гліф 14–16, кнопка навколо з ховером, не менша за S.',
	'Popover with a nub': 'Поповер зі стрілкою',
	'Hover popovers (context, limits): the nub on the edge facing the anchor.':
		'Ховер-поповери (контекст, ліміти): стрілка на краю до якоря.',
	'Below the anchor': 'Під якорем',
	'Above the anchor': 'Над якорем',
	Confirmation: 'Підтвердження',
	'The popover shell as a modal, 320 wide; focus on Cancel; an M footer. A failed action shows a red line; a running one turns both buttons off.':
		'Оболонка поповера як модалка, ширина 320; фокус на Cancel; підвал M. Збій — червоний рядок, поки дія йде — обидві кнопки недоступні.',
	'Open with an error': 'Відкрити зі збоєм',
	'Open while it runs': 'Відкрити під час дії',
	Modal: 'Модалка',
	'Radius 11, a 14 / 600 header with Esc, a 12 / 1.45 body, a tint footer.':
		'Радіус 11, шапка 14 / 600 з Esc, тіло 12 / 1,45, підвал tint.',
	'Sheet and container card': 'Аркуш і картка-контейнер',
	'The real ModalDialog (radius 11, a tint footer) and ListCard (radius 9, rows under a hairline).':
		'Справжні ModalDialog (радіус 11, підвал tint) і ListCard (радіус 9, рядки під лінією).',
	'Dark / light palette': 'Палітра — темна / світла',
	Segments: 'Сегменти',
	Automatic: 'Автоматично',
	Manual: 'Вручну',
	Agent: 'Агент',
	'Task type': 'Тип задачі',
	Start: 'Запустити',
	Delete: 'Видалити',
	Small: 'Мала',
	'Popup and menu': 'Попап і меню',
	Crew: 'Бригада',
	'Review crew': 'Бригада ревʼю',
	'Restore default crews': 'Повернути типові бригади',
	'Developers + Reviewer': 'Розробники + Ревʼюер',
	'Create crew…': 'Створити бригаду…',
	Stepper: 'Лічильник',
	Increase: 'Збільшити',
	Decrease: 'Зменшити',
	'Checkbox and radio': 'Прапорці й перемикачі',
	Unchecked: 'Не вибрано',
	Checked: 'Вибрано',
	'First option': 'Перший варіант',
	'Second option': 'Другий варіант',
	Optional: 'Необовʼязково',
	Branch: 'Branch',
	'Invalid name': 'Недійсна назва',
	Chips: 'Чипи',
	Off: 'Вимкнено',
	Contended: 'Зайнято',
	'Window tabs': 'Вкладки вікна',
	Chat: 'Чат',
	Editor: 'Редактор',
	Files: 'Файли',
	Diff: 'Зміни',
	Turns: 'Турни',
	Appearance: 'Вигляд',
	Language: 'Мова',
	'States and badges': 'Стани й бейджі',
	Containers: 'Контейнери',
	Sheet: 'Аркуш',
	Popover: 'Поповер',
	'Container card': 'Картка-контейнер',
	'Child row': 'Вкладений рядок',
	'New task': 'Нова задача',
	'Transcript and list text': 'Текст транскрипту й рядок списку',
	'Comment text': 'Текст коментаря в картці',
	'Group title': 'Заголовок секції',
	'Caption and metadata': 'Підпис і метадані',
	'Text sizes': 'Шкала тексту',
	'Spacing and radii': 'Відступи й радіуси',
	Density: 'Щільність',
	Focus: 'Фокус',
	Unread: 'Непрочитане',
	Saved: 'Збережено',
	Close: 'Закрити',
	'Controls only; no workspace data is changed.':
		'Приклади елементів. Дані проєктів не змінюються.',
	Never: 'Ніколи',
	'macOS permission': 'Системний дозвіл',
	Allowed: 'Дозволено',
	'Not requested yet': 'Ще не запитано',
	'Brigadir notifications are turned off in macOS.': 'Сповіщення Бригадира вимкнено в системі.',
	'Notifications are turned off in macOS': 'Сповіщення вимкнено в системі',
	When: 'Коли',
	'When you are needed': 'Потрібен ти',
	'When a turn ends': 'Кінець турну',
	'Brigadir does not show notifications.': 'Сповіщення вимкнено.',
	'The agent asks a question or asks for permission.': 'Агент питає або просить дозволу.',
	'When the agent finishes each turn.': 'Коли агент закінчує кожен турн.',
	Sound: 'Звук',
	'Turn ended': 'Кінець турну',
	None: 'Немає',
	'Quiet while I am viewing the task': 'Без сповіщень у відкритій задачі',
	Allow: 'Дозволити',
	Deny: 'Відмовити',
	Open: 'Відкрити',
	'Open System Settings': 'Відкрити Системні налаштування',
	'The sound could not be played.': 'Не вдалося відтворити звук.',
	'The agent is waiting for your permission.': 'Агент чекає дозволу.',
	'The agent asked a question.': 'Агент поставив питання.',
	'A worker is waiting for your answer.': 'Воркер чекає відповіді.',
	'The turn ended.': 'Турн завершився.',
	'The session failed.': 'Сесія завершилась помилкою.',
	'Max concurrent': 'Одночасних агентів',
	Unlimited: 'Без обмеження',
	'Waiting for a free agent slot.': 'Чекає вільного слота.',
	'Start now': 'Почати зараз',
	'Submit review': 'Надіслати ревʼю',
	Proceed: 'Продовжити',
	'Accept the suggestion with Tab': 'Tab приймає підказку',
	'Turn completed': 'Турн завершено',
	'Mark completed': 'Позначити завершеною',
	'Move to in progress': 'Перенести у роботу',
	'Project view': 'Вигляд проєкту',
	'Agent options are available after the first launch.':
		'Параметри агента доступні після першого запуску.',
	Board: 'Дошка',
	List: 'Список',
	Backlog: 'Беклог',
	'In progress': 'У роботі',
	Completed: 'Завершені',
	'Completed task': 'Завершена',
	'Not started': 'Не розпочата',
	Stopped: 'Зупинена',
	'Start task': 'Почати задачу',
	'Edit task': 'Редагувати задачу',
	'Edit task…': 'Редагувати задачу…',
	'All projects': 'Усі проєкти',
	'Set aside for later': 'Відкладені задачі',
	'Drop here and the agent starts': 'Перетягни для запуску',
	'Drop here what you have accepted': 'Прийняті задачі',
	'Clear the list': 'Очистити список',
	'Clear the field': 'Очистити поле',
	'Clear the list…': 'Очистити список…',
	'Their worktrees and diff snapshots are removed with them.':
		'Разом із ними зникнуть їхні worktree та знімки змін.',
	Model: 'Модель',
	Effort: 'Effort',
	Now: 'зараз',
	'{count} repos': '{count} repo',
	'No tasks yet': 'Задач ще немає',
	Task: 'Задача',
	'Add to backlog': 'У беклог',
	'New task in backlog': 'Нова задача в беклог',
	'The task could not be moved.': 'Не вдалося перенести задачу.',
	'The project is not selected.': 'Проєкт не вибрано.',
	History: 'Історія',
	'Changes view': 'Вигляд змін',
	'Merge…': 'Змерджити…',
	'Merge a branch': 'Змерджити branch',
	Merge: 'Змерджити',
	Into: 'Куди',
	'What to merge': 'Що змерджити',
	'Search branches': 'Пошук branch',
	current: 'поточна',
	Recent: 'Недавні',
	'Remote branches': 'Віддалені',
	'Already up to date': 'Нічого нового',
	'No conflicts expected': 'Конфліктів не очікується',
	'Conflict expected': 'Очікується конфлікт',
	'The merge did not resolve itself': 'Є невирішені конфлікти',
	'Resolve it myself': 'Вирішити вручну',
	'Conflict places open in the editor': 'Відкриває конфлікти в редакторі',
	'Let the agent resolve': 'Доручити агенту',
	'A separate turn; you accept the result': 'Окремий турн. Результат потребує твого підтвердження.',
	'Abort merge': 'Скасувати мердж',
	'The tree returns to its state before the merge': 'дерево повернеться до стану перед мерджем',
	'Merge in progress': 'Мердж у процесі',
	Left: 'Лишилось',
	'Conflict resolved': 'вирішено',
	'No conflicts': 'Немає конфліктів',
	Ours: 'Наше',
	Theirs: 'Їхнє',
	Both: 'Обидва',
	'Edit by hand': 'Редагувати вручну',
	'Mark resolved': 'Позначити вирішеним',
	Accept: 'Прийняти',
	'Resolved by the agent': 'вирішено агентом',
	// A modify/delete conflict: one side deleted the file, the other changed it.
	'deleted in {branch}': 'видалено в {branch}',
	'deleted on both sides': 'видалено з обох боків',
	'Keep the file': 'Лишити файл',
	'Delete the file': 'Видалити файл',
	'Finish merge': 'Завершити мердж',
	'Let the agent finish resolving': 'Доручити решту агенту',
	'Add the repo to the task before merging.': 'Додай repo в задачу перед мерджем.',
	'Wait for the agent to finish before merging.':
		'Дочекайся завершення роботи агента перед мерджем.',
	'Commit or stash the changes before merging.': 'Зроби коміт або stash перед мерджем.',
	'Merge into the current branch only.': 'Мерджити можна лише в поточну branch.',
	'A merge is already in progress.': 'Мердж уже в процесі.',
	'Resolve every conflict place first.': 'Спершу виріши всі конфлікти.',
	'No conflict places are left.': 'Усі конфлікти вирішено.',
	'The branch is unavailable': 'Branch недоступна',
	'Merge into a repo outside the worktree?': 'Змерджити в repo поза worktree?',
	'The task runs in a worktree, but this repo stays in place: the merge writes to your working tree.':
		'Задача працює у worktree, але це repo лишається на місці: мердж пише у твоє робоче дерево.',
	'Merge here': 'Змерджити тут',
	'No commits': 'Комітів немає',
	'Select a branch': 'Вибери branch',
	'Folder unavailable': 'тека недоступна',
	'A selected repo is unavailable': 'Обране repo недоступне',
	'Merge commit': 'мердж',
	'Local branches': 'Локальні',
	'No branches match': 'Жодна branch не підходить',
	'Conflict place': 'Конфлікт',
	// spec/appearance#evolution-redesign: the dot of an unsaved file in its tab, in the ×'s place.
	Unsaved: 'Не збережено',
	// spec/editor#line-author: the line author and a file's history.
	'Ignored .env files go into a new worktree.': 'Копіює ігноровані файли .env у новий worktree.',
	'Copy .env': 'Копіювати .env',
	'Copying .env…': 'Копіювання .env…',
	'brigadir/auto': 'brigadir/auto',
	// spec/tasks#worktree-preparation: the branch row of a «Preparing…» card while the agent names the branch.
	'brigadir/…': 'brigadir/…',
	'Naming the branch…': 'Добір назви branch…',
	'File history': 'Історія файла',
	'Commit of this line': 'Коміт цього рядка',
	'Show line author': 'Показувати автора рядка',
	'Line author': 'Автор рядка',
	Git: 'Git',
	'Open commit': 'Відкрити коміт',
	'Copy hash': 'Копіювати хеш',
	'Remove the file filter': 'Прибрати фільтр файла',
	'renamed from {path}': 'перейменовано з {path}',
	'Show 100 more': 'Показати ще 100',
	'No commits with this file yet: Git does not track it.':
		'Git ще не відстежує файл. Комітів немає.',
	'outside Git': 'поза git',
	'Commit of line {line}': 'Коміт рядка {line}',
	'Subscription limits': 'Ліміти підписки',
	'5-hour limit': '5-годинний ліміт',
	'Weekly · all models': 'Тижневий · усі моделі',
	'Weekly · {model}': 'Тижневий · {model}',
	'Weekly limit': 'Тижневий ліміт',
	'Limit · {window}': 'Ліміт · {window}',
	left: 'лишилось',
	'Limit reached': 'ліміт вичерпано',
	'resets in {time}': 'скидання через {time}',
	'resets {day}, {time}': 'скидання {day}, {time}',
	'reset time unknown': 'час скидання невідомий',
	'updated just now': 'оновлено щойно',
	'updated {time} ago': 'оновлено {time} тому',
	'Signed in with an API key. There is no subscription limit here.':
		'Вхід через API-ключ. Ліміту підписки тут немає.',
	'Subscription limits: {summary}': 'Ліміти підписки: {summary}',
	'Show «{window}» in the indicator': 'Показувати «{window}» в індикаторі',
	'Show in the indicator': 'Показувати в індикаторі',
	// spec/editor-code-intelligence#format-on-save: format on save.
	'Diff base': 'База змін',
	'Task start': 'Старт задачі',
	'What changed since the task started.': 'Зміни від початку задачі.',
	'Last commit': 'Останній коміт',
	'What is not committed yet, as in git status.': 'Незакомічені зміни.',
	// spec/diff-and-review#changes-header: the base chip in the changes panel header.
	'{label}: {value}': '{label}: {value}',
	'Change in Settings ▸ Editor': 'Змінити: Налаштування ▸ Редактор',
	'Snapshots #{base}–#{current}': 'Знімки #{base}–#{current}',
	'Show all changes': 'Показати всі зміни',
	'Restore the file to the last commit. Changes made before the task are lost too.':
		'Відновити файл до останнього коміту. Зміни, зроблені до задачі, теж зникнуть.',
	'Next change': 'Наступна зміна',
	'Previous change': 'Попередня зміна',
	'Revert change': 'Відкотити зміну',
	'Open diff': 'Відкрити зміни',
	'Task base': 'База задачі',
	'Change {index} of {count}': 'Зміна {index} з {count}',
	'{index} of {count}': '{index} з {count}',
	'Format document': 'Форматувати документ',
	Formatting: 'Форматування',
	Bold: 'Жирний',
	Italic: 'Курсив',
	Link: 'Посилання',
	'On save': 'При збереженні',
	'As default': 'Типово',
	'Language server': 'Мовний сервер',
	Prettier: 'Prettier',
	'Language servers': 'Мовні сервери',
	// spec/editor-code-intelligence#language-server-restart: Editor ▸ Restart language servers, its toasts and the agent's tool in the chat.
	'Restart language servers': 'Перезапустити мовні сервери',
	'Language servers restarted: {names}': 'Мовні сервери перезапущено: {names}',
	'No language servers are running': 'Немає запущених мовних серверів',
	'Language servers are off in Settings': 'Мовні сервери вимкнено в налаштуваннях',
	'Restarting the language servers': 'Перезапускає мовні сервери',
	'Restarted the language servers': 'Перезапустив мовні сервери',
	'Could not restart the language servers': 'Мовні сервери не перезапущено',
	'nothing to restart': 'нічого перезапускати',
	'Bracket pairs': 'Пари дужок',
	'Closing tags': 'Закривальні теги',
	'Call parentheses': 'Дужки виклику',
	'Found by name: language servers are off.': 'Знайдено за назвою: мовні сервери вимкнено.',
	'Text matches: language servers are off.': 'Текстові збіги: мовні сервери вимкнено.',
	// spec/editor#indentation: indentation in Settings ▸ Editor and the config line of a project.
	Indentation: 'Відступи',
	'Indent style': 'Відступ',
	'Indent size': 'Розмір відступу',
	'Tab width': 'Ширина табу',
	Tabs: 'Таби',
	Spaces: 'Пробіли',
	tabs: 'таби',
	spaces: 'пробіли',
	'width {n}': 'ширина {n}',
	'width {n} · your setting': 'ширина {n} · твоє налаштування',
	Auto: 'Авто',
	'Prettier {version}': 'Prettier {version}',
	'Prettier not found': 'Prettier не знайдено',
	'Formatter for {project}': 'Форматер для {project}',
	'Not formatted: syntax error on {line}. The file is saved.':
		'Не відформатовано: синтаксична помилка в {line}. Файл збережено.',
	'line {line}': 'рядку {line}',
	'The formatter did not respond. The file is saved without formatting.':
		'Форматер не відповів. Файл збережено без форматування.',
	'The formatter did not respond.': 'Форматер не відповів.',
	'Not formatted: syntax error on {line}.': 'Не відформатовано: синтаксична помилка в {line}.',
	'Prettier was not found in the project.': 'Prettier не знайдено в проєкті.',
	'The language server does not format this file.': 'Мовний сервер не форматує цей файл.',
	'Nothing formats this file.': 'Немає форматера для цього файла.',
	'Prettier does not format this file.': 'Prettier не форматує цей файл.',
	'Not formatted: syntax error. The file is saved.':
		'Не відформатовано: синтаксична помилка. Файл збережено.',
	'Not formatted: syntax error.': 'Не відформатовано: синтаксична помилка.',
	'The formatters could not be loaded.': 'Не вдалося прочитати форматери.',
	Commands: 'Команди',
	'Project commands': 'Команди проєкту',
	'Project commands…': 'Команди проєкту…',
	'Run current command': 'Запустити поточну команду',
	'Stop current command': 'Зупинити поточну команду',
	'New command…': 'Нова команда…',
	'New command': 'Нова команда',
	'Edit command': 'Редагувати команду',
	Run: 'Запустити',
	'Run again': 'Запустити знову',
	'Show in console': 'Показати в консолі',
	'Open in browser': 'Відкрити в браузері',
	'The PR did not open here. Opened in the browser.':
		'Не вдалося відкрити PR у застосунку. Відкрито в браузері.',
	Command: 'Команда',
	'Folder inside the repo': 'Тека всередині repo',
	optional: 'необовʼязково',
	'In this task': 'У цій задачі',
	'Without a task': 'Без задачі',
	'Save and run': 'Зберегти й запустити',
	'Run once': 'Виконати один раз',
	'Save as command…': 'Зберегти як команду…',
	'Running now': 'Працюють',
	New: 'Нова',
	'Open a task to run a command': 'Відкрий задачу, щоб запустити команду',
	'No commands': 'Немає команд',
	'Add command…': 'Додати команду…',
	// spec/search-menus-and-commands#package-scripts: package.json scripts in the editor menu and the command editor.
	'Run script': 'Запустити скрипт',
	'Add to commands…': 'Додати в команди…',
	Scripts: 'Скрипти',
	'Could not read the scripts of package.json.': 'Не вдалося прочитати скрипти package.json.',
	'Could not run the script.': 'Не вдалося запустити скрипт.',
	starting: 'запускається',
	running: 'працює',
	crashed: 'помилка',
	finished: 'готово',
	'not run yet': 'не запускалась',
	'Stopped by you · the output stays until the tab is closed':
		'Зупинено вручну. Вивід зберігається до закриття вкладки.',
	'Command or a new line…': 'Команда або новий рядок…',
	'Run and show': 'запустити й показати',
	'Run in the background': 'Запустити у фоні',
	'Stop command': 'зупинити',
	'Current command': 'Поточна команда',
	'Run {name}': 'Запустити {name}',
	'Stop {name}': 'Зупинити {name}',
	'Restart {name}': 'Перезапустити {name}',
	'The command is no longer saved.': 'Команду вже не збережено.',
	'Commands of the project': 'Команди проєкту',
	'Pull requests': 'PR',
	'Find file': 'Знайти файл',
	'Find a turn': 'Знайти турн',
	'Changes of turn {n}': 'Зміни турну {n}',
	'Find a commit': 'Знайти коміт',
	'Waiting for you': 'Чекають тебе',
	Yours: 'Твої',
	Others: 'Інші',
	'Recently closed': 'Нещодавно закриті',
	you: 'ти',
	'Waiting for your review': 'Чекає твого ревʼю',
	'Changes requested': 'Потрібні зміни',
	Approved: 'Схвалено',
	Comments: 'Коментарі',
	'Checks passed': 'Checks пройшли',
	'Checks failed': 'Checks не пройшли',
	'Checks are running': 'Checks виконуються',
	'Find a PR': 'Знайти PR',
	'No PRs': 'немає PR',
	'Reading PRs from GitHub…': 'Завантаження PR з GitHub…',
	'PRs could not be read: the network is unavailable.':
		'Не вдалося прочитати PR: мережа недоступна.',
	'No open PRs in {repo}': 'Відкритих PR у {repo} немає',
	'No open PRs': 'Відкритих PR немає',
	'Show closed': 'Показати закриті',
	'Older closed PRs are on GitHub': 'Давніші закриті PR у GitHub',
	'Back to the list': 'До переліку',
	Overview: 'Огляд',
	'Review with an agent': 'Ревʼю з агентом',
	'With an agent': 'З агентом',
	'Pull request': 'PR',
	Commits: 'Коміти',
	'The PR could not be read.': 'Не вдалося прочитати PR.',
	'Reading the PR from GitHub…': 'Завантаження PR з GitHub…',
	'Unresolved only': 'Лише невирішені',
	'Every thread is resolved': 'Усі треди вирішено',
	'No comments on the lines': 'Коментарів на рядках немає',
	'{n} of {total} viewed': '{n} з {total} переглянуто',
	Viewed: 'Переглянуто',
	'Not viewed': 'Не переглянуто',
	'Log on GitHub': 'Лог на GitHub',
	'Open thread': 'Відкритий тред',
	'Main tree': 'Основне дерево',
	'main tree': 'основне дерево',
	'New quick task': 'Нова швидка задача',
	'What should the agent do?': 'Що має зробити агент?',
	'The task gets its own worktree on the PR branch': 'Задача отримає свій worktree на branch PR',
	'A quick task writes straight into the project working tree':
		'Швидка задача пише прямо в робоче дерево проєкту',
	'The main tree has uncommitted changes on {current}, so the task gets a worktree on {branch}.':
		'В основному дереві на {current} є незакомічені зміни, тож задача отримає worktree на {branch}.',
	'The main tree switches from {current} to {branch}: the working tree is clean. The branch stays after the task.':
		'Основне дерево перемкнеться з {current} на {branch}: робоче дерево чисте. Після задачі branch лишиться.',
	'More options…': 'Більше параметрів…',
	'New quick task in {branch}…': 'Нова швидка задача в {branch}…',
	'The settings could not be read.': 'Не вдалося прочитати налаштування.',
	outdated: 'застаріло',
	'lines {start}–{end}': 'рядки {start}–{end}',
	'line {n}': 'рядок {n}',
	'Reply…': 'Відповідь…',
	'Reopen thread': 'Відкрити тред знову',
	'Resolve thread': 'Вирішити тред',
	'Reply now': 'Відповісти одразу',
	'Add to review': 'Додати в ревʼю',
	Reply: 'Відповісти',
	draft: 'чернетка',
	'Remove the draft': 'Прибрати чернетку',
	'Draft review': 'Чернетка ревʼю',
	'Leave a comment': 'Залишити коментар',
	'Comment now': 'Коментувати одразу',
	cancel: 'скасувати',
	Approve: 'Схвалити',
	'Request changes': 'Попросити змін',
	'Agent fixes it': 'Агенту на виправлення',
	'You commented': 'Твій коментар',
	'You approved': 'Твоє схвалення',
	'You requested changes': 'Твій запит змін',
	'Handed to the agent': 'Передано агенту',
	'Review sent to PR #{n}': 'Ревʼю надіслано в PR #{n}',
	'No drafts': 'Чернеток немає',
	'Another review': 'Нове ревʼю',
	'Send the review': 'Надіслати ревʼю',
	'Review comment': 'Коментар ревʼю',
	'A general comment on the PR': 'Загальний коментар до PR',
	Decision: 'Рішення',
	'you cannot approve your own PR': 'свій PR схвалити не можна',
	'you cannot request changes on your own PR': 'у свого PR не можна попросити змін',
	'The agent of the PR task makes the fixes. Push only after you confirm.':
		'Правки робить агент задачі, з якої вийшов PR. Push — лише після твого підтвердження.',
	'The agent of the task «Review #{n}» makes the fixes in a worktree on {branch}. Push only after you confirm.':
		'Правки робить агент задачі «Ревʼю #{n}» у worktree на {branch}. Push — лише після твого підтвердження.',
	'You cannot push to {branch}. The agent opens a separate PR with the fixes, {branch}-fixes → {branch}.':
		'У branch {branch} писати не можна. Агент зробить окремий PR з правками {branch}-fixes → {branch}.',
	'Also send the comments to the PR': 'Також надіслати коментарі в PR',
	Drafts: 'Чернетки',
	'Hand to the agent': 'Передати агенту',
	'Send again': 'Надіслати ще раз',

	'The commit could not be read.': 'Не вдалося прочитати коміт.',
	'just now': 'щойно',
	'An approval is required': 'Потрібне схвалення',
	'Checks did not pass': 'Checks не пройшли',
	'Conflicts with {base}': 'Конфлікт із {base}',
	'The PR is a draft': 'PR — чернетка',
	'The PR is closed': 'PR закрито',
	'The PR is merged': 'PR змерджено',
	'Can be merged': 'Можна мерджити',
	'Ready for review': 'Готовий до ревʼю',
	'Take the PR out of draft: GitHub asks the reviewers, and the PR can be merged':
		'Позначає PR готовим і сповіщає ревʼюерів. Мердж залежить від правил repo.',
	'You cannot merge in this repo': 'У цьому repo мерджити не можна',
	'GitHub does not allow merging yet': 'GitHub поки не дозволяє мердж',
	'The summary could not be generated.': 'Не вдалося згенерувати підсумок.',
	'The summary could not be generated: {reason}': 'Не вдалося згенерувати підсумок: {reason}',
	'Generate a summary': 'Згенерувати підсумок',
	'The agent looks at what was done and where': 'Агент підсумовує зміни',
	'Merge the PR into {base}': 'Змерджити PR у {base}',
	'Merge PR…': 'Змерджити PR…',
	'wants to merge {n} from': 'хоче влити {n} з',
	into: 'у',
	Reviewers: 'Ревʼюери',
	'Nobody yet': 'Поки нікого',
	'{n} approvals required': 'Потрібно схвалень: {n}',
	description: 'опис',
	Timeline: 'Стрічка',
	All: 'Усе',
	'{n} unresolved': 'Невирішених: {n}',
	'Nothing here yet': 'Тут поки нічого',
	'PR #{n} merged': 'PR #{n} змерджено',
	'Waiting for the review': 'Чекає ревʼю',
	Commented: 'Коментував',
	'Ask the agent': 'Спитати агента',
	'requested changes': 'попросив змін',
	reviewed: 'переглянув',
	'The agent is thinking…': 'Агент думає…',
	'The agent could not answer.': 'Агент не зміг відповісти.',
	'Agent · a draft reply': 'Агент · чернетка відповіді',
	'Agent · a change for the task': 'Агент · правка для задачі',
	'Agent · an explanation for you': 'Агент · пояснення для тебе',
	'Turn into a reply': 'Перетворити на відповідь',
	Discard: 'Відкинути',
	'Send to the PR': 'Надіслати в PR',
	'Only for your own PR': 'Лише для свого PR',
	Apply: 'Застосувати',
	'Summary from the agent': 'Підсумок від агента',
	'What was done': 'Що зроблено',
	'What to look at': 'Що перевірити',
	Addressee: 'Адресат',
	'To the PR': 'У PR',
	'To the agent': 'Агенту',
	'Ask the agent about this PR…': 'Спитай агента про цей PR…',
	'Comment on this PR…': 'Коментар до PR…',
	Squash: 'Squash',
	Rebase: 'Rebase',
	'Squash makes one commit in {base}.': 'Squash зробить один коміт у {base}.',
	'Rebase puts the commits on top of {base} one by one.':
		'Rebase поставить коміти поверх {base} по одному.',
	'A merge commit joins the branch into {base}.': 'Merge commit обʼєднує branch із {base}.',
	'Merge PR #{n} into {base}?': 'Змерджити PR #{n} у {base}?',
	'Merge method': 'Спосіб мерджу',
	'the repo default': 'типово в repo',
	'{n} will go': 'До мерджу: {n}',
	'Delete the branch': 'Видалити branch',
	'GitHub did not merge the PR. The dialog stays open.': 'GitHub не змерджив PR.',
	// spec/pull-requests-and-ci#pr-definition: ⌘+click in a PR file goes to a definition in the PR head tree.
	'Unchanged in the PR': 'Без змін у PR',
	'Definition of {name}': 'Визначення {name}',
	'Back to {file}': 'До {file}',
	'Found by name in the PR branch.': 'Знайдено за назвою в гілці PR.',
	'The file changed. Refresh the PR.': 'Файл змінився. Онови PR.',
	'From the summary: {text}': 'З підсумку: {text}',
	'Back to Overview': 'До Огляду',
	'check failed': 'помилка',
	'check running': 'виконується',
	'checks green': 'успішні',
	Merging: 'Мердж',
	'Without conflicts': 'Без конфліктів',
	'Merge commit method': 'Merge commit',
	Fixes: 'Виправлення',
	'PR task': 'Задача PR',
	'A draft from the agent': 'Чернетка від агента',
	'Your draft': 'Твоя чернетка',
	'{n} handed to the agent': '{n} передано агенту',
	'{n} of {total} chosen': '{n} з {total} вибрано',
	'Reply in the PR': 'Відповісти в PR',
	'The task «{title}» started': 'Задачу «{title}» запущено',
	'Reply to the review #{n}': 'Відповісти на ревʼю #{n}',
	'Quick task started': 'Швидку задачу запущено',
	'Show the commits': 'Показати коміти',
	'Opening…': 'Відкриття…',
	// spec/pull-requests-and-ci#pr-files: a PR file that is opening, and «Переглянуто» that GitHub has not saved yet.
	'Downloading the PR branch from GitHub…': 'Завантаження branch PR з GitHub…',
	'Reading the file changes…': 'Завантаження змін файла…',
	'saving…': 'збереження…',
	'GitHub did not save the «Viewed» mark for {file}.':
		'GitHub не зберіг позначку «Переглянуто» для {file}.',
	Quickly: 'Швидко',
	'In a worktree': 'У worktree',
	'In the main tree, the branch stays': 'Основне дерево без перемикання branch',
	'Branch {branch}, dependencies can be installed and run':
		'Branch {branch}. Можна встановлювати залежності й запускати код.',
	'Where the agent reviews': 'Де агент робить ревʼю',
	// spec/pull-requests-and-ci#review-launch, spec/pull-requests-and-ci#review-notes
	'Review with an agent…': 'Ревʼю з агентом…',
	'With an agent…': 'З агентом…',
	'Open the review': 'Відкрити ревʼю',
	'What should the reviewer look at? (optional)': 'На що подивитися ревʼюеру? (необовʼязково)',
	'What should the reviewers look at? (optional)': 'На що подивитися ревʼюерам? (необовʼязково)',
	'Notes for the reviewer': 'Нотатки для ревʼюера',
	'Where the agent works': 'Де',
	'Who reviews': 'Хто',
	'file or folder': 'файл або тека',
	'The foreman passes your notes to each reviewer':
		'Бригадир передасть твої нотатки кожному ревʼюеру',
	'Project review notes': 'Нотатки проєкту для ревʼю',
	'Review notes': 'Нотатки для ревʼю',
	'Review notes…': 'Нотатки для ревʼю…',
	'Every review with an agent in this project gets these notes.':
		'Ці нотатки отримує кожне ревʼю з агентом у цьому проєкті.',
	'In the project': 'У проєкті',
	'REVIEW.md in the repo': 'REVIEW.md у repo',
	'The agent reads it at the PR base.': 'Агент читає його з бази PR.',
	'Could not save the review notes.': 'Не вдалося зберегти нотатки для ревʼю.',
	'Review notes text': 'Текст нотаток для ревʼю',
	'Reply to the agent': 'Відповісти агенту',
	'Send to the agent': 'Надіслати агенту',
	'Write to the agent…': 'Напиши агенту…',
	'updated by the agent': 'оновлено агентом',
	'The review task is gone': 'Задачі ревʼю вже немає',
	'Plan for approval': 'План на погодження',
	'{agent} is waiting for approval': '{agent} чекає погодження',
	'{agent} is writing…': '{agent} пише…',
	'Whole plan · {n}': 'Увесь план · {n}',
	'Collapse plan': 'Згорнути план',
	'Show the changes or the plan': 'Показати зміни або план',
	'since revision {n}': 'від ревізії {n}',
	'most lines changed since revision {n}': 'більшість рядків змінено від ревізії {n}',
	'no changes since revision {n}': 'без змін від ревізії {n}',
	'since your edits': 'від твоїх правок',
	Rewritten: 'Переписано',
	Introduction: 'Вступ',
	unchanged: 'без змін',
	'All changes · {n}': 'Усі зміни · {n}',
	'Collapse changes': 'Згорнути зміни',
	'Plan further…': 'Планувати далі…',
	'Ask about the plan or say what to change': 'Запитайте про план або скажіть, що змінити',
	'How to approve': 'Як погодити',
	'How to approve · the agent’s options': 'Як погодити · варіанти агента',
	'Send edits': 'Надіслати правки',
	'edited in the editor': 'змінено в редакторі',
	'What should change in the plan?': 'Що змінити в плані?',
	'⌘↩ send · Esc cancel': '{shortcut} надіслати · Esc скасувати',
	'Plan in revision': 'План на доопрацюванні',
	'The plan copy could not be opened.': 'Копію плану не вдалося відкрити.',
	'Reject the plan and tell the agent what to change':
		'Відхилити план і сказати агенту, що змінити',
	'Open {file} in the editor': 'Відкрити {file} у редакторі',
	'Approve plan': 'Погодити',
	'The plan is approved': 'План погоджено',
	'Back to chat': 'До чату',
	'The window stopped because of an error': 'Помилка вікна',
	'Agents and commands continue to run. When the window reloads, your tasks and chats stay in their places.':
		'Агенти й команди працюють далі.',
	'The application files changed. Restart Brigadir.':
		'Файли застосунку змінились. Перезапусти Бригадир.',
	'Reload the window': 'Перезавантажити вікно',
	'The app code changed. Save your changes and reload the window.':
		'Код застосунку змінився. Збережи зміни й перезавантаж вікно.',
	'Copy the details': 'Копіювати деталі',
	'Error details': 'Деталі помилки',
	'Show again': 'Показати знову',
	'The task window stopped because of an error': 'Помилка вікна задачі',
	'The board stopped because of an error': 'Помилка дошки',
	'The chat stopped because of an error': 'Помилка чату',
	'The document stopped because of an error': 'Помилка документа',
	'The panel stopped because of an error': 'Помилка панелі',
	'The console stopped because of an error': 'Помилка консолі',
	'The browser stopped because of an error': 'Помилка браузера',
	'The simulator stopped because of an error': 'Помилка симулятора',
	'The Brigadir window crashes again': 'Повторний збій вікна Бригадира',
	'The window process stopped two times in one minute.': 'Процес вікна зупинився двічі за хвилину.',
	// spec/chat#mcp-calls: MCP calls in the log — the verb by state (doing, done, not done), the second-line words and the fields of the expanded row.
	'Proposing a split': 'Пропонує розбиття',
	'Proposed a split': 'Запропонував розбиття',
	'Could not propose a split': 'Розбиття не запропоновано',
	'Assigning a part': 'Доручає частину',
	'Assigned a part': 'Доручив частину',
	'Could not assign the part': 'Частину не доручено',
	'Sending a prompt': 'Надсилає промпт',
	'Sent a prompt': 'Надіслав промпт',
	'Could not send the prompt': 'Промпт не надіслано',
	'Answering the worker': 'Відповідає воркеру',
	'Answered the worker': 'Відповів воркеру',
	'Could not send the answer': 'Відповідь не надіслано',
	'Checking the status': 'Перевіряє стан',
	'Checked the status': 'Перевірив стан',
	'Could not get the status': 'Стан не отримано',
	'Reading the report': 'Читає звіт',
	'Read the report': 'Прочитав звіт',
	'Could not read the report': 'Звіт не прочитано',
	'Reading the chat': 'Читає чат',
	'Read the chat': 'Прочитав чат',
	'Could not read the chat': 'Чат не прочитано',
	'Reading the changes': 'Переглядає зміни',
	'Read the changes': 'Переглянув зміни',
	'Could not read the changes': 'Зміни не прочитано',
	'Sending the review': 'Надсилає ревʼю',
	'Sent the review': 'Надіслав ревʼю',
	'Could not send the review': 'Ревʼю не надіслано',
	'Approving the work': 'Схвалює роботу',
	'Approved the work': 'Схвалив роботу',
	'Could not approve the work': 'Роботу не схвалено',
	'Accepting the part': 'Приймає частину',
	'Accepted the part': 'Прийняв частину',
	'Could not accept the part': 'Частину не прийнято',
	'Asking the foreman': 'Питає бригадира',
	'Asked the foreman': 'Спитав бригадира',
	'Could not ask the foreman': 'Питання бригадиру не надіслано',
	'Writing a log entry': 'Пише запис',
	'Left a log entry': 'Залишив запис',
	'Could not leave the log entry': 'Запис не залишено',
	'Reading the crew log': 'Читає записи бригади',
	'Read the crew log': 'Прочитав записи бригади',
	'Could not read the crew log': 'Записи бригади не прочитано',
	'Asking you': 'Питає тебе',
	'Asked you': 'Спитав тебе',
	'Could not ask you': 'Питання тобі не надіслано',
	// spec/tasks#agent-created-tasks: create_task and its card.
	'Proposing a task': 'Пропонує задачу',
	'Proposed a task': 'Запропонував задачу',
	'Could not propose a task': 'Задачу не запропоновано',
	'The agent proposes a new task.': 'Агент пропонує нову задачу.',
	'Proposed in': 'Запропоновано в',
	'full patch': 'повний патч',
	'{agent} proposes a task': '{agent} пропонує задачу',
	'The task could not be created.': 'Не вдалося створити задачу.',
	'Starts once created · new branch': 'Запуск одразу · нова branch',
	'Goes to the backlog · new branch': 'У беклог · нова branch',
	Decline: 'Відхилити',
	'Open in the sheet…': 'Параметри задачі…',
	'Task created': 'Задачу створено',
	'Task not created': 'Задачу не створено',
	'Created from': 'Створено з',
	// spec/projects-and-board#folders-mid-task: a folder joins a running task.
	'Adding a folder': 'Додає теку',
	'Added a folder': 'Додав теку',
	'Could not add the folder': 'Теку не додано',
	'Posting to Slack': 'Пише в Slack',
	'Posted to Slack': 'Написав у Slack',
	'Could not post to Slack': 'Не вдалося написати в Slack',
	'the task’s Slack thread': 'тред задачі в Slack',
	// spec/tasks#task-messages: an agent writes to another task of the project.
	'Looking up tasks': 'Шукає задачі',
	'Looked up tasks': 'Знайшов задачі',
	'Could not look up tasks': 'Не вдалося знайти задачі',
	'Writing to a task': 'Пише в задачу',
	'Wrote to a task': 'Написав у задачу',
	'Offering a review': 'Пропонує ревʼю',
	'Offered a review': 'Запропонував ревʼю',
	'Could not offer a review': 'Не вдалося запропонувати ревʼю',
	'Could not write to the task': 'Не вдалося написати в задачу',
	'No task with this ID in this project. Call tasks_list for the IDs.': 'немає такої задачі',
	'This is your own task.': 'це ця сама задача',
	'A crew worker takes messages through its crew’s task: use crewTaskId.': 'воркер бригади',
	'The task is archived.': 'задача в архіві',
	'The task is in the backlog and has not started.': 'задача в беклозі',
	'The task runs in a CLI terminal and takes no messages.': 'задача в CLI',
	'The task’s agent could not start. Try again later.': 'агент не запустився',
	'The person declined the message.': 'відхилено',
	// The agent asked, the folder did not join: refused by the person or already in the task.
	'Did not add the folder': 'Не додав теку',
	'The person declined adding the folder.': 'відхилено',
	'The folder is already in the task.': 'вже в задачі',
	'The folder could not be added.': 'Не вдалося додати теку.',
	'reading only': 'лише читання',
	'The folder is locked by another task.': 'Теку зайнято іншою задачею.',
	'Opening the page': 'Відкриває сторінку',
	'Opened the page': 'Відкрив сторінку',
	'Could not open the page': 'Сторінку не відкрито',
	'Checking the browser': 'Перевіряє браузер',
	'Checked the browser': 'Перевірив браузер',
	'Could not check the browser': 'Браузер не перевірено',
	'Reading the page': 'Читає сторінку',
	'Read the page': 'Прочитав сторінку',
	'Could not read the page': 'Сторінку не прочитано',
	'Reading the page console': 'Читає консоль сторінки',
	'Read the page console': 'Прочитав консоль сторінки',
	'Could not read the page console': 'Консоль сторінки не прочитано',
	'Reading the page requests': 'Переглядає запити сторінки',
	'Read the page requests': 'Переглянув запити сторінки',
	'Could not read the page requests': 'Запити сторінки не прочитано',
	'Taking a page screenshot': 'Знімає сторінку',
	'Took a page screenshot': 'Зняв сторінку',
	'Could not take a page screenshot': 'Знімок сторінки не зроблено',
	'Reading the page elements': 'Читає елементи сторінки',
	'Read the page elements': 'Прочитав елементи сторінки',
	'Could not read the page elements': 'Елементи сторінки не прочитано',
	'Acting on the page': 'Діє на сторінці',
	'Acted on the page': 'Виконав дію на сторінці',
	'Could not act on the page': 'Дію на сторінці не виконано',
	Clicking: 'Клікає',
	Clicked: 'Клікнув',
	Hovering: 'Наводить',
	Hovered: 'Навів',
	'Scrolling the page': 'Прокручує сторінку',
	'Scrolled the page': 'Прокрутив сторінку',
	'Choosing an option': 'Вибирає варіант',
	'Chose an option': 'Вибрав варіант',
	'Going back': 'Повертається назад',
	'Went back': 'Повернувся назад',
	'Going forward': 'Іде вперед',
	'Went forward': 'Пішов уперед',
	'Reloading the page': 'Перезавантажує сторінку',
	'Reloaded the page': 'Перезавантажив сторінку',
	'Asking to show the page': 'Просить показати сторінку',
	'Asked to show the page': 'Попросив показати сторінку',
	'Could not show the page': 'Сторінку не показано',
	'Setting the dialog answer': 'Задає відповідь діалогу',
	'Set the dialog answer': 'Задав відповідь діалогу',
	'Reading the task clipboard': 'Читає буфер задачі',
	'Read the task clipboard': 'Прочитав буфер задачі',
	'Pasting text': 'Вставляє текст',
	'Pasted text': 'Вставив текст',
	// spec/browser-and-simulator#background: the agent's browser in a task that is not on screen.
	'Agent in the browser': 'Агент у браузері',
	'The agent needs the page on screen': 'Агенту потрібна сторінка на екрані',
	'Decline (show the page)': 'Відмовити',
	'Agents can act on any site without confirmation':
		'Агенти можуть діяти на будь-якому сайті без підтвердження',
	'No permission card for actions. Local pages never ask.':
		'Без картки дозволу на дії. Локальні сторінки не питають.',
	// spec/notifications-slack-notes-and-schedules#slack-agent-post: Settings ▸ Modules ▸ Slack.
	'Agents can post without confirmation': 'Агенти можуть писати без підтвердження',
	"No permission card before an agent's message. The message still shows in the chat.":
		'Без картки дозволу перед повідомленням агента. Повідомлення все одно видно в чаті.',
	'Checking the simulator': 'Перевіряє симулятор',
	'Checked the simulator': 'Перевірив симулятор',
	'Could not check the simulator': 'Симулятор не перевірено',
	'Starting the simulator': 'Запускає симулятор',
	'Started the simulator': 'Запустив симулятор',
	'Could not start the simulator': 'Симулятор не запущено',
	'Reading the screen': 'Читає екран',
	'Read the screen': 'Прочитав екран',
	'Could not read the screen': 'Екран не прочитано',
	Tapping: 'Торкається',
	Tapped: 'Торкнувся',
	'Long-pressing': 'Утримує',
	'Long-pressed': 'Утримав',
	Swiping: 'Свайпає',
	Swiped: 'Свайпнув',
	'Typing text': 'Набирає текст',
	'Typed text': 'Набрав текст',
	'Pressing a key': 'Натискає клавішу',
	'Pressed a key': 'Натиснув клавішу',
	'Pressing a button': 'Натискає кнопку',
	'Pressed a button': 'Натиснув кнопку',
	'Rotating the simulator': 'Повертає симулятор',
	'Rotated the simulator': 'Повернув симулятор',
	'Could not act on the simulator': 'Дію на симуляторі не виконано',
	'Taking a simulator screenshot': 'Знімає екран симулятора',
	'Took a simulator screenshot': 'Зняв екран симулятора',
	'Could not take a simulator screenshot': 'Знімок екрана не зроблено',
	'Reading the app logs': 'Читає логи застосунку',
	'Read the app logs': 'Прочитав логи застосунку',
	'Could not read the app logs': 'Логи застосунку не прочитано',
	'Reading the app requests': 'Переглядає запити застосунку',
	'Read the app requests': 'Переглянув запити застосунку',
	'Could not read the app requests': 'Запити застосунку не прочитано',
	'Writing a draft comment': 'Пише чернетку коментаря',
	'Left a draft comment': 'Залишив чернетку коментаря',
	'Could not save the draft comment': 'Чернетку коментаря не збережено',
	'Replying in the thread': 'Відповідає в треді',
	'Replied in the thread': 'Відповів у треді',
	'Could not reply in the thread': 'Відповідь у треді не надіслано',
	// spec/agents-and-providers#context-tools: what the person is looking at.
	'Looking at your editor': 'Читає редактор',
	'Looked at your editor': 'Прочитав редактор',
	'Could not see your editor': 'Редактор не прочитано',
	'Looking at the PR': 'Переглядає PR',
	'Looked at the PR': 'Переглянув PR',
	'Could not read the PR': 'PR не прочитано',
	'Checking the project commands': 'Переглядає команди',
	'Checked the project commands': 'Переглянув команди',
	'Could not read the project commands': 'Команди не прочитано',
	'Running a command': 'Запускає команду',
	'Ran a command': 'Запустив команду',
	'Could not run the command': 'Команду не запущено',
	'Reading the command output': 'Читає вивід команди',
	'Read the command output': 'Прочитав вивід команди',
	'Could not read the command output': 'Вивід команди не прочитано',
	'Stopping a command': 'Зупиняє команду',
	'Stopped a command': 'Зупинив команду',
	'Could not stop the command': 'Команду не зупинено',
	// spec/terminal-and-cli-agents#agent-console-tools: the agent reads the console of its task.
	'Checking the console': 'Переглядає консоль',
	'Checked the console': 'Переглянув консоль',
	'Reading the console': 'Читає консоль',
	'Read the console': 'Прочитав консоль',
	'Could not read the console': 'Консоль не прочитано',
	'no console is open': 'консоль не відкрита',
	'Agents can run it without confirmation': 'Агенти можуть запускати без підтвердження',
	'the window is closed': 'вікно закрите',
	'nothing is open': 'нічого не відкрито',
	'no PR is open': 'PR не відкрито',
	'in the backlog': 'у беклозі',
	'in the queue': 'у черзі',
	preparing: 'готується',
	'is working': 'працює',
	'waits for you': 'чекає тебе',
	'is finished': 'завершено',
	interrupted: 'перервано',
	'stopped with an error': 'з помилкою',
	'at the limit': 'на ліміті',
	agreed: 'погоджено',
	rejected: 'відхилено',
	'part {n}': 'частина {n}',
	'commit {sha}': 'коміт {sha}',
	yes: 'так',
	no: 'ні',
	Status: 'Стан',
	'Changed files': 'Змінені файли',
	'Working now': 'Працює зараз',
	Accepted: 'Прийнято',
	Conflicts: 'Конфлікти',
	Response: 'Відповідь',
	'Page title': 'Заголовок сторінки',
	// spec/chat#subagents: the subagent block.
	Subagent: 'Сабагент',
	'Show in full': 'Показати повністю',
	'Show less': 'Згорнути',
	'Show all': 'Показати всі',
	error: 'помилка',
	'The answer comes when the subagent finishes': 'Відповідь після завершення роботи сабагента',
	'Stopped before the answer': 'Перервано до відповіді',
	'Show JSON': 'Показати JSON',
	'last message': 'останнє повідомлення',
	'and {files} more': 'ще {files}',
	'Hide JSON': 'Сховати JSON',
	Input: 'Вхід',
	Result: 'Результат',
	'Brigadir tool': 'Інструмент Бригадира',
	'Tool of another server': 'Інструмент іншого сервера',
	// spec/agents-and-providers#sign-in-recovery: an expired agent sign-in.
	'{agent} asks you to sign in again': '{agent} просить увійти знову',
	'{agent} asked you to sign in again': '{agent} просив увійти знову',
	'Claude Code · subscription': 'Claude Code · підписка',
	'The subscription sign-in expired and did not renew, so the message did not reach the agent. After you sign in, Brigadir sends it again.':
		'Сесія входу завершилася. Увійди знову для автоматичного повторного надсилання.',
	'The subscription sign-in expired and did not renew, so the agent did not start. After you sign in, it starts again.':
		'Сесія входу завершилася. Увійди знову для автоматичного запуску агента.',
	'Sign in to {agent}…': 'Увійти в {agent}…',
	'Waiting for the sign-in in the browser…': 'Очікування входу в браузері…',
	'The browser opened the {agent} sign-in page. Once you sign in, the message goes to the agent by itself.':
		'Відкрито вхід у {agent}. Після входу повідомлення надішлеться автоматично.',
	'Open the page again': 'Відкрити сторінку ще раз',
	'Enter the code': 'Ввести код',
	'Code from the page': 'Код зі сторінки',
	'Sign in': 'Увійти',
	'Sign-in was not finished: the page closed before the end of the sign-in.':
		'Вхід не завершено. Сторінку закрито.',
	'Signed in to {agent} · the message was sent again':
		'Вхід у {agent} виконано. Повідомлення надіслано повторно.',
	'{agent} sign-in needed': 'Потрібен вхід у {agent}',
	'Sign-in expired': 'Сесія входу завершилася',
	'The sign-in could not start.': 'Вхід не вдалося запустити.',
	'The code was not accepted.': 'Код не прийнято.',
	// spec/composer-steering-queue-and-ghost#quick-question: a quick question to the agent from a selection.
	'Quick question': 'Швидке питання',
	'outside the task chat': 'поза чатом задачі',
	'“{task}” holds the repo. The agent only answers.':
		'Repo зайняв «{task}». Агент лише відповість.',
	Ask: 'Спитати',
	'Ask more…': 'Спитати ще…',
	'Ask {agent}…': 'Спитати {agent}…',
	task: 'задача',
	'A new {agent} session. It gets the selection, not the answers above.':
		'Нова сесія {agent}. Відповіді вище не передаються.',
	'New session': 'Нова сесія',
	'{agent} limit · {time}': 'Ліміт {agent} · {time}',
	'Ask again with {agent}': 'Спитати ще раз у {agent}',
	'Pick another model below.': 'Вибери іншу модель нижче.',
	'What do you want to know about these lines?': 'Питання про виділені рядки',
	'Question to the agent': 'Питання агенту',
	Starting: 'Запускається',
	'Applied to {file}': 'Застосовано у {file}',
	'Undo the apply': 'Скасувати застосування',
	'The lines changed after the answer. Ask again.':
		'Рядки змінилися після відповіді. Спитай знову.',
	'Open the file in the editor to apply.': 'Відкрий файл у редакторі для застосування.',
	Changed: 'Змінено',
	'View diff': 'Переглянути диф',
	'Reverted: {file}': 'Відкочено: {file}',
	'The file changed after the question. It cannot be reverted.':
		'Файл змінився після питання. Відкотити не можна.',
	'The answer stays until the window closes.': 'Відповідь доступна до закриття вікна.',
	'New question': 'Нове питання',
	'The agent did not answer: {reason}.': 'Агент не відповів: {reason}.',
	'the subscription limit is used up': 'вичерпано ліміт підписки',
	'The answer was stopped': 'відповідь зупинено',
	'Ask the agent about the selected lines': 'Спитати агента про виділені рядки',
	// spec/tasks#archive task archive
	'Archive task': 'Архівувати задачу',
	Archive: 'Архівувати',
	'Archive…': 'Архів…',
	'Archive (noun)': 'Архів',
	'Restore from archive': 'Повернути з архіву',
	'Restore {n}': 'Повернути {n}',
	'All (archive)': 'Усі',
	'Open the Archive window': 'Відкрити вікно «Архів»',
	'Open the Archive window with this project': 'Відкрити вікно «Архів» з цим проєктом',
	'{n} more': 'Ще {n}',
	'«{title}» is in the archive': '«{title}» в архіві',
	Complete: 'Завершити',
	'«{title}» is completed': '«{title}» завершена',
	'The task is in the archive. The transcript is read-only.':
		'Задача в архіві. Транскрипт лише для читання.',
	'Archive the list': 'Архівувати список',
	'Archive the list…': 'Архівувати список…',
	'Archive hides the tasks and deletes nothing.':
		'Зберігає задачі й історію. Видаляє чисті worktree; незакомічені зміни зберігає.',
	'Delete all…': 'Видалити всі…',
	'Delete all from the archive': 'Видалити все з архіву',
	'Archive hides the task and deletes nothing.':
		'Зберігає задачу й історію. Видаляє чистий worktree; незакомічені зміни зберігає.',
	'Search the archive: title, prompt, branch': 'Шукати в архіві: назва, промпт, branch',
	Manually: 'Вручну',
	'Auto (archive)': 'Авто',
	manually: 'вручну',
	'auto (archive)': 'авто',
	Today: 'Сьогодні',
	'This week': 'Цього тижня',
	'Archived manually': 'Архівовано вручну',
	'Archived automatically': 'Архівовано автоматично',
	'Auto-archive is off': 'Авто-архів вимкнено',
	'Select (archive)': 'вибрати',
	restore: 'повернути',
	'open (archive)': 'відкрити',
	'delete…': 'видалити…',
	'Selected {n}': 'Вибрано {n}',
	'Delete…': 'Видалити…',
	// spec/task-window#files-delete: a file or folder of the Files tree goes to the Trash.
	'Delete {name}?': 'Видалити {name}?',
	'The file goes to the Trash.': 'Файл піде у Смітник.',
	'The folder and everything in it go to the Trash.': 'Тека й усе в ній підуть у Смітник.',
	'The archive has no «{query}».': 'В архіві немає «{query}».',
	'Search all tasks': 'Шукати в усіх задачах',
	'The archive is empty.': 'Архів порожній.',
	'Chat logs and change snapshots go to the Trash': 'Журнали чату й знімки змін ідуть у Смітник',
	'Branches stay: {branches}': 'Branch лишаються: {branches}',
	'Worktrees were already removed by the archive; nothing is lost':
		'Worktree вже видалено під час архівування.',
	'Worktrees with uncommitted changes are removed: {files}':
		'Буде втрачено незакомічені зміни у worktree: {files}',
	'Branch {branch} stays': 'Branch {branch} лишилась',
	'The worktree is removed. Continuing the task creates it again from this branch.':
		'Worktree видалено. Продовження задачі створить його з цієї branch.',
	'No worktree: the task worked in the main tree.':
		'Без worktree: задача працювала в основному дереві.',
	'change snapshots are in place': 'знімки змін збережено',
	'in the archive {when}': 'в архіві {when}',
	'In the archive': 'В архіві',
	'in the archive': 'в архіві',
	'Uncommitted changes in the worktree': 'У worktree є незакомічені зміни',
	'Goes to the archive today': 'Архівування сьогодні',
	'Goes to the archive tomorrow': 'Архівування завтра',
	'Archive completed': 'Архівувати завершені',
	'After 1 day': 'Через 1 день',
	'After 3 days': 'Через 3 дні',
	'After 7 days': 'Через 7 днів',
	'After 30 days': 'Через 30 днів',
	'Only tasks you marked completed. Stopped and failed tasks stay in the sidebar.':
		'Лише позначені завершеними задачі.',
	'Completed tasks go to the archive after {days}': 'Архівування завершених задач через {days}',
	'completed {when}': 'завершена {when}',
	'The task cannot go to the archive while its agent works.':
		'Архівування недоступне, поки агент працює.',
	'Archive actions': 'Дії архіву',
	'Tasks in the archive': 'Задачі в архіві',
	// spec/architecture-and-platform#window-frame: the window on Windows and Linux — the menu button, its File and Help items, and the keys the desktop keeps.
	'Application menu': 'Меню застосунку',
	Help: 'Довідка',
	'Exit Brigadir': 'Вийти',
	'{key} is reserved by the system: {name}.': '{key} зайняте системою: {name}.',
	'Close the window': 'закриття вікна',
	'Window switcher': 'перемикач вікон',
	'Window menu': 'меню вікна',
	'Start menu': 'меню «Пуск»',
	'Task Manager': 'диспетчер задач',
	'Security screen': 'екран безпеки',
	'Lock screen': 'блокування екрана',
	'Unicode input': 'введення Unicode',
	Workspaces: 'робочі столи',
	// spec/composer#mentions: mentions in the composer text and the tabs of the `@` menu.
	'All mentions': 'Усі',
	Models: 'Моделі',
	'Mention groups': 'Групи згадок',
	'next tab': 'наступна',
	'task model': 'модель задачі',
	'Goes to the agent as text: the model id and the provider. The task model does not change.':
		'Модель задачі не змінюється.',
	'The attachment is no longer available.': 'Вкладення вже недоступне.',
	'The task summary could not be attached.': 'Не вдалося прикріпити підсумок задачі.',
	'The agent template could not be attached.': 'Не вдалося прикріпити шаблон агента.',
	'Goes to the agent as a role for a subagent: the agent starts one when you ask.':
		'Іде агенту як роль для сабагента: агент запускає його, коли ви попросите.',
	// spec/notifications-slack-notes-and-schedules#message-classes: class T toasts — the region and texts that name the action and its object.
	'Notifications (toasts)': 'Сповіщення',
	'{repo} · changed': '{repo} · змінено',
	'{repos} · changed': '{repos} · змінено',
	'A read-only repo changed: {repos}': 'Змінився repo лише для читання: {repos}',
	'A read-only repo changed': 'Змінився repo лише для читання',
	'Opened because files changed in a read-only repo.':
		'Автоматично відкрито через зміни в repo лише для читання.',
	'Opens by itself when other files change there.':
		'Відкривається при зміні інших файлів у цих repo.',
	'The task only reads these repos, but files in them changed during the turn.':
		'У цих repo дозволено лише читання. Файли змінилися під час турну.',
	'new (file)': 'нове',
	'unavailable (repo)': 'недоступне',
	'{repo} · unavailable': '{repo} · недоступне',
	'{repos} · unavailable': '{repos} · недоступні',
	'Unavailable repos: {repos}': 'Недоступні repo: {repos}',
	'Unavailable repos': 'Недоступні repo',
	'Opened because a repo of the task is unavailable.':
		'Автоматично відкрито через недоступний repo.',
	'Opens by itself when another repo becomes unavailable.':
		'Відкривається, коли інший repo стає недоступним.',
	'Brigadir does not see these repos on disk. Their changes are not tracked until the folder comes back.':
		'Repo недоступні на диску. Відстеження змін відновиться після відновлення доступу.',
	'Limit · {time}': 'Ліміт · {time}',
	'Subscription limit': 'Ліміт підписки',
	'Opened because the agent reached the subscription limit.':
		'Автоматично відкрито через ліміт підписки.',
	'Opens by itself at the next limit.': 'Відкривається при наступному досягненні ліміту.',
	'{agent} · sign-in needed': '{agent} · потрібен вхід',
	'The message has already left the queue.': 'Повідомлення вже не в черзі.',
	'Could not close the file.': 'Не вдалося закрити файл.',
	'Could not add {file} to the composer.': 'Не вдалося додати {file} у композер.',
	'Could not open a terminal in {file}.': 'Не вдалося відкрити термінал у {file}.',
	'Could not compare {file} with the disk.': 'Не вдалося порівняти {file} з версією на диску.',
	'Could not remove the file comments.': 'Не вдалося прибрати коментарі файла.',
	'Could not open {file} from the commit.': 'Не вдалося відкрити {file} з коміту.',
	'Could not check {file} on disk.': 'Не вдалося перевірити {file} на диску.',
	'Could not save {file}.': 'Не вдалося зберегти {file}.',
	'Could not open the file.': 'Не вдалося відкрити файл.',
	'Could not copy the commit hash.': 'Не вдалося скопіювати хеш коміту.',
	'Could not read the commit list.': 'Не вдалося завантажити список змін для коміту.',
	'Could not generate the commit message.': 'Не вдалося згенерувати повідомлення коміту.',
	'Could not commit the changes.': 'Не вдалося закомітити зміни.',
	'Files changed. Review the commit list again.': 'Файли змінилися. Перевір зміни для коміту.',
	'The branch changed. Refresh the commit list.': 'Branch змінилася. Онови список змін для коміту.',
	'Files or staging changed. Review the commit list again.':
		'Файли або індекс Git змінилися. Перевір зміни для коміту.',
	'Could not read the Git history.': 'Не вдалося прочитати історію Git.',
	'Could not open the commit.': 'Не вдалося відкрити коміт.',
	'Could not resolve the conflict in {file}.': 'Не вдалося вирішити конфлікт у {file}.',
	'Could not mark {file} resolved.': 'Не вдалося позначити конфлікти в {file} вирішеними.',
	'Could not abort the merge.': 'Не вдалося скасувати мердж.',
	'Could not hand the conflicts to the agent.': 'Не вдалося передати конфлікти агенту.',
	'Could not finish the merge.': 'Не вдалося завершити мердж.',
	'Could not take the PR out of draft.': 'Не вдалося позначити PR готовим до ревʼю.',
	'GitHub did not accept the comment.': 'GitHub не прийняв коментар.',
	'Could not save the draft.': 'Не вдалося зберегти чернетку.',
	'Could not delete the draft.': 'Не вдалося видалити чернетку.',
	'Could not resolve the thread.': 'Не вдалося вирішити тред.',
	'Could not reopen the thread.': 'Не вдалося відкрити тред знову.',
	'Could not save the review.': 'Не вдалося зберегти ревʼю.',
	'Could not send the review. The drafts are saved.':
		'Не вдалося надіслати ревʼю. Чернетки збережено.',
	'Could not read the chat history.': 'Не вдалося прочитати історію чату.',
	'Could not attach the file.': 'Не вдалося прикріпити файл.',
	'Could not search the files.': 'Не вдалося знайти файли.',
	'Could not run the menu action.': 'Не вдалося виконати дію меню.',
	'Could not change the agent mode.': 'Не вдалося змінити режим агента.',
	'Could not change the agent setting.': 'Не вдалося змінити налаштування агента.',
	'Could not send the decision on the plan.': 'Не вдалося надіслати рішення щодо плану.',
	'Could not remove the message from the queue.': 'Не вдалося прибрати повідомлення з черги.',
	'Could not resume the queue.': 'Не вдалося продовжити чергу.',
	'Could not retry the turn.': 'Не вдалося повторити турн.',
	'Could not send the command to the agent.': 'Не вдалося передати команду агенту.',
	'Could not start the agent.': 'Не вдалося запустити агента.',
	'Could not read the terminal list.': 'Не вдалося прочитати список терміналів.',
	'Could not open a new terminal.': 'Не вдалося відкрити новий термінал.',
	'Could not read the terminal output.': 'Не вдалося прочитати вивід термінала.',
	'Could not send the input to the terminal.': 'Не вдалося передати введення в термінал.',
	'Could not resize the terminal.': 'Не вдалося змінити розмір термінала.',
	'Could not clear the terminal.': 'Не вдалося очистити термінал.',
	'Could not interrupt the terminal process.': 'Не вдалося перервати процес термінала.',
	'Could not run the command.': 'Не вдалося запустити команду.',
	'Could not close the terminal.': 'Не вдалося закрити термінал.',
	// spec/task-window-workspace#restore-window: a terminal tab after a restart whose host session ended.
	'Session ended': 'Сеанс завершено',
	'Open again': 'Відкрити знову',
	'Could not show the terminal output to the agent.': 'Не вдалося показати агенту вивід термінала.',
	'Could not open the port in the browser.': 'Не вдалося відкрити порт у браузері.',
	'Could not stop the command.': 'Не вдалося зупинити команду.',
	'Could not read the setup log.': 'Не вдалося прочитати журнал налаштування.',
	'Could not cancel the preparation.': 'Не вдалося скасувати підготовку.',
	'Could not start the task.': 'Не вдалося запустити задачу.',
	'Could not open the page.': 'Не вдалося відкрити сторінку.',
	'Could not reload the page.': 'Не вдалося перезавантажити сторінку.',
	'Could not open the page in the default browser.':
		'Не вдалося відкрити сторінку в системному браузері.',
	'Could not switch the browser view.': 'Не вдалося перемкнути вигляд браузера.',
	'Could not switch node selection.': 'Не вдалося перемкнути вибір елемента.',
	'Could not read the request details.': 'Не вдалося прочитати деталі запиту.',
	'Could not take a page screenshot.': 'Не вдалося зробити знімок сторінки.',
	'Could not attach the screenshot.': 'Не вдалося прикріпити знімок.',
	'Could not attach the node.': 'Не вдалося прикріпити елемент.',
	'Could not show the browser.': 'Не вдалося показати браузер.',
	'Could not show the page console to the agent.': 'Не вдалося показати агенту консоль сторінки.',
	'Could not show the network requests to the agent.': 'Не вдалося показати агенту запити мережі.',
	'Could not show the request details to the agent.': 'Не вдалося показати агенту деталі запиту.',
	'Could not read the simulator state.': 'Не вдалося прочитати стан симулятора.',
	'Could not show the simulator screen.': 'Не вдалося показати екран симулятора.',
	'Could not switch the simulator.': 'Не вдалося змінити симулятор.',
	'Could not start the simulator.': 'Не вдалося запустити симулятор.',
	'Could not shut down the simulator.': 'Не вдалося вимкнути симулятор.',
	'Could not send the input to the simulator.': 'Не вдалося передати введення на симулятор.',
	'Could not rotate the simulator.': 'Не вдалося повернути симулятор.',
	'Could not reload the app.': 'Не вдалося перезавантажити застосунок.',
	'Could not open DevTools.': 'Не вдалося відкрити DevTools.',
	'Could not take a simulator screenshot.': 'Не вдалося зробити знімок екрана симулятора.',
	'Could not remove the attachment.': 'Не вдалося прибрати вкладення.',
	'Could not read the turn changes.': 'Не вдалося прочитати зміни турну.',
	'Could not copy the response.': 'Не вдалося скопіювати відповідь.',
	'Could not decline the task.': 'Не вдалося відхилити задачу.',
	'Could not read the repo list.': 'Не вдалося прочитати список repo.',
	'Could not add {repo} to the task.': 'Не вдалося додати {repo} в задачу.',
	'Could not remove {repo} from the task.': 'Не вдалося прибрати {repo} із задачі.',
	'Could not collapse the repo list.': 'Не вдалося згорнути список repo.',
	'Could not expand the repo list.': 'Не вдалося розгорнути список repo.',
	'Could not remove the worktree.': 'Не вдалося прибрати worktree.',
	'Could not read the project view.': 'Не вдалося прочитати вигляд проєкту.',
	'Could not save the project view.': 'Не вдалося зберегти вигляд проєкту.',
	'Could not move the task.': 'Не вдалося перенести задачу.',
	'Could not archive the list.': 'Не вдалося архівувати список.',
	'Could not read the project knowledge.': 'Не вдалося прочитати знання проєкту.',
	'Could not close the card.': 'Не вдалося закрити картку.',
	'Could not undo the addition.': 'Не вдалося скасувати доповнення.',
	'Could not read the instruction file.': 'Не вдалося прочитати файл інструкцій.',
	'Could not generate the text.': 'Не вдалося згенерувати текст.',
	'Could not add the text. It is kept.': 'Не вдалося додати текст. Текст збережено.',
	'Could not reject the proposal.': 'Не вдалося відхилити пропозицію.',
	'Could not open the task.': 'Не вдалося відкрити задачу.',
	'Could not read the rejected proposals.': 'Не вдалося прочитати відхилені пропозиції.',
	'Could not restore the proposal.': 'Не вдалося повернути пропозицію.',
	'Could not stop the agent.': 'Не вдалося зупинити агента.',
	'Could not kill the process.': 'Не вдалося примусово завершити процес.',
	'Could not run «{name}».': 'Не вдалося запустити «{name}».',
	'Could not stop «{name}».': 'Не вдалося зупинити «{name}».',
	'Could not open localhost:{port}.': 'Не вдалося відкрити localhost:{port}.',
	'Could not duplicate «{name}».': 'Не вдалося дублювати «{name}».',
	'Could not delete «{name}».': 'Не вдалося видалити «{name}».',
	'Could not save the command.': 'Не вдалося зберегти команду.',
	'Could not delete the command.': 'Не вдалося видалити команду.',
	'Not all files are shown.': 'Показано не всі файли.',
	'Could not read the folder.': 'Не вдалося прочитати теку.',
	'Could not filter the tree.': 'Не вдалося відфільтрувати файли.',
	'Could not restore «{title}».': 'Не вдалося повернути «{title}».',
	'Could not restore from the archive.': 'Не вдалося повернути з архіву.',
	'Could not delete from the archive.': 'Не вдалося видалити з архіву.',
	'Could not export the template.': 'Не вдалося експортувати шаблон.',
	'Could not import the template.': 'Не вдалося імпортувати шаблон.',
	'Could not delete the template.': 'Не вдалося видалити шаблон.',
	'Could not restore the default crews.': 'Не вдалося повернути типові бригади.',
	'Could not create the template.': 'Не вдалося створити шаблон.',
	'Could not duplicate the template.': 'Не вдалося дублювати шаблон.',
	'Could not save the formatter.': 'Не вдалося зберегти вибір форматера.',
	'Could not save the comment.': 'Не вдалося зберегти коментар.',
	'Could not update the comment.': 'Не вдалося змінити коментар.',
	'Could not delete the comment.': 'Не вдалося видалити коментар.',
	'Could not delete the review comments.': 'Не вдалося видалити коментарі ревʼю.',
	'Could not delete the general note draft.': 'Не вдалося видалити чернетку загальної нотатки.',
	'Could not read why this changed.': 'Не вдалося визначити причину зміни.',
	'Could not add the project.': 'Не вдалося додати проєкт.',
	'The task menu action failed.': 'Не вдалося виконати дію з меню задачі.',
	'The project menu action failed.': 'Не вдалося виконати дію з меню проєкту.',
	'Could not archive the task.': 'Не вдалося архівувати задачу.',
	'Could not complete the task.': 'Не вдалося завершити задачу.',
	'Could not read the sidebar state.': 'Не вдалося прочитати стан сайдбару.',
	'Could not save the collapsed projects.': 'Не вдалося зберегти стан згортання проєктів.',
	'Could not save the collapsed crews.': 'Не вдалося зберегти стан згортання бригад.',
	'Could not save the collapsed completed tasks.': 'Не вдалося зберегти стан згортання завершених.',
	'Could not send the message.': 'Не вдалося надіслати повідомлення.',
	'Could not attach the selection to the chat.': 'Не вдалося прикріпити виділені рядки до чату.',
	'Could not send the answer to the agent.': 'Не вдалося надіслати відповідь агенту.',
	'Could not read the task changes.': 'Не вдалося прочитати зміни задачі.',
	'Could not take a snapshot of the changes.': 'Не вдалося створити знімок змін.',
	'Could not read the review comments.': 'Не вдалося прочитати коментарі ревʼю.',
	'Could not send the review to the agent.': 'Не вдалося надіслати ревʼю агенту.',
	'Could not stop the turn.': 'Не вдалося зупинити турн.',
	'Could not read the changes in {file}.': 'Не вдалося прочитати зміни в {file}.',
	'The binary file {file} does not open in the editor.':
		'Редактор не підтримує бінарний файл {file}.',
	'{file} is too large for the editor.': '{file} завеликий для редактора.',
	'Could not open {file}.': 'Не вдалося відкрити {file}.',
	'Could not close {file}.': 'Не вдалося закрити {file}.',
	'Could not refresh the changes.': 'Не вдалося оновити зміни.',
	'Could not add the note to the review.': 'Не вдалося додати нотатку до ревʼю.',
	'Could not read the pull request.': 'Не вдалося прочитати PR.',
	'Could not hand the fixes to the agent.': 'Не вдалося передати виправлення агенту.',
	'Could not start the review task.': 'Не вдалося запустити задачу ревʼю.',
	'Could not hand the threads to the agent.': 'Не вдалося передати треди агенту.',
	'Could not send the text to the agent.': 'Не вдалося надіслати текст агенту.',
	'Could not revert {file}.': 'Не вдалося відкотити {file}.',
	'{file} is not among the task changes.': '{file} немає серед змін задачі.',
	'Could not open the menu.': 'Не вдалося відкрити меню.',
	'Could not remove the queued review.': 'Не вдалося прибрати ревʼю з черги.',

	'No worktrees to remove': 'Немає worktree для видалення',
	'Development server': 'Сервер розробки',
	// spec/git#main-tree-branches: the main tree's branch and the git tools.
	'Switch branch': 'Перемкнути branch',
	'Switch branch…': 'Перемкнути branch…',
	'New branch…': 'Нова branch…',
	'New branch': 'Нова branch',
	'Checked out in the worktree of {task}.': 'Відкрита у worktree задачі {task}.',
	'Checked out in another worktree.': 'Відкрита в іншому worktree.',
	'The task {task} is working in {repo} without isolation. You can switch the branch once it stops.':
		'У {repo} працює задача {task} без ізоляції. Branch можна перемкнути, коли вона зупиниться.',
	'Git won’t switch the branch while they are in the tree.':
		'Git не перемкне branch, поки вони в дереві.',
	'Stash and switch': 'Stash і перемкнути',
	'The changes go to the stash. Bring them back from ⋯ ▸ Restore from stash.':
		'Зміни підуть у stash. Повернути — з меню ⋯ ▸ Повернути зі stash.',
	'Bring the changes': 'Взяти зміни з собою',
	'Works when {branch} doesn’t touch these files.':
		'Перемкнеться, якщо {branch} не чіпає ці файли.',
	'Commit first': 'Спершу закомітити',
	'Discard and switch…': 'Відкинути й перемкнути…',
	'The changes are lost. You confirm first.': 'Зміни зникнуть.',
	'To the list': 'До списку',
	'Uncommitted changes move to the new branch.': 'Незакомічені зміни перейдуть на нову branch.',
	'Create and switch': 'Створити й перемкнути',
	'A branch with this name already exists.': 'Branch із такою назвою вже є.',
	Pull: 'Pull',
	'Stash changes': 'Stash змін',
	'Restore from stash…': 'Повернути зі stash…',
	'Undo last commit…': 'Скасувати останній коміт…',
	'Discard changes…': 'Відкинути зміни…',
	'The branch {branch} was deleted from origin after the PR merged.':
		'Branch {branch} видалено з origin після мерджу PR.',
	'The branch has no upstream on origin.': 'Branch не має upstream на origin.',
	'Nothing new on origin.': 'Нічого нового на origin.',
	'The commit is already on origin. Only a new commit (revert) can undo it.':
		'Коміт уже на origin. Скасувати його можна лише новим комітом (revert).',
	'This is the first commit of the repo.': 'Це перший коміт repo.',
	'There are no changes.': 'Змін немає.',
	'No stash entries.': 'Записів у stash немає.',
	Stash: 'Stash',
	'before switching to {branch}': 'перед переходом на {branch}',
	'by hand': 'вручну',
	'«Restore» puts the changes into the current branch and removes the entry. On a conflict the entry stays.':
		'«Повернути» кладе зміни в поточну branch і прибирає запис. Конфлікт — запис лишається.',
	'Delete the stash entry?': 'Видалити запис зі stash?',
	'The changes in it will be lost. This cannot be undone.':
		'Зміни в ньому зникнуть. Скасувати це не можна.',
	'Discard changes in {repo}?': 'Відкинути зміни в {repo}?',
	'They go back to the last commit, and new files are deleted. This cannot be undone.':
		'Вони повернуться до останнього коміту, а нові файли буде видалено. Скасувати це не можна.',
	'Undo the last commit?': 'Скасувати останній коміт?',
	'It leaves the branch, and its changes stay in the tree uncommitted.':
		'Він зникне з branch, а його зміни лишаться в дереві незакоміченими.',
	'Undo commit': 'Скасувати коміт',
	'Could not switch the branch.': 'Не вдалося перемкнути branch.',
	'Could not switch: origin is unreachable.': 'Не вдалося перемкнути: origin недоступний.',
	'Switch without pull': 'Перемкнути без pull',
	'Your changes conflict with {branch}. Nothing was changed.':
		'Зміни конфліктують з {branch}. Нічого не змінено.',
	'Changes stashed.': 'Зміни в stash.',
	'Restored from the stash.': 'Зміни повернуто зі stash.',
	'Could not restore: the changes conflict. The entry stays in the stash.':
		'Не вдалося повернути: зміни конфліктують. Запис лишився в stash.',
	'The branch has diverged from origin. Pull only fast-forwards.':
		'Branch розійшлась з origin. Pull лише перемотує вперед.',
	'The commit is undone. Its changes are in the tree.': 'Коміт скасовано, його зміни в дереві.',
	'Changes discarded.': 'Зміни відкинуто.',
	'The git action failed.': 'Дія git не вдалася.',
	'Another Git operation is in progress.': 'Триває інша операція git.',
	'The repo is busy with another task.': 'Repo зайняте іншою задачею.',
	'Before the start, {repo} switches from {from} to {to}.':
		'Перед стартом {repo} перейде з {from} на {to}.',
	'Before the start, {repo} switches from {from} to {to} and pulls {commits} from origin.':
		'Перед стартом {repo} перейде з {from} на {to} і підтягне {commits} з origin.',
	'Before the start, {repo} switches to a new branch {to} from {from}.':
		'Перед стартом {repo} перейде на нову branch {to} від {from}.',
	'What to do with them before the start:': 'Що з ними зробити перед стартом:',
	'{repo} has {changes}.': 'У {repo} {changes}.',
	'Bring them': 'Взяти з собою',
	'Commit first…': 'Спершу закомітити…',
	'The task goes to the backlog with this branch, and the main tree opens on Changes.':
		'Задача ляже в беклог із цією branch, а основне дерево відкриється на Змінах.',
	'{repo} is held by the task {task}. You can change its branch here once it stops.':
		'{repo} тримає задача {task}. Branch тут можна змінити, коли вона зупиниться.',
	'Switching the branch': 'Перемикаю branch',
	// spec/git#pull: pull and ↓N.
	'Pulling from origin': 'Підтягую з origin',
	'Pull · {commits}': 'Pull · {commits}',
	'Push commits · {commits}': 'Push commits · {commits}',
	'Before the start, {repo} pulls {commits} from origin.':
		'Перед стартом {repo} підтягне {commits} з origin.',
	'Pull before the start': 'Підтягнути перед стартом',
	'Branch of {repo}': 'Branch {repo}',
	'pulled {commits}': 'підтягнуто {commits}',
	// spec/git#pull: a diverged branch pulls by rebase; a conflict stops it and goes to an agent.
	'{commits} on top': '{commits} зверху',
	'{repo}: the pull stopped on a conflict in {files}. Nothing changed.':
		'{repo}: pull зупинився на конфлікті в {files}. Нічого не змінено.',
	'Commit or stash the changes first: a diverged branch pulls by rebase.':
		'Спершу зроби коміт або stash: branch розійшлась, і pull робить rebase.',
	'Resolve with agent': 'Розвести з агентом',
	'The conflict is with the agent.': 'Конфлікт у агента.',
	'Could not hand the conflict to the agent.': 'Не вдалося передати конфлікт агенту.',
	// spec/chat-turns-plans-and-questions#background-commands: the agent's background work (the Background deck, footer chip, Output, sidebar, notifications).
	'In the background · {count}': 'У фоні · {count}',
	'In the background · {name}': 'У фоні · {name}',
	'Background commands': 'Фонові команди',
	'in background': 'у фоні',
	Output: 'Вивід',
	'Output of the background command': 'Вивід фонової команди',
	'Show the output': 'Показати вивід',
	'Stop the background command': 'Зупинити фонову команду',
	'No output yet': 'Виводу ще немає',
	'Last lines · updates every second': 'Останні рядки',
	'The output file is gone.': 'Файла виводу вже немає.',
	'background finished': 'закінчилась',
	'background command': 'фонова команда',
	'The background command finished.': 'Фонова команда закінчилась.',
	'The background command failed.': 'Фонова команда закінчилась з помилкою.',
	'The background command is stopped': 'Фонову команду зупинено',
	'Could not stop the background command.': 'Не вдалося зупинити фонову команду.',
	'Could not read the output.': 'Не вдалося прочитати вивід.',
	'Show background commands': 'Показати фонові команди',
	// spec/chat-turns-plans-and-questions#background-subagents: a subagent that outlived its turn, in the same deck, chip and sidebar line.
	'Background work': 'Фонова робота',
	'Show background work': 'Показати фонову роботу',
	subagent: 'сабагент',
	'subagent finished': 'закінчив',
	'Open the subagent': 'Відкрити сабагента',
	'Stop the subagent': 'Зупинити сабагента',
	'The subagent is stopped': 'Сабагента зупинено',
	'The subagent failed.': 'Сабагент закінчив з помилкою.',
	'Could not stop the subagent.': 'Не вдалося зупинити сабагента.',
	'Subagent {name}': 'Сабагент {name}',
	'Resolve conflicts': 'Розвести конфлікт',
	'How to resolve': 'Як розвести',
	'Merge {base} into the PR branch and resolve the conflict':
		'Змерджити {base} у гілку PR і розвести конфлікт',
	'The agent resolves; you finish the merge and push': 'Агент розводить, мердж і push — за тобою',
	'Conflict places open in the merge strip': 'Конфліктні місця — у смузі мерджу',
	'You cannot push to the PR branch.': 'Немає права push у гілку PR.',
	'The PR branch is in a fork: resolve the conflict on GitHub.':
		'Гілка PR у форку: розведи конфлікт на GitHub.',
	'The PR branch is checked out in another tree.': 'Гілка PR уже відкрита в іншому дереві.',
	'The local PR branch has commits that are not in the PR.':
		'Локальна гілка PR має коміти, яких немає в PR.',
	'Could not start resolving the conflict.': 'Не вдалося почати розведення конфлікту.',
	'The PR branch already has the base. GitHub updates the state shortly.':
		'Гілка PR уже містить base. GitHub оновить стан згодом.',
	'The merge went through by itself: push it to update the PR.':
		'Мердж зійшовся сам: зроби push, щоб оновити PR.',
	'The agent is resolving the conflict.': 'Агент розводить конфлікт.',
	'Resolve the conflict in the merge strip.': 'Конфлікт — у смузі мерджу.',
	'Resolve (conflict)': 'Розвести',
	// spec/pull-requests-and-ci#ci: CI after a merge — runs, steps and deploys.
	'After merge': 'Після мерджу',
	'PR · before merge': 'PR · до мерджу',
	'Updates while the run is going': 'Оновлюється, поки run іде',
	'Run finished': 'Run завершено',
	'Deploying to {env}': 'Деплой у {env} іде',
	'Deployed to {env}': 'Задеплоєно в {env}',
	'Deploy to {env} failed': 'Деплой у {env} впав',
	'step {n} of {total}': 'крок {n} з {total}',
	'step {n}/{total}': 'крок {n}/{total}',
	'Open {env}': 'Відкрити {env}',
	'GitHub annotation': 'Анотація GitHub',
	'merge commit': 'merge-коміт',
	'started by {who}': 'запустив {who}',
	'{n}/{total} green': '{n}/{total} зелені',
	'{time} ago': '{time} тому',
	'deploy {n}/{total}': 'деплой {n}/{total}',
	deployed: 'задеплоєно',
	'deploy failed': 'деплой впав',
	'run going': 'run іде',
	'run passed': 'run пройшов',
	'run failed': 'run упав',
	'#{n} deployed to {env}.': '#{n} задеплоєно в {env}.',
	'Deploy to {env} failed.': 'Деплой у {env} впав.',
	'Open the run': 'Відкрити run',
	'Pull requests (segment)': 'Pull requests',
	'PR (segment)': 'PR',
	CI: 'CI',
	Workflow: 'Workflow',
	'Older runs are on GitHub': 'Старші запуски — на GitHub',
	'Reading runs from GitHub…': "Завантаження run'ів з GitHub…",
	'Runs could not be read: the network is unavailable.': "Run'и не прочиталися: мережа недоступна.",
	'No runs': "Run'ів немає",
	'No runs after the merge': "Після мерджу run'ів немає",
	'Back to the runs': "До переліку run'ів",
	'The run could not be read.': 'Run не прочитався.',
	'Workflow runs': "Run'и workflow",
	'Steps of {job}': 'Кроки {job}',
	'Could not hand the failure to the agent.': 'Не вдалося передати збій агенту.',
	'The failure is with the agent': 'Збій передано агенту',
	// spec/pull-requests-and-ci#ci-bell: the bell on a run.
	'Notify when the run finishes': 'Сповістити, коли run завершиться',
	'Stop notifying': 'Не сповіщати',
	'Notifies when the run finishes': 'Сповістить, коли run завершиться',
	'{run} passed': '{run} пройшов',
	'{run} failed': '{run} упав',
	'{run} cancelled': '{run} скасовано',
	// spec/task-window-workspace#work-area, spec/task-window-workspace#layout-switch: the work area, Tools and the Layout switch.
	Layout: 'Макет',
	'Work area': 'Робоча область',
	'Show all (layout)': 'Показати все',
	'Reset column widths': 'Скинути ширини стовпців',
	// spec/editor#new-file: New file… — Tools, File, the Files tree's menu.
	'New file…': 'Новий файл…',
	'File already exists': 'Файл уже є',
	'File path': 'Шлях до файла',
	'The path is outside the task': 'Шлях поза задачею',
	'Not inside .git or .brigadir': 'Не всередині .git чи .brigadir',
	'Could not create {file}.': 'Не вдалося створити {file}.',
	'Hide the chat': 'Сховати чат',
	'Show the chat': 'Показати чат',
	'Hide the work area': 'Сховати робочу область',
	'Show the work area': 'Показати робочу область',
	'Show panel': 'Показати панель',
	'Tools…': 'Інструменти…',
	'Task tools': 'Інструменти задачі',
	'New browser': 'Новий браузер',
	'Open · {count}': 'Відкрито · {count}',
	'Where to open': 'Куди відкривати',
	'In the focused group': 'У групі з фокусом',
	'In the bottom group': 'У нижній групі',
	'Under the chat': 'Під чатом',
	'Bottom group': 'Нижня група',
	'agent (tab)': 'агент',
	'In chat': 'У чаті',
	"Show the agent's actions in the chat": 'Показати дії агента в чаті',
	'The agent is waiting until you finish': 'Агент чекає, поки ти закінчиш',
	'next: {action}': 'далі: {action}',
	'Close tab': 'Закрити вкладку',
	'Page snapshot': 'Знімок сторінки',
	'New page': 'Нова сторінка',
	'clicks {target}': 'клікає {target}',
	'hovers {target}': 'наводить на {target}',
	'types into {target}': 'друкує в {target}',
	'presses {key}': 'натискає {key}',
	'scrolls the page': 'гортає сторінку',
	'selects in {target}': 'вибирає в {target}',
	'goes back': 'повертається назад',
	'goes forward': 'іде вперед',
	'reloads the page': 'перезавантажує сторінку',
	'allows notifications': 'дозволяє сповіщення',
	'blocks notifications': 'блокує сповіщення',
	'resets notifications': 'скидає сповіщення',
	'opens {url}': 'відкриває {url}',
	'reads the page': 'читає сторінку',
	'takes a screenshot': 'робить знімок',
	'will click {target}': 'клікне {target}',
	'will hover {target}': 'наведе на {target}',
	'will type into {target}': 'надрукує в {target}',
	'will press {key}': 'натисне {key}',
	'will scroll the page': 'прогорне сторінку',
	'will select in {target}': 'вибере в {target}',
	'will go back': 'повернеться назад',
	'will go forward': 'піде вперед',
	'will reload the page': 'перезавантажить сторінку',
	'will allow notifications': 'дозволить сповіщення',
	'will block notifications': 'заблокує сповіщення',
	'will reset notifications': 'скине сповіщення',
	'the page': 'сторінку',
	Toolbar: 'Тулбар',
	'Resize the bottom group': 'Змінити висоту нижньої групи',
	// spec/remote-access-and-mobile#module-and-settings: remote access — Settings ▸ Remote, pairing, File ▸ Connect…, the window chip, the cover, toasts.
	Remote: 'Віддалено',
	'Connect…': 'Підключитися…',
	Connect: 'Підключитися',
	'Allow control from other devices': 'Дозволити керування з інших пристроїв',
	'Remote access is off': 'Віддалений доступ вимкнено',
	'Control this machine from Brigadir on another computer: tasks, terminal, browser and simulator run here.':
		'Керування цією машиною з іншого компʼютера.',
	'Needs a password and a one-time pairing of each device.':
		'Потрібні пароль і одноразове спарювання кожного пристрою.',
	Password: 'Пароль',
	'Again (password)': 'Ще раз',
	'Repeat the password': 'Повтори пароль',
	'At least 10 characters · now {count}': 'Щонайменше 10 символів · зараз {count}',
	'The passwords do not match.': 'Паролі не збігаються.',
	'Turn on': 'Увімкнути',
	'Listening · {networks}': 'Слухає · {networks}',
	'Port {port}. No port forwarding on the router.': 'Порт {port}. Без проброса портів на роутері.',
	'Not listening: no LAN or Tailscale network.': 'Не слухає: немає мережі LAN чи Tailscale.',
	'Not listening: {error}': 'Не слухає: {error}',
	'Other devices see this machine by this name. By default, the system name.':
		'Типово — назва системи.',
	'The name cannot be empty.': 'Назва не може бути порожньою.',
	'Machine name': 'Назва машини',
	'Change password…': 'Змінити пароль…',
	'While remote access is on, the machine stays awake. A closed laptop lid still puts it to sleep.':
		'Поки доступ увімкнено, машина не засинає. Закрита кришка ноутбука все одно присипляє машину.',
	Devices: 'Пристрої',
	'Signed in {when} · {address} · {network}': 'Вхід {when} · {address} · {network}',
	'Paired {when}': 'Спарено {when}',
	'Blocked: 10 wrong passwords · {age} ago': 'Заблоковано: 10 невдалих паролів · {age} тому',
	'Blocked: 10 wrong passwords': 'Заблоковано: 10 невдалих паролів',
	'controls now': 'керує зараз',
	Revoke: 'Відкликати',
	Unblock: 'Розблокувати',
	'Add device': 'Додати пристрій',
	'Revoke all': 'Відкликати всі',
	'Log (remote access)': 'Журнал',
	'A device with no sign-in for 30 days is revoked by itself.':
		'Пристрій без входу 30 днів відкликається сам.',
	'Remote access changes only on **{machine}** itself: the name, password, devices and switch are not available from here.':
		'Віддалений доступ змінюється лише на самій **{machine}**: назва, пароль, пристрої й тумблер звідси недоступні.',
	'Could not change remote access.': 'Не вдалося змінити віддалений доступ.',
	'Change password': 'Змінити пароль',
	'New password': 'Новий пароль',
	'At least 10 characters. Kept only as a hash; devices stay paired. Current connections are dropped, the next one asks for the new password.':
		'Щонайменше 10 символів. Поточні підключення розірвуться.',
	'Change (password)': 'Змінити',
	'Remote access log': 'Журнал віддаленого доступу',
	Time: 'Час',
	Device: 'Пристрій',
	Event: 'Подія',
	Yesterday: 'Вчора',
	'The log is empty.': 'Журнал порожній.',
	'Could not read the log.': 'Не вдалося прочитати журнал.',
	'Who, when and from where: pairing, sign-ins, failed tries (and those refused at TLS), revocation, blocking. File:':
		'Файл:',
	'Access turned on': 'Доступ увімкнено',
	'Access turned off': 'Доступ вимкнено',
	'Password set': 'Пароль задано',
	'Password changed': 'Пароль змінено',
	'Machine renamed': 'Назву машини змінено',
	'Pairing opened': 'Спарювання відкрито',
	'Pairing closed': 'Спарювання закрито',
	'Wrong pairing code': 'Невірний код спарювання',
	'Pairing stopped: 5 wrong codes': 'Спарювання зупинено: 5 невдалих кодів',
	'Pairing code expired': 'Код спарювання протух',
	'Pairing declined': 'Спарювання відхилено',
	Paired: 'Спарено',
	'Signed in': 'Підключився',
	'Wrong password': 'Неправильний пароль',
	Refused: 'Відмовлено',
	'Refused: device not paired': 'Відхилено: пристрій не спарений',
	'Blocked after 10 passwords': 'Заблоковано після 10 паролів',
	Unblocked: 'Розблоковано',
	Revoked: 'Відкликано',
	'All devices revoked': 'Усі пристрої відкликано',
	'Revoked: 30 days without sign-in': 'Відкликано: 30 днів без входу',
	Disconnected: 'Відʼєднався',
	'Control taken back': 'Керування забрали назад',
	'Took control': 'Забрав керування',
	'Another version': 'Інша версія',
	'Call refused': 'Виклик заборонено',
	'Changed settings': 'Змінив налаштування',
	'Disconnected from this machine': 'Відʼєднано з цієї машини',
	'Module turned on': 'Модуль увімкнено',
	'Module turned off': 'Модуль вимкнено',
	// spec/remote-access-and-mobile#phone-network: the phone's lines in the log.
	'Phone access turned on': 'Доступ із телефона увімкнено',
	'Phone access turned off': 'Доступ із телефона вимкнено',
	'Phone notifications on': 'Сповіщення на телефоні ввімкнено',
	'Phone notifications off': 'Сповіщення на телефоні вимкнено',
	// spec/remote-access-and-mobile#phone-network: the phone's sign-in page.
	'Brigadir on {machine}': 'Бригадир на {machine}',
	'Sign in with a passkey': 'Увійти ключем входу',
	'Pair this phone': 'Спарити цей телефон',
	'On {machine}: Settings ▸ Remote ▸ Add a device, then enter the code it shows.':
		'На {machine}: Налаштування ▸ Модулі ▸ Віддалений доступ ▸ Додати пристрій, потім введи код, який там видно.',
	'Phone name': 'Назва телефона',
	Pair: 'Спарити',
	'The code matched. Create a passkey for {machine}.':
		'Код підійшов. Створи ключ входу для {machine}.',
	'Create a passkey': 'Створити ключ входу',
	'Confirm this phone on {machine}.': 'Підтверди цей телефон на {machine}.',
	'Paired. Sign in with the passkey.': 'Спарено. Увійди ключем входу.',
	'The code did not match.': 'Код не підійшов.',
	'Pairing is not open on {machine}.': 'Спарювання на {machine} не відкрите.',
	'Too many wrong codes. Open pairing on {machine} again.':
		'Забагато неправильних кодів. Відкрий спарювання на {machine} знову.',
	'Declined on {machine}.': 'На {machine} відхилили.',
	'Another device is pairing now.': 'Зараз спарюється інший пристрій.',
	'The passkey was not accepted.': 'Ключ входу не прийнято.',
	'This passkey is not paired with {machine}. Pair the phone again.':
		'Цей ключ не спарений з {machine}. Спари телефон знову.',
	'Try again in a moment.': 'Спробуй ще раз за мить.',
	'This phone is blocked on {machine}. Unblock it there.':
		'Цей телефон заблоковано на {machine}. Розблокуй його там.',
	'Access from a phone is off on {machine}.': 'Доступ із телефона на {machine} вимкнено.',
	'{machine} does not answer.': '{machine} не відповідає.',
	'Signed in to {machine}': 'Увійшли на {machine}',
	'Turn on notifications': 'Увімкнути сповіщення',
	'Notifications are on': 'Сповіщення ввімкнено',
	'Revoke all devices?': 'Відкликати всі пристрої?',
	'Add a device': 'Додати пристрій',
	'On the other computer: **File ▸ Connect… ▸ New machine…**, choose **{machine}** and enter the code.':
		'На іншому компʼютері: **Файл ▸ Підключитися… ▸ Нова машина…**, вибери **{machine}** і введи код.',
	'Valid for {time}': 'Діє ще {time}',
	'Waiting for a device…': 'Чекаю на пристрій…',
	'New code': 'Новий код',
	'The code no longer works': 'Код більше не діє',
	'The device entered the right code and wants to control this machine.':
		'Пристрій ввів правильний код і хоче керувати цією машиною.',
	'Device key': 'Ключ пристрою',
	'Pairing code': 'Код спарювання',
	'Pairing stopped: 5 wrong codes from {address}.':
		'Спарювання зупинено: 5 невдалих кодів з {address}.',
	'Pairing stopped: 5 wrong codes.': 'Спарювання зупинено: 5 невдалих кодів.',
	'{device} paired. Connect with the password.': '{device} спарено. Підключатися — з паролем.',
	'Available (machine)': 'Доступна',
	'Unavailable (machine)': 'Недоступна',
	'Unavailable outside the LAN without Tailscale': 'Недоступна поза LAN без Tailscale',
	'No answer on the LAN or through Tailscale': 'Не відповідає ні в LAN, ні через Tailscale',
	'last {when}': 'востаннє {when}',
	'paired {when}': 'спарено {when}',
	'Last {when}': 'Востаннє {when}',
	'New machine…': 'Нова машина…',
	'Pair with a code the working machine shows': 'Спарити з кодом, який покаже робоча машина',
	'Remote access password set on {machine}. Not kept here.':
		'Пароль віддаленого доступу, заданий на {machine}. Тут не зберігається.',
	'Connecting…': 'Підключення…',
	'Via {network} · {address}': 'Через {network} · {address}',
	'Password for {machine}': 'Пароль від {machine}',
	'Wrong password. Next try in {seconds} s.':
		'Неправильний пароль. Наступна спроба через {seconds} с.',
	'Too many tries. Next try in {seconds} s.': 'Забагато спроб. Наступна спроба через {seconds} с.',
	'{seconds} s': '{seconds} с',
	'{device} is blocked on {machine} after 10 wrong passwords. Only {machine} can unblock it.':
		'{device} заблоковано на {machine} після 10 невдалих паролів. Розблокувати можна лише на {machine}.',
	'{machine} does not answer on the LAN or through Tailscale. Check that {machine} is awake, Brigadir runs there and remote access is on.':
		'{machine} не відповідає ні в LAN, ні через Tailscale. Перевір, що {machine} не спить, Бригадир на ній запущено і віддалений доступ увімкнено.',
	'Try again (connection)': 'Спробувати ще',
	'Tried: {addresses}': 'Пробували: {addresses}',
	'Brigadir on {machine} is another version. **Update Brigadir on {machine}**, then connect.':
		'На {machine} інша версія Бригадира. **Онови Бригадир на {machine}**, потім підключайся.',
	'Remote access is off on {machine}.': 'На {machine} віддалений доступ вимкнено.',
	'{machine} no longer knows this device: pair it again.':
		'{machine} більше не знає цей пристрій: спар його знову.',
	'This computer could not keep its key.': 'Цей компʼютер не зміг зберегти свій ключ.',
	// spec/remote-access-and-mobile#architecture: a computer that cannot keep its key in the OS key store.
	'No secret service (GNOME Keyring or KWallet): Brigadir cannot keep the key of this computer. Install one and start Brigadir again.':
		'Немає служби секретів (GNOME Keyring чи KWallet): Бригадир не може зберегти ключ цього компʼютера. Встанови її й запусти Бригадир знову.',
	'The system key store is not available: Brigadir cannot keep the key of this computer.':
		'Сховище ключів системи недоступне: Бригадир не може зберегти ключ цього компʼютера.',
	Machines: 'Машини',
	Forget: 'Забути',
	'Forget {machine}?': 'Забути {machine}?',
	'To connect to {machine} again, pair with it again.':
		'Щоб знову підключитися до {machine}, її треба спарити ще раз.',
	'Could not forget the machine.': 'Не вдалося забути машину.',
	'Could not connect.': 'Не вдалося підключитися.',
	'Take control?': 'Забрати керування?',
	'Someone works on {machine} now. If you connect, a cover closes the window on {machine}, and control can be taken back there.':
		'На {machine} зараз працюють локально. Якщо підключитися, вікно на {machine} закриє заслона, а там зможуть забрати керування назад.',
	'Take control': 'Забрати керування',
	'New machine': 'Нова машина',
	'On this network': 'У цій мережі',
	'{address} · found on the LAN': '{address} · знайдено в LAN',
	'already paired': 'уже спарено',
	'Enter an address…': 'Ввести адресу…',
	'Tailscale or IP, if the machine is not on the list':
		'Tailscale або IP, якщо машини немає в списку',
	'On the working machine: Settings ▸ Remote ▸ **Add device** shows the code.':
		'На робочій машині: Налаштування ▸ Модулі ▸ Віддалений доступ ▸ **Додати пристрій** — там зʼявиться код.',
	'Enter an address': 'Ввести адресу',
	Port: 'Порт',
	'IP or name on the LAN or Tailscale. The port is 7420 unless it was changed on the working machine.':
		'IP або імʼя в LAN чи Tailscale. Порт — 7420, якщо його не міняли на робочій машині.',
	'Pair with {machine}': 'Спарити з {machine}',
	'The code is shown on **{machine}**: Settings ▸ Remote ▸ Add device. Valid for 5 min.':
		'Код показано на **{machine}**: Налаштування ▸ Модулі ▸ Віддалений доступ ▸ Додати пристрій. Діє 5 хв.',
	'This computer’s name': 'Назва цього компʼютера',
	'Code character {n}': 'Символ коду {n}',
	'The code no longer works. On {machine} press «New code» and enter it here.':
		'Код більше не діє. На {machine} натисни «Новий код» і введи його тут.',
	'Too many wrong codes. On {machine} open «Add device» again.':
		'Забагато невдалих кодів. На {machine} відкрий «Додати пристрій» знову.',
	'The device was declined on {machine}.': 'На {machine} відхилили цей пристрій.',
	'Another device is pairing with {machine} now. Try again in a minute.':
		'Зараз із {machine} спарюється інший пристрій. Спробуй за хвилину.',
	'Could not reach {machine}.': 'Не вдалося дістатися до {machine}.',
	'Waiting for confirmation on {machine}': 'Чекаю підтвердження на {machine}',
	'On {machine} check the name **{device}** and press «Pair».':
		'На {machine} перевір назву **{device}** і натисни «Спарити».',
	'{machine} added': '{machine} додано',
	'Next, the remote access password. No need to pair again.':
		'Далі — пароль віддаленого доступу. Спарювати ще раз не треба.',
	'Remote machine {machine}': 'Віддалена машина {machine}',
	'Remote access is on': 'Віддалений доступ увімкнено',
	'Connected via {network}': 'Підключено через {network}',
	'{address} · {latency} ms · since {time}': '{address} · {latency} мс · з {time}',
	'{address} · since {time}': '{address} · з {time}',
	'Choose a folder on {machine}…': 'Вибрати теку на {machine}…',
	Disconnect: 'Відʼєднатися',
	'Reconnecting…': 'Перепідключення…',
	'Control was taken back on {machine}': 'На {machine} забрали керування',
	'Someone pressed «Take back» at {machine}. The agents keep working.':
		'Хтось натиснув «Забрати назад» біля {machine}. Агенти працюють далі.',
	'Take control again': 'Забрати знову',
	'The connection to {machine} closed': 'Звʼязок із {machine} закрито',
	'This device was revoked on {machine}.': 'На {machine} відкликали цей пристрій.',
	'Remote access was turned off on {machine}.': 'На {machine} вимкнули віддалений доступ.',
	'The password changed on {machine}. Connect with the new one.':
		'На {machine} змінили пароль. Підключися з новим.',
	'The connection was lost for too long. Connect again.':
		'Звʼязку не було надто довго. Підключися знову.',
	'This device connected to {machine} again elsewhere.':
		'Цей пристрій знову підключився до {machine} в іншому вікні.',
	'{machine} disconnected this device.': 'На {machine} відʼєднали цей пристрій.',
	'The connection closed.': 'Зʼєднання закрито.',
	'Connect again': 'Підключитися знову',
	'Close window': 'Закрити вікно',
	'{machine} — Brigadir': '{machine} — Бригадир',
	// spec/remote-access-and-mobile#browser-from-device: the browser and the simulator of the working machine on a device.
	'The page is open on {machine}': 'Сторінка відкрита на {machine}',
	'The simulator runs on {machine}': 'Симулятор працює на {machine}',
	'Page on {machine}': 'Сторінка на {machine}',
	OK: 'OK',
	'Leave this page?': 'Покинути сторінку?',
	'Changes you made may not be saved.': 'Зроблені зміни можуть не зберегтися.',
	"Don't show more dialogs from this page": 'Не показувати більше діалогів цієї сторінки',
	Stay: 'Лишитися',
	Leave: 'Покинути',
	'Controlled from {device}': 'Керування з {device}',
	'Since {time} · {address} · {network}. Agents, terminals, browser and simulator work here; {device} controls them.':
		'З {time} · {address} · {network}',
	'Take back': 'Забрати назад',
	'Disconnect {device}': 'Відʼєднати {device}',
	'Working now (cover)': 'Зараз працюють',
	'Port {port} · nobody connected': 'Порт {port} · ніхто не підключений',
	'Port {port} · connected: {devices}': 'Порт {port} · підключено: {devices}',
	// spec/remote-access-and-mobile#remote-button: the Remote button's hint, the port left to the menu.
	'connected: {devices}': 'підключено: {devices}',
	'Add device…': 'Додати пристрій…',
	'Turn off remote access': 'Вимкнути віддалений доступ',
	'Not listening': 'Не слухає',
	'{device} connected · {address}': 'Підключився {device} · {address}',
	'{device}: wrong password · {address}': '{device}: неправильний пароль · {address}',
	'{device} is blocked after 10 wrong passwords.':
		'{device} заблоковано після 10 невдалих паролів.',
	'Unblock…': 'Розблокувати…',
	// spec/remote-access-and-mobile#client-ui-seam: menus, dialogs and the folder browser of the working machine on a device.
	'Add a project from {machine}': 'Додати проєкт з {machine}',
	'Add a folder from {machine}': 'Додати теку з {machine}',
	'Import a template from {machine}': 'Імпортувати шаблон з {machine}',
	'Description from a .md file on {machine}': 'Опис з файла .md на {machine}',
	'Folder up': 'Вище',
	'New folder…': 'Нова тека…',
	'Folder name': 'Назва теки',
	'Choose (folder)': 'Вибрати',
	'Double-click or → opens a folder. Path on {machine}:': 'Шлях на {machine}:',
	'The folder is empty': 'Тека порожня',
	'Could not create the folder.': 'Не вдалося створити теку.',
	'Showing the first 2,000 items': 'Показано перші 2 000 елементів',
	'Folders of {machine}': 'Теки {machine}',
	'git · {time}': 'git · {time}',
	'today (folder)': 'сьогодні',
	'yesterday (folder)': 'вчора',
	'{minutes} min ago': '{minutes} хв тому',
	'a month (folder)': 'місяць',
	'A folder of this computer cannot be a project of {machine}. Choose a folder on {machine}.':
		'Тека цього компʼютера не може бути проєктом на {machine}. Вибери теку на {machine}.',
	// spec/settings-modules-and-onboarding#intro-remote: the Modules and Remote access steps of the intro, and the same look in Settings ▸ Modules and ▸ Remote.
	'Pull requests (module)': 'Pull requests',
	'A module that is off leaves the window, menus and agent tools.':
		'Вимкнений модуль зникає з вікна, меню й інструментів агентів.',
	'Pages in the task window, for you and the agent.': 'Сторінки у вікні задачі, для тебе й агента.',
	'iOS and Android': 'iOS і Android',
	'PR list and review from GitHub.': 'Перелік і ревʼю PR з GitHub.',
	'A button that runs project commands.': 'Кнопка запуску команд проєкту.',
	'Control this machine from another computer.': 'Керування цією машиною з іншого компʼютера.',
	// spec/notifications-slack-notes-and-schedules#notes: Notes
	'Markdown notes with their own agent chat.': 'Markdown-нотатки з власним чатом агента.',
	Notes: 'Нотатки',
	'New note': 'Нова нотатка',
	// spec/notifications-slack-notes-and-schedules#schedules: scheduled tasks — what main says (notices); the screens add theirs.
	'Scheduled tasks are off in Settings.': 'Задачі за розкладом вимкнено в налаштуваннях.',
	'Scheduled tasks': 'Задачі за розкладом',
	Schedules: 'Розклади',
	'New schedule…': 'Новий розклад…',
	'New schedule': 'Новий розклад',
	Schedule: 'Розклад',
	'Schedule (verb)': 'Запланувати',
	Once: 'Один раз',
	'Repeat (schedule)': 'Повторювати',
	'Repeat (field)': 'Повтор',
	Quick: 'Швидко',
	Date: 'Дата',
	At: 'О',
	'Add time': 'Додати час',
	'Remove the time': 'Прибрати час',
	Days: 'Дні',
	Every: 'Кожні',
	Between: 'Між',
	'At minute': 'На хвилині',
	'Time zone': 'Часовий пояс',
	'This computer': 'Цей компʼютер',
	'Search time zones': 'Пошук поясу',
	'No time zones match': 'Таких поясів немає',
	'Every hour': 'Щогодини',
	'Every few hours': 'Кожні кілька годин',
	Daily: 'Щодня',
	Weekdays: 'Щобудня',
	Weekly: 'Щотижня',
	Cron: 'Cron',
	'minute · hour · day · month · weekday': 'хвилина · година · день · місяць · день тижня',
	'Cron needs 5 fields: minute, hour, day, month, weekday.':
		'Cron має пʼять полів: хвилина, година, день, місяць, день тижня.',
	'A cron field is out of range.': 'Значення поля cron поза межами.',
	'Use numbers, *, lists, ranges and steps.': 'Лише числа, *, списки, діапазони й кроки.',
	'Choose at least one day.': 'Вибери хоча б один день.',
	'This time has passed.': 'Цей час уже минув.',
	'No runs (schedule)': 'Запусків не буде',
	'Next: {list}': 'Далі: {list}',
	'In 30 min': 'За 30 хв',
	'In 1 h': 'За 1 год',
	'In 3 h': 'За 3 год',
	'Tonight 22:00': 'Сьогодні о 22:00',
	'Tomorrow 09:00': 'Завтра о 09:00',
	'If missed': 'Якщо пропущено',
	'Catch up': 'Наздогнати',
	'Ask (missed)': 'Спитати',
	'In Tasks': 'У задачах',
	'When they need you': 'Коли потрібен ти',
	Always: 'Завжди',
	'Catches up once on wake or start, if the slot was within 24 h.':
		'Один раз наздоганяє після пробудження чи старту, якщо минуло до 24 год.',
	'Only writes «Skipped» to the history.': 'Лише пише «Пропущено» в історію.',
	'Asks in Notifications: run once or skip.': 'Питає в сповіщеннях: запустити раз чи пропустити.',
	'Each run starts a new task.': 'Кожен запуск — нова задача.',
	'Now (when)': 'Зараз',
	'Run now': 'Запустити зараз',
	Pause: 'Призупинити',
	'Resume (schedule)': 'Відновити',
	Runs: 'Запуски',
	'Runs · {n}': 'Запуски · {n}',
	'All schedules': 'Усі розклади',
	Active: 'Активні',
	'Filter schedules': 'Фільтр розкладів',
	'No schedules': 'Розкладів немає',
	'Delete schedule…': 'Видалити розклад…',
	'Delete the schedule?': 'Видалити розклад?',
	'Its tasks stay; the run history is deleted.':
		'Задачі запусків лишаються; історію запусків буде видалено.',
	'Edit schedule…': 'Змінити розклад…',
	'Duplicate…': 'Дублювати…',
	'Open last run': 'Відкрити останній запуск',
	'Next run': 'Наступний запуск',
	'Last run': 'Останній запуск',
	Missed: 'Пропущено',
	Paused: 'На паузі',
	'Last run failed': 'Останній запуск упав',
	'Missed · needs your answer': 'Пропущено · чекає відповіді',
	'Only here': 'Лише тут',
	'Shown in Tasks': 'Показано в задачах',
	'Not shown in Tasks: finished without changes': 'Не показано в задачах: завершено без змін',
	'Run of {name}': 'Запуск «{name}»',
	'Quiet scheduled runs': 'Тихі запуски за розкладом',
	'Previous run still active': 'Попередній запуск ще триває',
	'The computer slept or the app was closed': 'Компʼютер спав або застосунок був закритий',
	'You skipped it': 'Пропущено тобою',
	'Could not start': 'Не вдалося почати',
	'No runs yet': 'Запусків ще не було',
	'First run: {when}': 'Перший запуск: {when}',
	'Could not save the schedule.': 'Не вдалося зберегти розклад.',
	'Schedule saved': 'Розклад збережено',
	'Schedule created': 'Розклад створено',
	'Schedule not created': 'Розклад не створено',
	'Open schedule': 'Відкрити розклад',
	'Could not read the schedules.': 'Не вдалося прочитати розклади.',
	'Could not start the run.': 'Не вдалося почати запуск.',
	'Repeat…': 'Повторювати…',
	'Run a task later or on repeat.': 'Запуск задачі пізніше або за розкладом.',
	'Started a run': 'Почався запуск',
	'Run finished without changes': 'Запуск завершено без змін',
	'The scheduled run could not start.': 'Запуск за розкладом не вдалося почати.',
	'Waiting for your answer: run once or skip.': 'Чекає на відповідь: запустити раз чи пропустити.',
	'Untitled note': 'Нотатка без назви',
	'Copy note': 'Копіювати нотатку',
	'Copy Markdown': 'Копіювати Markdown',
	'Copy as file': 'Копіювати як файл',
	'Could not copy the note.': 'Не вдалося скопіювати нотатку.',
	'No notes yet': 'Нотаток ще немає',
	'Filter notes': 'Фільтр нотаток',
	'Note scopes': 'Нотатки за проєктом',
	'No project': 'Без проєкту',
	'Note project': 'Проєкт нотатки',
	'Note text': 'Текст нотатки',
	'Write a note in Markdown': 'Пиши нотатку в Markdown',
	'Note actions': 'Дії з нотаткою',
	'Create task from note': 'Створити задачу з нотатки',
	'Create task': 'Створити задачу',
	'From the note': 'З нотатки',
	'Open the task': 'Відкрити задачу',
	'Task deleted': 'Задачу видалено',
	'Chat about the note': 'Чат нотатки',
	'Delete note…': 'Видалити нотатку…',
	'Delete the note?': 'Видалити нотатку?',
	'The note and its chat will be deleted. Tasks from it stay.':
		'Нотатку і її чат буде видалено. Задачі з неї лишаться.',
	'Could not save the note. Changes are kept.': 'Нотатку не збережено. Зміни лишились.',
	'Could not open the note.': 'Не вдалося відкрити нотатку.',
	'Could not delete the note.': 'Не вдалося видалити нотатку.',
	'Could not create the note.': 'Не вдалося створити нотатку.',
	'Could not read the notes.': 'Не вдалося прочитати нотатки.',
	'Select a note': 'Вибери нотатку',
	'Tasks from this note': 'Задачі з цієї нотатки',
	'Hide chat': 'Сховати чат',
	'Show chat': 'Показати чат',
	'about this note': 'про цю нотатку',
	'Chat about this note': 'Чат про цю нотатку',
	'Edited the note': 'Змінив нотатку',
	'Saved to the note': 'Збережено в нотатці',
	'Undone. The note is as before the answer.': 'Скасовано. Нотатка така, як до відповіді.',
	'You edited the note after the answer. Undo is off.':
		'Ти змінив нотатку після відповіді. Скасувати не можна.',
	'You edited the note': 'Ти змінив нотатку',
	'The note changed since the last message': 'Нотатка змінилась після останнього повідомлення',
	'Ask about this note': 'Спитай про цю нотатку',
	'Could not undo the edit.': 'Не вдалося скасувати правку.',
	'This machine': 'Ця машина',
	'Another computer': 'Інший компʼютер',
	// spec/remote-access-and-mobile#tailscale-guidance: Tailscale is installed by the person — said where it is needed, with the download.
	'On the same home network nothing else is needed. Away from home and from a phone, Tailscale on both devices.':
		'Вдома в одній мережі більше нічого не потрібно. Поза домом і з телефона — Tailscale на обох пристроях.',
	'Download Tailscale': 'Завантажити Tailscale',
	'Outside the LAN, only through Tailscale on both computers.':
		'Поза LAN — лише через Tailscale на обох компʼютерах.',
	'Add devices in Settings ▸ Remote.':
		'Пристрої додаються в Налаштування ▸ Модулі ▸ Віддалений доступ.',
	// spec/remote-access-and-mobile#phone-app: the phone — sign-in states, home, project, chat, composer, sheets.
	'1. Share': '1. Поділитися',
	'2. Add to Home Screen': '2. На початковий екран',
	'3. Open Brigadir from the Home Screen': '3. Відкрий Бригадир з початкового екрана',
	'Actions are unavailable.': 'Дії недоступні.',
	'Add Brigadir to the Home Screen': 'Додай Бригадир на початковий екран',
	'Add a photo or file': 'Додати фото чи файл',
	'After the turn ends': 'Після кінця турну',
	'Almost done': 'Майже готово',
	'Brigadir is running on {machine}': 'Бригадир запущений на {machine}',
	'Brigadir on {machine} asks whether to add this phone.':
		'Бригадир на {machine} питає, чи додати цей телефон.',
	'Changes not reviewed': 'Зміни без перегляду',
	'Choose file': 'Вибрати файл',
	'Choose photo': 'Вибрати фото',
	'Complete task': 'Завершити задачу',
	Connected: 'Підключено',
	'Continue in Safari': 'Продовжити в Safari',
	'Data as of {time}.': 'Дані станом на {time}.',
	'Into this turn, at the agent’s next step': 'У цей турн, на найближчому кроці агента',
	'Last successful sign-in: {time}': 'Остання вдала спроба: {time}',
	Menu: 'Меню',
	'Name it «Brigadir»': 'Назва — «Бригадир»',
	'Name of this phone': 'Назва цього телефона',
	'No connection to {machine}': 'Немає звʼязку з {machine}',
	'No pull request': 'Немає pull request',
	'Not now': 'Не зараз',
	'Notifications on this phone': 'Сповіщення на цьому телефоні',
	'Only then can iPhone show notifications when an agent is waiting for you.':
		'Лише так iPhone покаже сповіщення, коли агент чекає тебе.',
	'Other tasks': 'Інші задачі',
	'Output only': 'Лише перегляд виводу',
	'Pair again': 'Спарити знову',
	Project: 'Проєкт',
	'Queued · {count}': 'У черзі · {count}',
	'Resets in {minutes} min. Queued messages go after the reset.':
		'Скидання за {minutes} хв. Повідомлення з черги підуть після скидання.',
	'Retry (link)': 'Повторити',
	// The phone: a project's frame opens it, a crew's waiting worker, a failed turn, an attachment on its way.
	'Open project': 'Відкрити проєкт',
	'A worker is waiting for you': 'Воркер чекає на тебе',
	'Retry (turn)': 'Повторити',
	'new task (state)': 'нова задача',
	'Attaching…': 'Прикріплення…',
	'Try again (asleep)': 'Спробувати знову',
	'Search tasks': 'Пошук задач',
	'Sending at the next step…': 'Надсилається на наступному кроці…',
	'Show in the home header': 'Показувати в шапці головної',
	'Sign in again with the same passkey.': 'Увійди знову тим самим ключем входу.',
	'Sign in with the passkey': 'Вхід — ключем входу',
	'Sign out on this phone': 'Вийти на цьому телефоні',
	'Stop turn': 'Зупинити турн',
	'Tailscale is on on this phone': 'Tailscale увімкнено на цьому телефоні',
	'Take photo': 'Зняти фото',
	'Task menu': 'Меню задачі',
	'The agent stopped with an error.': 'Агент зупинився з помилкою.',
	'The button at the bottom of Safari': 'Кнопка внизу Safari',
	'The change applies from the next turn.': 'Зміна діє з наступного турну.',
	'The code is shown on {machine}: Settings ▸ Remote ▸ Add device. It lasts 5 min.':
		'Код показано на {machine}: Налаштування ▸ Модулі ▸ Віддалений доступ ▸ Додати пристрій. Діє 5 хв.',
	'The code matches': 'Код підійшов',
	'The passkey of this phone can be revoked on {machine} in Settings ▸ Remote.':
		'Ключ входу цього телефона можна відкликати на {machine} в Налаштування ▸ Модулі ▸ Віддалений доступ.',
	'The phone is paired with {machine}. One passkey instead of a password is left.':
		'Телефон спарено з {machine}. Лишився ключ входу замість пароля.',
	'The screen failed to draw.': 'Екран не вдалося показати.',
	'The session has ended': 'Сесія закінчилась',
	'The task is gone.': 'Задачі вже немає.',
	'The {agent} subscription limit is reached.': 'Досягнуто ліміту підписки {agent}.',
	'This phone was revoked on {machine}': 'Цей телефон відкликали на {machine}',
	'To come back, open «Add device» on {machine} and pair the phone again.':
		'Щоб повернутися, на {machine} відкрий «Додати пристрій» і спарь телефон знову.',
	Tool: 'Інструмент',
	'View only': 'Лише перегляд',
	'What to do': 'Що зробити',
	'What you send goes after the limit resets': 'Надіслане піде після скидання ліміту',
	'When an agent is waiting for you': 'Коли агент чекає тебе',
	'When an agent is waiting for you: a question, a permission or a plan. A notification shows only the task title and type.':
		'Коли агент чекає тебе: питання, дозвіл або план. У сповіщенні лише назва задачі й тип.',
	'Working machine': 'Робоча машина',
	'after the reset': 'після скидання',
	'connecting…': 'підключення…',
	'from {base}': 'від {base}',
	ms: 'мс',
	'needs you': 'потрібен ти',
	permission: 'дозвіл',
	plan: 'план',
	slow: 'повільно',
	'subscription limit': 'ліміт підписки',
	'the foreman is waiting for you': 'бригадир чекає на тебе',
	'unavailable (machine)': 'недоступна',
	working: 'працює',
	'{count} waiting': '{count} чекають',
	'{device} · passkey': '{device} · ключ входу',
	'{machine} is asleep or unreachable': '{machine} спить або недоступна',
	'{machine} is on and awake': '{machine} увімкнена й не спить',
	'{percent} left': 'лишилось {percent}',
	// spec/remote-access-and-mobile#phone-app: the phone in Settings ▸ Remote on the working machine; the web listener's reasons (spec/remote-access-and-mobile#phone-network).
	Phone: 'Телефон',
	'Access from a phone': 'Доступ із телефона',
	'The machine’s name in the tailnet goes into public certificate logs.':
		'Назва машини в tailnet потрапляє в публічні журнали сертифікатів.',
	'tailscale serve does not send this address here yet.':
		'tailscale serve ще не веде цю адресу сюди.',
	'Tailscale is not found on this machine.': 'Tailscale не знайдено на цій машині.',
	Steps: 'Кроки',
	'Done (step)': 'Зроблено',
	'Install Tailscale on the phone and sign in to the same tailnet.':
		'Встанови Tailscale на телефон і ввійди в той самий tailnet.',
	'Turn on HTTPS in the tailnet’s DNS settings.': 'Увімкни HTTPS у налаштуваннях DNS tailnet.',
	'Open the admin console': 'Відкрити адмінку',
	'Run once on this machine:': 'Виконай раз на цій машині:',
	'Click Add device below to get a code.': 'Натисни «Додати пристрій» нижче: машина покаже код.',
	'Open {address} on the phone and enter the code.': 'Відкрий на телефоні {address} і введи код.',
	'the machine’s tailnet address': 'адресу машини в tailnet',
	'Check again': 'Перевірити знову',
	'The phone bundle is not built (out/renderer-mobile).':
		'Застосунок телефона не зібрано (out/renderer-mobile).',
	'Tailscale is not running here, or this machine has no name in the tailnet.':
		'Tailscale тут не запущено, або ця машина не має назви в tailnet.',
	'Tailscale Funnel publishes this address on the internet; turn Funnel off for it.':
		'Tailscale Funnel публікує цю адресу в інтернеті; вимкни Funnel для неї.',
	'Another service shares https://{host} through tailscale serve; give it another port.':
		'Інший сервіс ділить https://{host} через tailscale serve; дай йому інший порт.',
	// spec/remote-access-and-mobile#phone-task-tools: the phone's changes, PR, files and terminal; the swipe and the version in the machine sheet.
	'from (base)': 'від',
	'Previous (file)': 'Попередній',
	'Next (file)': 'Наступний',
	'{n} of {total}': '{n} з {total}',
	'view only': 'лише перегляд',
	'{count} changed': '{count} змінено',
	'File actions': 'Дії файла',
	'To the end': 'До кінця',
	'output only': 'лише перегляд виводу',
	'No commands run in this task': 'У задачі не запущено жодної команди',
	'Review (verb)': 'Ревʼю',
	'Review (noun)': 'Ревʼю',
	'all passed': 'усі пройшли',
	'failed (check)': 'не пройшла',
	'Reply to {author}…': 'Відповідь {author}…',
	'review requested': 'чекає ревʼю',
	'commented (review)': 'коментар',
	'Waiting for checks and {approvals}': 'Чекає на checks і {approvals}',
	'Waiting for checks': 'Чекає на checks',
	'Waiting for {approvals}': 'Чекає на {approvals}',
	'Comment (review)': 'Коментар',
	'No decision': 'Без рішення',
	'The task agent makes the fixes from the comments': 'Правки за коментарями зробить агент задачі',
	'Goes to GitHub as {login}.': 'Піде на GitHub від {login}.',
	'Goes to GitHub.': 'Піде на GitHub.',
	'General comment': 'Загальний коментар',
	'Repo default': 'Типово в repo',
	'A merge on GitHub cannot be undone.': 'Мердж на GitHub не скасувати.',
	'Cancel the reply': 'Скасувати відповідь',
	'Send the comment': 'Надіслати коментар',
	'Brigadir {version} on {machine}.': 'Бригадир {version} на {machine}.',
	'Resets in {time}. Queued messages go after the reset.':
		'Скидання за {time}. Повідомлення з черги підуть після скидання.',
	// spec/remote-access-and-mobile#remote-button: the «Remote» chip's popover and the two parts of Settings ▸ Remote.
	'Remote access and other machines': 'Віддалений доступ і інші машини',
	'To this machine': 'До цієї машини',
	'Connect to another': 'Підключитися до іншої',
	'{network} · reachable': '{network} · доступна',
	'Checking… (machine)': 'Перевіряю…',
	'Checking LAN and Tailscale…': 'Перевіряю LAN і Tailscale…',
	'Window open (machine)': 'Вікно відкрите',
	'{network} · {latency} ms': '{network} · {latency} мс',
	'window open (machine)': 'вікно відкрите',
	'Show window': 'Показати вікно',
	'Go to (machines)': 'Перейти',
	'This machine · task window': 'Ця машина · вікно задач',
	'This window': 'Це вікно',
	'Control Brigadir on another computer from this window. A machine is paired once with a code, and you sign in with the password set on it.':
		'Керування Бригадиром на іншому компʼютері.',
	'No paired machines yet': 'Ще немає спарених машин',
	'On the other machine turn on remote access and press «Add device»: it shows a code.':
		'На іншій машині увімкни віддалений доступ і натисни «Додати пристрій»: вона покаже код.',
	'Outside home both computers need Tailscale.':
		'Поза домом потрібен Tailscale на обох компʼютерах.',
	// spec/remote-access-and-mobile#phone-pr-list: the phone's project PR list and board.
	'All (PRs)': 'Усі',
	'Release to refresh': 'Відпусти, щоб оновити',
	'Refreshing from GitHub…': 'Оновлюю з GitHub…',
	'PRs could not be read.': 'Не вдалося прочитати PR.',
	'GitHub is not connected on {machine}': 'GitHub не підключено на {machine}',
	'The command is run in the terminal of {machine}; it cannot be typed from a phone.':
		'Команду запускають у терміналі {machine}; з телефона її не ввести.',
	'This PR has no task: the agent works in a new task and leaves draft comments.':
		'Задачі в цього PR немає: агент працюватиме в новій задачі й лишить чернетки коментарів.',
	'The agent rereads the PR and leaves comments on the lines. They become drafts of your review: nothing goes to GitHub without you.':
		'Коментарі агента стануть чернетками ревʼю.',
	'Reviewer · writes no code': 'Ревʼюер · коду не пише',
	'The project’s default agent': 'Типовий агент проєкту',
	'Where it works': 'Де працює',
	'No checkout: the agent reads the diffs and files from GitHub':
		'Без checkout: агент читає дифи й файли з GitHub',
	'The PR branch on {machine} — the agent can run the tests':
		'Гілка PR на {machine} — агент може запускати тести',
	'Start the review': 'Запустити ревʼю',
	'The agent merges {base} into the PR branch in a new task; the merge and the push are yours.':
		'Агент змерджить {base} у гілку PR у новій задачі; мердж і push — за тобою.',
	'The agent merges {base} into {head} in a worktree on {machine} and resolves the conflict. The merge and the push are yours; a usual push updates the PR.':
		'Агент змерджить {base} у {head} у worktree на {machine} й розведе конфлікт. Мердж і push — за тобою, PR оновить звичайний push.',
	'Resolving by hand is on the computer: the merge strip and the editor are there.':
		'Вирішити вручну — на компʼютері.',
	'Hand to the agent (conflict)': 'Доручити агенту',
	'Release — the agent starts': 'Відпусти — агент почне',
	'Release to complete the task': 'Відпусти — задачу буде завершено',
	'Release — back to the backlog': 'Відпусти — задача повернеться в беклог',
	'Release — back to work': 'Відпусти — задача повернеться в роботу',
	'From the backlog only to “In progress”': 'З беклогу — лише в «У роботі»',
	'From completed only to “In progress”': 'Із завершених — лише в «У роботі»',
	'Release here': 'Відпусти тут',
	'Stop the agent?': 'Зупинити агента?',
	'The agent of «{title}» is working: its turn stops and the task moves to «{column}».':
		'Агент задачі «{title}» працює: турн зупиниться, а задача перейде в «{column}».',
	'Stop and move': 'Зупинити й перенести',
	// spec/appearance#evolution-redesign: the project icon and its picker.
	'Project icon': 'Іконка проєкту',
	'Project icon · {project}': 'Іконка проєкту · {project}',
	'Project icon…': 'Іконка проєкту…',
	Icon: 'Іконка',
	Monogram: 'Монограма',
	// spec/projects-and-board#project-icon: the Image tab — the person's image and Codex's.
	Image: 'Зображення',
	'Your image': 'Своє зображення',
	'Drawn by Codex': 'Намалював Codex',
	'No image yet': 'Зображення ще немає',
	'Or drag or paste it': 'Або перетягни чи встав',
	'Choose file…': 'Вибрати файл…',
	'Generate with Codex': 'Згенерувати в Codex',
	'What should it show?': 'Що на ній зобразити?',
	'Codex is not available.': 'Codex недоступний.',
	'Could not generate an icon.': 'Не вдалося згенерувати іконку.',
	'Could not use this image.': 'Не вдалося використати зображення.',
	'Picked by the agent': 'Вибрав агент',
	'Not picked by the agent': 'Агент ще не вибрав',
	'Picking an icon…': 'Вибір іконки…',
	'Pick again': 'Вибрати ще раз',
	'Search icons': 'Пошук іконок',
	Suggested: 'Запропоновані',
	'All icons': 'Усі іконки',
	'No icons found': 'Іконок не знайдено',
	Colour: 'Колір',
	'Reset to monogram': 'Повернути монограму',
	'Found in the repo': 'Знайдено в repo',
	'Looking in the repo…': 'Пошук у repo…',
	'No app icon in the repo': 'У repo немає іконки застосунку',
	'App icon': 'Іконка застосунку',
	'Adaptive icon': 'Адаптивна іконка',
	Favicon: 'Favicon',
	Logo: 'Логотип',
	Red: 'Червоний',
	Orange: 'Помаранчевий',
	Green: 'Зелений',
	Gray: 'Сірий',
	'Could not save the project icon.': 'Не вдалося зберегти іконку проєкту.',
	'Could not pick an icon.': 'Не вдалося вибрати іконку.',
	'The suggestion model is off.': 'Модель підказки вимкнена.',
	// spec/appearance#evolution-redesign: a collapsed crew's summary line.
	'{n} working': '{n} у роботі',
	'{n} done (workers)': '{n} готово',
	// spec/appearance#evolution-redesign, spec/git#commit-dialog: the commit dialog «Кошики».
	'Commit…': 'Закомітити…',
	// spec/git#commit-dialog: the strip's button — a verb («Commit» above it is the noun, «Коміт»); EN shows «Commit».
	'Commit changes': 'Закомітити',
	'Commit {n}': 'Закомітити {n}',
	'Commit and push': 'Закомітити й відправити',
	'Commit actions': 'Дії коміту',
	'Split with the agent': 'Поділити з агентом',
	'Split again': 'Поділити ще раз',
	'{agent} proposes commits from the diff. You can undo.': '{agent} запропонує коміти за дифом.',
	'{agent} is splitting the changes into commits…': '{agent} ділить зміни на коміти…',
	'{agent} proposed {commits}': '{agent} пропонує {commits}',
	'They replaced your {commits}. Edit them like any other.': 'Замість попередніх: {commits}.',
	'Back to your commits': 'Повернути попередні коміти',
	'Could not split the changes.': 'Не вдалося поділити зміни.',
	'Your commits did not change.': 'Коміти не змінились.',
	'Generate messages': 'Згенерувати повідомлення',
	'Generate the empty messages': 'Згенерувати порожні повідомлення',
	'Generate missing': 'Згенерувати відсутні',
	'Generating {n} messages…': 'Генерація повідомлень: {n}…',
	'Waiting for the messages': 'Очікування повідомлень',
	'Write a message or generate one.': 'Напиши повідомлення або згенеруй.',
	'{commit} needs a message': '{commit} без повідомлення',
	'{commit} is empty and will be skipped': '{commit} порожній, його буде пропущено',
	'An empty commit is skipped.': 'Порожній коміт буде пропущено.',
	'1 commit · all files': '1 коміт · усі файли',
	'1 commit · {files} not in a commit': '1 коміт · поза комітами: {files}',
	'{commits} · in order {first} → {last}': '{commits} · по черзі {first} → {last}',
	'{commits} in {repos}': '{commits} у {repos}',
	'Committing {n} of {total}…': 'Коміт {n} з {total}…',
	'{done} of {total} committed · fix {commit} and retry':
		'Закомічено {done} з {total} · виправ {commit} і повтори',
	'Retry {commit}': 'Повторити {commit}',
	'Retry {first} and {last}': 'Повторити {first} і {last}',
	'Retry {first}–{last}': 'Повторити {first}–{last}',
	'Hook failed': 'Хук не пройшов',
	Waiting: 'Чекає',
	Skipped: 'Пропущено',
	'No files': 'Без файлів',
	'Drag files here': 'Перетягни файли сюди',
	'New commit': 'Новий коміт',
	'drop files here': 'кинь файли сюди',
	'Move {n} to': 'Перенести {n} в',
	'Move {files} to': 'Перенести {files} в',
	'Move to': 'Перенести в',
	'Move its files to another commit first.': 'Спершу перенеси його файли в інший коміт.',
	'Remove commit': 'Прибрати коміт',
	'Leave out of the commit': 'Прибрати з коміту',
	'Not in a commit': 'Поза комітами',
	'Only commits of {repo}': 'Лише коміти {repo}',
	Select: 'Вибрати',
	'No preview for this file.': 'Для цього файла немає перегляду.',
	'Committed {commits} to {repo}.': 'Закомічено {commits} у {repo}.',
	'Committed {commits} in {repos}.': 'Закомічено {commits} у {repos}.',
	'Push all': 'Відправити все',
	'Commit stopped: a hook or Git refused it.': 'Коміти зупинено: відмовив хук або Git.',
	// spec/appearance#evolution-redesign: the Conflicts dialog, the merge in three columns, the banner in Changes.
	'Merging {from} into {into}': 'Мердж {from} у {into}',
	'Rebasing {branch} onto {base}': 'Rebase {branch} на {base}',
	'commit {n} of {m}': 'коміт {n} з {m}',
	'Resolve with the agent': 'Розвести з агентом',
	'Resolve {n} with the agent': 'Розвести {n} з агентом',
	'Resolve this file with the agent': 'Розвести цей файл з агентом',
	'{n} with conflicts': '{n} з конфліктами',
	'all resolved': 'усе розведено',
	'Accept yours': 'Взяти твоє',
	'Accept theirs': 'Взяти їхнє',
	'Merge by hand…': 'Мердж…',
	'The file is not text: accept one side.': 'Файл не текстовий: візьми одну сторону.',
	'Side: yours': 'Твоє',
	'Side: theirs': 'Їхнє',
	'Resolved: merged': 'Зведено',
	'Resolved: kept': 'Лишено',
	'Resolved: deleted': 'Видалено',
	'Resolved by the agent ·': 'Розвів агент ·',
	'review (conflict)': 'переглянути',
	'Resolving…': 'Розводить…',
	'Agent failed': 'Агент не розвів',
	'Back to the conflict': 'Повернути конфлікт',
	'Abort merge…': 'Скасувати мердж…',
	'Abort rebase…': 'Скасувати rebase…',
	'Abort rebase': 'Скасувати rebase',
	'{n} of {m} resolved': '{n} з {m} розведено',
	'All {n} resolved': 'Усі {n} розведено',
	'{n} to review': '{n} на перегляд',
	'Commit the merge': 'Закомітити мердж',
	'Continue the rebase': 'Продовжити rebase',
	'{agent} is resolving {files}…': '{agent} розводить {files}…',
	'Each file opens for review in the merge view. You can keep resolving the others.':
		'Кожен файл відкриється на перегляд у мерджі.',
	'The agent could not resolve {file}.': 'Агент не розвів {file}.',
	'Ready for review: {n}.': 'Готово до перегляду: {n}.',
	'The agent could not resolve the files.': 'Агент не розвів файли.',
	'Abort the merge?': 'Скасувати мердж?',
	'Abort the rebase?': 'Скасувати rebase?',
	'The tree goes back to {sha} on {branch}.': 'Дерево повернеться до {sha} на {branch}.',
	'Resolved files will be lost: {n}.': 'Розведені файли буде втрачено: {n}.',
	"The agent's result will be lost.": 'Результат агента буде втрачено.',
	'Merged {from} into {into}.': 'Змерджено {from} у {into}.',
	'Rebased {branch} onto {base}.': 'Rebase {branch} на {base} завершено.',
	'Merge aborted. The tree is back to {sha}.': 'Мердж скасовано. Дерево повернулось до {sha}.',
	'Rebase aborted. The branch is back to {sha}.': 'Rebase скасовано. Branch повернулась до {sha}.',
	'The next commit stopped with conflicts.': 'Наступний коміт зупинився з конфліктами.',
	'Could not commit the merge.': 'Не вдалося закомітити мердж.',
	'Could not resolve {file} with the agent.': 'Не вдалося розвести {file} з агентом.',
	'Could not read the conflicts.': 'Не вдалося прочитати конфлікти.',
	'Could not open {file} for merging.': 'Не вдалося відкрити {file} для мерджу.',
	'Could not apply {file}.': 'Не вдалося застосувати {file}.',
	'Could not bring the conflict in {file} back.': 'Не вдалося повернути конфлікт у {file}.',
	'Result (merge)': 'Результат',
	editable: 'можна правити',
	'Accept both': 'Взяти обидва',
	'Yours, then theirs': 'Твоє, потім їхнє',
	'Apply non-conflicting changes': 'Застосувати неконфліктні зміни',
	'Non-conflicting': 'Неконфліктні',
	'Previous conflict': 'Попередній конфлікт',
	'Next conflict': 'Наступний конфлікт',
	'filled by the agent': 'заповнив агент',
	'Take yours into the result': 'Взяти твоє в результат',
	'Take theirs into the result': 'Взяти їхнє в результат',
	'Add yours as well': 'Додати й твоє',
	'Add theirs as well': 'Додати й їхнє',
	'Ignore yours': 'Відкинути твоє',
	'Ignore theirs': 'Відкинути їхнє',
	'All conflicts resolved': 'Усі конфлікти розведено',
	'Apply accepts them': 'Застосувати — прийняти',
	'{agent} resolved {conflicts} in {file}': '{agent} розвів {conflicts} у {file}',
	'{agent} is resolving {file}…': '{agent} розводить {file}…',
	'The result is read-only until the agent is done.':
		'Результат лише для читання, поки агент працює.',
	'Conflict {n} · the agent': 'Конфлікт {n} · агент',
	'Kept yours.': 'Лишив твоє.',
	'Kept theirs.': 'Лишив їхнє.',
	'Kept both: yours, then theirs.': 'Лишив обидва: твоє, потім їхнє.',
	'Kept the base.': 'Лишив базу.',
	'Wrote its own version from both sides.': 'Написав свою версію з обох боків.',
	'Close without applying?': 'Закрити без застосування?',
	'Your choices in {file} are lost. The file stays in conflict.':
		'Вибір у {file} буде втрачено. Файл лишиться в конфлікті.',
	'Merge stopped': 'Мердж зупинився',
	'Rebase stopped': 'Rebase зупинився',
	'onto {base}': 'на {base}',
	'Resolve…': 'Розвести…',
	'Conflicts resolved': 'Конфлікти розведено',
	'Continue…': 'Продовжити…',
	'Continue commits the merge': 'Продовжити — закомітити мердж',
	'Rebase in progress': 'Rebase у процесі',
	'Resolve conflicts…': 'Розвести конфлікти…',
	'Finish or abort the merge first.': 'Спершу заверши або скасуй мердж.',
	'Resolve in the dialog': 'Розвести в діалозі',
	'Merge {base} into the PR branch, then pick per file':
		'Мердж {base} у гілку PR, далі — вибір по файлах',
	'The agent resolves; you review, finish the merge and push':
		'Агент розводить; ти переглядаєш, завершуєш мердж і робиш push',
	'In the task «{task}» on the PR branch': 'У задачі «{task}» на гілці PR',
	// spec/appearance#evolution-redesign: the PR review in a modal — steps, the agent summary, the entries.
	'Start review': 'Почати ревʼю',
	'Continue review': 'Продовжити ревʼю',
	'New review': 'Нове ревʼю',
	'Opens the review window': 'Відкриває вікно ревʼю',
	'Suggestions from the agent': 'Пропозиції агента',
	'Review steps': 'Кроки ревʼю',
	Read: 'Читання',
	Verdict: 'Рішення',
	Summary: 'Підсумок',
	'Next: {step}': 'Далі: {step}',
	'Generated by {agent} · head {sha}': 'Написав {agent} · head {sha}',
	Regenerate: 'Написати заново',
	Expand: 'Розгорнути',
	'Update summary': 'Оновити підсумок',
	'The PR changed since the summary.': 'PR змінився після підсумку.',
	'Risky spots': 'Ризики',
	'What to check': 'Що перевірити',
	Lines: 'Рядки',
	'{n} min': '{n} хв',
	'Nothing to summarize.': 'Нема що підсумовувати.',
	'No risky spots found.': 'Ризиків не знайдено.',
	'Nothing beyond the diff.': 'Нічого поза дифом.',
	'Nothing to summarize: the PR changes no files.': 'Нема що підсумовувати: PR не змінює файлів.',
	'Sign in to {agent} to get a summary. The review works without it.':
		'Увійди в {agent}, щоб отримати підсумок.',
	'Could not write the summary: {reason}. The review works without it.':
		'Не вдалося написати підсумок: {reason}.',
	'No agent can write a summary: Claude and Codex are off in Settings ▸ Agents.':
		'Підсумок нікому писати: Claude і Codex вимкнені в Налаштуваннях ▸ Агенти.',
	'Open Settings': 'Відкрити налаштування',
	'Automatic summaries are off.': 'Автоматичні підсумки вимкнено.',
	'No summary yet.': 'Підсумку ще немає.',
	'Reading the summary…': 'Читання підсумку…',
	// spec/appearance#evolution-redesign: the summary in the step column, its tab on steps 2–5 and the badges on the files.
	'Reading {n}… The diff is ready to read meanwhile.': 'Читання: {n}…',
	'{n} since the summary.': '{n} після підсумку.',
	'What changed': 'Що змінилось',
	'Less (summary)': 'Менше',
	'only for you': 'лише для тебе',
	'Risky spot': 'Ризик',
	'To check': 'Перевірити',
	// spec/appearance#evolution-redesign: a marker of the summary under its line and its popover.
	'From the summary': 'З підсумку',
	'Comment on it': 'Прокоментувати',
	'Dismiss (marker)': 'Сховати',
	// spec/appearance#evolution-redesign: step 5's merge row when the PR can be merged.
	'Separate from the review': 'Окремо від ревʼю',
	'Your summary': 'Твій підсумок',
	'Step or summary': 'Крок чи підсумок',
	'Read the changes (step)': 'Прочитай зміни',
	'{n} not viewed': 'Не переглянуто: {n}',
	'All {n} viewed': 'Переглянуто всі {n}',
	'All {n} files viewed.': 'Переглянуто всі файли: {n}.',
	'Not viewed yet': 'Ще не переглянуто',
	'The summary found nothing risky.': 'Підсумок не знайшов ризиків.',
	'Open threads': 'Відкриті треди',
	'No open threads.': 'Відкритих тредів немає.',
	'This PR changes no files, so there is nothing to read or comment on lines. You can still send a verdict or a comment.':
		'PR не змінює файлів.',
	'The PR head and {base} have the same tree.': 'Head PR і {base} мають те саме дерево.',
	'{n}, but together they change nothing against {base}.':
		'{n}, але разом вони нічого не змінюють відносно {base}.',
	'Go to the code': 'До коду',
	'Edit the comment': 'Редагувати коментар',
	Drop: 'Відкинути',
	'{n} to go through': 'лишилось {n}',
	'Accept or drop the agent’s first': 'Спершу прийми чи відкинь пропозиції агента',
	'Accept all': 'Прийняти всі',
	'Drop all': 'Відкинути всі',
	'Drop all suggestions?': 'Відкинути всі пропозиції?',
	'The agent’s suggestions will be removed. Your comments stay. You can ask the agent again.':
		'Пропозиції агента буде видалено. Твої коментарі лишаться.',
	'No comments yet': 'Коментарів ще немає',
	'From the agent': 'Від агента',
	'The agent is reading the PR…': 'Агент читає PR…',
	'The agent read {n} and has no suggestions.': 'Агент прочитав {n} і пропозицій не має.',
	'Ask again': 'Спитати ще раз',
	quickly: 'швидко',
	'in a worktree': 'у worktree',
	'Not asked.': 'Не просили.',
	'GitHub: {reason} Move the comment to a changed line or remove it.':
		'GitHub: {reason} Перенеси коментар на змінений рядок або прибери його.',
	'Feedback only. Merging stays as it is.': 'Лише відгук. Мердж — як і був.',
	'You are fine with merging. GitHub counts your approval.': 'GitHub зарахує схвалення.',
	'Merging waits until {author} pushes fixes and you review again.':
		'Мердж чекає, доки {author} надішле правки і ти переглянеш знову.',
	'GitHub does not take this on your own PR.': 'GitHub не приймає цього на твоєму PR.',
	'The agent suggests {decision}: {reason}': 'Агент радить «{decision}»: {reason}',
	'on top of the review': 'над ревʼю',
	'Reading {n}…': 'Читання: {n}…',
	'From {n}. Edit freely.': 'Написано з {n}.',
	'Writing…': 'Пише…',
	'Generate from the drafts': 'Згенерувати з чернеток',
	'No comments to write from': 'Нема коментарів, з яких писати',
	'Generating needs comments from step 2. Write it yourself or leave it empty.':
		'Для генерації потрібні коментарі з кроку 2.',
	'Could not write the summary.': 'Не вдалося написати підсумок.',
	'What GitHub gets': 'Що отримає GitHub',
	'as you, {name}': 'від тебе, {name}',
	'approved these changes': 'схвалив ці зміни',
	'No summary': 'Без підсумку',
	'No summary · no comments': 'Без підсумку · без коментарів',
	'Comments from the agent go out under your name, without ✦.':
		'Коментарі агента підуть від твого імені, без ✦.',
	'Just the approval. {author} sees «{viewer} approved these changes» and nothing else.':
		'Лише схвалення. {author} побачить «{viewer} схвалив ці зміни» — і нічого більше.',
	'Sending…': 'Надсилання…',
	'Send as a comment': 'Надіслати коментарем',
	'or don’t send': 'або не надсилати',
	'or don’t send — fix it': 'або не надсилати — виправити',
	'Hand to the agent to fix': 'Передати агенту на виправлення',
	'No agent can take the fixes here': 'Тут нема агента, що візьме правки',
	'No comments or text to hand over': 'Нема коментарів чи тексту для передачі',
	'The task «{title}» gets {n}. Push only after you confirm.':
		'Задача «{title}» отримає {n}. Push — лише після твого підтвердження.',
	'A quick task «Fixes #{n}» on {branch} in the main tree: it switches the tree if it is clean. Push only after you confirm.':
		'Швидка задача «Виправлення #{n}» на {branch} в основному дереві: перемкне дерево, якщо воно чисте. Push — лише після твого підтвердження.',
	'GitHub did not accept the review: {reason} The drafts are saved.':
		'GitHub не прийняв ревʼю: {reason} Чернетки збережено.',
	'Go to the comment': 'До коментаря',
	'Agent · draft': 'Агент · чернетка',
	'A comment needs text or comments on lines.': 'Коментарю потрібен текст або коментарі на рядках.',
	'PR summary': 'Підсумок PR',
	'Summarize a PR when its review opens': 'Підсумовувати PR, коли відкривається ревʼю',
	// spec/projects-and-board#pr-mode: PR mode on the project screen.
	'Project tabs': 'Вкладки проєкту',
	'Pull requests (tab)': 'Pull requests',
	'PR filter': 'Фільтр PR',
	// spec/sidebar#section-rail: the section rail.
	Sections: 'Розділи',
	'Tasks (section)': 'Задачі',
	'Pull requests (section)': 'Pull requests',
	'All pull requests': 'Усі pull requests',
	'Filter pull requests': 'Фільтр pull requests',
	'Settings (rail)': 'Налаштування',
	'Draft (column)': 'Чернетки',
	'Open (column)': 'Відкриті',
	'In review (column)': 'На ревʼю',
	'Closed (column)': 'Закриті',
	'Reviewed on GitHub, or a review started here': 'Ревʼю на GitHub або почате тут',
	'Merged or closed in the last 7 days': 'Змерджені й закриті за 7 днів',
	'7 days': '7 днів',
	'Nobody is reviewing yet': 'Ще ніхто не переглядає',
	'Nothing closed in 7 days': 'За 7 днів нічого не закрито',
	'No pull requests': 'PR немає',
	'Nothing open, nothing closed in the last 7 days.': 'Немає відкритих PR і закритих за 7 днів.',
	'Could not load pull requests.': 'Не вдалося завантажити PR.',
	'Could not mark the PR ready for review.': 'Не вдалося позначити PR готовим до ревʼю.',
	'PR #{n} · Open the review': 'PR #{n} · Відкрити ревʼю',
	'Task (link)': 'Задача',
	'Your review': 'Твоє ревʼю',
	'Continue your review': 'Продовжити своє ревʼю',
	'{v}/{t} viewed': 'переглянуто {v}/{t}',
	'Review requested': 'Запитано ревʼю',
	// spec/browser-and-simulator#notifications: notifications of a page in the task's browser.
	'{host} wants to show notifications': '{host} хоче показувати сповіщення',
	Block: 'Блокувати',
	'Site notifications': 'Сповіщення сайту',
	'Ask (notifications)': 'Питати',
	'Allow (notifications)': 'Дозволяти',
	'Block (notifications)': 'Блокувати',
	'Could not save the site notifications.': 'Не вдалося зберегти сповіщення сайту.',
	// spec/browser-and-simulator#tab-sound: the sound of a browser tab.
	'Mute tab': 'Вимкнути звук вкладки',
	'Unmute tab': 'Увімкнути звук вкладки',
	// spec/notifications-slack-notes-and-schedules#slack: Slack
	Slack: 'Slack',
	'@ mentions': '@згадки',
	'Slack settings': 'Налаштування Slack',
	'Task and CI messages from your CI bot.': 'Задачі й CI від твого CI-бота.',
	Bot: 'Бот',
	'Bot token': 'Токен бота',
	'Your own CI bot: api.slack.com/apps · bot scope chat:write · Install to Workspace':
		'Твій CI-бот: api.slack.com/apps · bot scope chat:write · Install to Workspace',
	'Your member ID': 'Твій member ID',
	'Profile ▸ ⋯ ▸ Copy member ID — for direct messages':
		'Профіль ▸ ⋯ ▸ Copy member ID — для особистих повідомлень',
	'A member ID starts with U.': 'Member ID починається з U.',
	'Retry now': 'Повторити зараз',
	'Replace token…': 'Замінити токен…',
	'Move to Keychain': 'Перенести в Keychain',
	'Token in Keychain': 'Токен у Keychain',
	'From SLACK_CI_BOT_TOKEN': 'З SLACK_CI_BOT_TOKEN',
	'No token in Keychain, in SLACK_CI_BOT_TOKEN or in a project’s .env.local.':
		'Токена немає ні в Keychain, ні в SLACK_CI_BOT_TOKEN, ні в .env.local проєкту.',
	'The bot token is no longer valid': 'Токен бота більше не дійсний',
	'messages are not sent': 'повідомлення не надсилаються',
	'Slack is unreachable': 'Slack недоступний',
	'Retrying in 30 s · {count} waiting': 'Повтор за 30 с · чекають: {count}',
	'Slack did not take a message:': 'Slack не прийняв повідомлення:',
	Where: 'Куди',
	'Without a channel, messages come to you as direct messages. One task, one thread.':
		'Без каналу повідомлення приходять тобі в особисті. Одна задача — один тред.',
	'Direct message': 'Особисті повідомлення',
	Channel: 'Канал',
	'Mention group (S…)': 'Згадати групу (S…)',
	Events: 'Події',
	'CI finished': 'CI завершився',
	'PR merged (event)': 'PR змерджено',
	'Task completed': 'Задачу завершено',
	'Scheduled run failed': 'Запуск за розкладом не вдався',
	// spec/notifications-slack-notes-and-schedules#slack: @ mentions in Slack
	'@ mentions in Slack': '@згадки в Slack',
	'Create tasks from Slack': 'Задачі зі Slack',
	'App-level token': 'App-level токен',
	'api.slack.com/apps ▸ Basic Information ▸ App-Level Tokens':
		'api.slack.com/apps ▸ Basic Information ▸ App-Level Tokens',
	'Needs the bot token above.': 'Потрібен токен бота вище.',
	'Listening for mentions': 'Слухає згадки',
	'Slack refused the app-level token': 'Slack не прийняв app-level токен',
	'No app-level token': 'Немає app-level токена',
	'Socket Mode: on, with an app-level token (connections:write).':
		'Socket Mode: увімкнути, з app-level токеном (connections:write).',
	'Bot scopes: app_mentions:read, channels:history, groups:history, im:history.':
		'Bot scopes: app_mentions:read, channels:history, groups:history, im:history.',
	'Bot events app_mention, message.channels, message.groups, message.im and Interactivity on, then Reinstall to Workspace.':
		'Події бота app_mention, message.channels, message.groups, message.im та Interactivity, потім Reinstall to Workspace.',
	Who: 'Хто',
	'Your member ID is always on the list.': 'Твій member ID завжди в списку.',
	'These people': 'Ці люди',
	'Anyone in the channel': 'Будь-хто в каналі',
	'Add person': 'Додати людину',
	'Ask in Brigadir': 'Спитати в Бригадирі',
	'New task from Slack': 'Нова задача зі Slack',
	'Note from Slack': 'Нотатка зі Slack',
	'From Slack': 'Зі Slack',
	'Slack thread': 'Тред у Slack',
	// spec/notifications-slack-notes-and-schedules#slack: the agent of Slack's tasks and Slack's two actions in Customize per action.
	'Agent for tasks': 'Агент задач',
	'New tasks from Slack.': 'Нові задачі зі Slack.',
	'Slack: answers': 'Slack: відповіді',
	'Slack: code questions': 'Slack: питання про код',
	'And questions about a task': 'І питання про задачу',
} as const;
export type MessageKey = keyof typeof uk;
export type Locale = 'en' | 'uk';
export function selectLocale(locale: string): Locale {
	return locale.toLowerCase().startsWith('uk') ? 'uk' : 'en';
}
/** spec/chat#images: a pasted image is named by its kind in the interface language; older attachments stored the name already translated. */
const pastedImageNames: ReadonlySet<string> = new Set(['Pasted image', uk['Pasted image']]);
export function attachmentLabel(
	locale: Locale,
	item: { kind: 'text' | 'image'; name: string }
): string {
	return item.kind === 'image' && pastedImageNames.has(item.name)
		? t(locale, 'Pasted image')
		: item.name;
}
/** Keys whose English text is shared with another key of a different Ukrainian word. */
const english: Partial<Record<MessageKey, string>> = {
	'Where the agent works': 'Where',
	'Who reviews': 'Who',
	'PR merged (event)': 'PR merged',
	'Repeat (schedule)': 'Repeat',
	'Schedule (verb)': 'Schedule',
	'Repeat (field)': 'Repeat',
	'No runs (schedule)': 'No runs',
	'Ask (missed)': 'Ask',
	'Now (when)': 'Now',
	'Resume (schedule)': 'Resume',
	// spec/notifications-slack-notes-and-schedules#notification-center: the notification center's own words beside keys of other meanings.
	'Clear (notices)': 'Clear',
	'Dismiss (notice)': 'Dismiss',
	'Answer (notice)': 'Answer',
	// spec/settings-modules-and-onboarding#module-settings-popup: remote access settings live in Settings ▸ Modules ▸ Remote access, so the English text differs from the key.
	'On {machine}: Settings ▸ Remote ▸ Add a device, then enter the code it shows.':
		'On {machine}: Settings ▸ Modules ▸ Remote access ▸ Add device, then enter the code it shows.',
	'On the working machine: Settings ▸ Remote ▸ **Add device** shows the code.':
		'On the working machine: Settings ▸ Modules ▸ Remote access ▸ **Add device** shows the code.',
	'The code is shown on **{machine}**: Settings ▸ Remote ▸ Add device. Valid for 5 min.':
		'The code is shown on **{machine}**: Settings ▸ Modules ▸ Remote access ▸ Add device. Valid for 5 min.',
	'Add devices in Settings ▸ Remote.': 'Add devices in Settings ▸ Modules ▸ Remote access.',
	'The code is shown on {machine}: Settings ▸ Remote ▸ Add device. It lasts 5 min.':
		'The code is shown on {machine}: Settings ▸ Modules ▸ Remote access ▸ Add device. It lasts 5 min.',
	'The passkey of this phone can be revoked on {machine} in Settings ▸ Remote.':
		'The passkey of this phone can be revoked on {machine} in Settings ▸ Modules ▸ Remote access.',
	'Compact (conversation)': 'Compact',
	'Done (step)': 'Done',
	'Pull requests (module)': 'Pull requests',
	'Choose (folder)': 'Choose',
	'today (folder)': 'today',
	'yesterday (folder)': 'yesterday',
	'a month (folder)': 'a month',
	'Folder up': 'Up',
	'Pull requests (segment)': 'Pull requests',
	'PR (segment)': 'PR',
	'All (PRs)': 'All',
	'Hand to the agent (conflict)': 'Hand to the agent',
	'Resolve (conflict)': 'Resolve',
	'Notifications (toasts)': 'Notifications',
	'new (file)': 'new',
	'unavailable (repo)': 'unavailable',
	'Light weight': 'Light',
	'Completed task': 'Completed',
	'Archive (noun)': 'Archive',
	'All (archive)': 'All',
	'Auto (archive)': 'Auto',
	'auto (archive)': 'auto',
	'Select (archive)': 'select',
	'open (archive)': 'open',
	'All mentions': 'All',
	'next tab': 'next',
	'skill (kind)': 'skill',
	'slash command (kind)': 'slash command',
	'MCP tool (kind)': 'MCP tool',
	'No task is open: searching the main tree of': 'Searching the main tree of',
	'Type to search the text of the files': 'Search file contents',
	'searching the text…': 'searching text…',
	'What the foreman reads about this agent. In English.': 'In English.',
	'read only': 'read-only',
	'What this agent does differently from the template. In English.':
		'Additional instructions, in English.',
	'Has subordinates: it gets the foreman tools in its zone: split, delegate, read reports and diffs, accept. It writes no code itself. Remove the subordinates and the template comes back.':
		'Manages subordinates in its zone. Writes no code. Without subordinates, uses the original template.',
	'checks directly, up to 2 rounds, then up': 'up to 2 review rounds, then escalation to the lead',
	'A branch deeper than two levels. Each level is one more relay and one more context.':
		'More than two levels. Each level adds a context handoff.',
	'Instructions here add to the briefing, they do not replace it.': 'Add to the briefing.',
	'writes no code · read_report · read_diff · submit_review · approve on the agents it checks':
		'Reads reports and changes, submits reviews, and approves work. Writes no code.',
	'in English: who you are, not what to do': 'Agent role, in English',
	'{agent} is a reviewer and takes no part of the code.':
		'{agent} reviews code and takes no plan parts.',
	'Part {n}: differences with the crew. Start waits for a fix.':
		'Part {n} does not match the crew. Fix before starting.',
	'Parts {n}: differences with the crew. Start waits for a fix.':
		'Parts {n} do not match the crew. Fix before starting.',
	'The foreman did not answer in five minutes. You can answer for it.':
		'No foreman response in 5 minutes. You can answer instead.',
	'Workers working now': 'Active workers',
	'Queued messages will resume after the reset.': 'Queued messages resume after the limit resets.',
	'Agents in work': 'Active agents',
	'No live agents': 'No active agents',
	'Some agents could not be read.': 'Could not load some agent data.',
	'Kill process…': 'Force quit process…',
	'Kill process': 'Force quit process',
	'Stop the turn; keep the session alive.': 'Stops the turn without ending the session.',
	'Live sessions across all projects': 'Active sessions across all projects',
	'Open Recent': 'Recent projects',
	'Clear Recent': 'Clear recent projects',
	'Add the answer to the project instructions so future tasks can use it.':
		'Add the answer to the instructions for future tasks.',
	'An agent writes this text using your subscription. You can edit it before adding.':
		'Uses your subscription.',
	'Refresh the preview': 'Refresh preview',
	'The agent did not return an addition.': 'The agent returned no addition.',
	'Mac sleep': 'Keep awake',
	'Keep the Mac awake while agents work': 'Keep the computer awake while agents work',
	'The display still sleeps; closing a laptop lid still puts the Mac to sleep.':
		'The display can turn off. Lid-close sleep follows system settings.',
	'Now working: {count} — the Mac stays awake.': 'Working: {count}',
	'Generate the title and description': 'Generate title and description',
	'The description could not be generated. You can edit it and create the PR.':
		'Could not generate the description. Enter it manually and create the PR.',
	Writable: 'Read and write',
	'file, agent or someone from the crew': 'file, agent, or crew member',
	'Commands appear once the agent starts': 'Commands appear after the agent starts',
	'Works only as the first word of the message.': 'Only at the start of a message.',
	'Preliminary list: the agent has not started': 'Preliminary list. Agent not started.',
	"The task's copy of the repos will be removed. Branches and commits stay, and the next start prepares a new worktree.":
		'Removes the task’s repo copies. Branches and commits stay. The next start creates worktrees.',
	'A repo found after setup comes in read-only.': 'Repos found after setup are read-only.',
	'Repo locks could not be read.': 'Could not check repo locks.',
	'It took the lock {minutes} min ago.': 'Locked {minutes} min ago.',
	'Waiting for the lock': 'Waiting for the repo',
	'The task works in its own copy of every repo and takes no locks. Preparation takes longer, because each repository gets a branch and the setup command runs.':
		'Separate repo copies without locks. Branch creation and setup commands take extra time.',
	'The task waits and starts by itself when the lock is free. If the task that holds the lock dies, the queue notices within 3 seconds.':
		'Starts when the repo is free. Detects the other task’s failure within 3 seconds.',
	'Both tasks write to one repo. The diff of this task will show the changes of the other one, and the other way round. While this lasts, the repo is marked contended and both diffs carry a warning.':
		'Both tasks write to one repo. Their changes mix; both show a warning.',
	'The tasks write to one repo without isolation. Each diff also shows the others’ changes.':
		'Tasks share one repo without isolation. Each diff includes all tasks’ changes.',
	'Opened because another task writes to this repo.':
		'Opened automatically because another task writes to this repo.',
	'Opens by itself when another task joins the repo.':
		'Opens when another task starts writing to the repo.',
	'Launch settings are saved for this project.': 'Saves launch settings for this project.',
	'Next agent needing you': 'Next agent awaiting input',
	'Previous agent needing you': 'Previous agent awaiting input',
	'No fonts match': 'No matching fonts',
	'This font is unavailable. Using the system font.': 'Font unavailable. Using the system font.',
	'This font is unavailable. Using system mono.':
		'Font unavailable. Using the system monospace font.',
	'Compact toolbar. Hover over an icon to see its name.': 'Button names on hover.',
	'Names beside surface icons. Labels collapse in narrow windows.': 'Hidden in narrow windows.',
	'The language will change after restart.': 'Language changes require a restart.',
	'Continue the saved agent session in the terminal.':
		'Continue the saved session in the terminal.',
	'Start the agent to work on this task in the terminal.': 'Start the agent in the task terminal.',
	'This file was edited by you. There is no agent turn.': 'Your edit. No agent turn.',
	'These lines were edited by you. There is no agent turn.': 'Your edits. No agent turn.',
	'The review changed. Cancel and check the comments before deleting.':
		'The review changed. Cancel deletion and check the comments.',
	'Select lines in the editor or diff to add a comment.':
		'Select code in the editor or diff to comment.',
	'Select lines again to attach this draft.': 'Select code again to attach this draft.',
	'The files could not be attached. Check the attachment limits.':
		'Could not attach the files. Check attachment limits.',
	'Up to 10 files, 8 MB together; images up to 4 MB':
		'Up to 10 files, 8 MB total. Images up to 4 MB.',
	'The image could not be attached. Check the attachment limits.':
		'Could not attach the image. Check attachment limits.',
	'Up to 10 files, 8 MB total; images up to 4 MB.':
		'Up to 10 files, 8 MB total. Images up to 4 MB.',
	'The agent sees it at its next step': 'Sent at the agent’s next step',
	'Waits until the agent finishes': 'Sent after the turn ends',
	'Arrives after you answer the request': 'Sent after you answer the request',
	'Filter the tree': 'Filter files',
	'You can give a task to one agent or to a crew. The foreman divides the task between the agents and accepts their work.':
		'One agent or a crew.',
	'One crew can use agents from different providers. Set the model and effort in Settings ▸ Templates.':
		'Agents from different providers in one crew.',
	'To use a crew, press ⌘N and select Foreman. You make your own crew in the crew editor.':
		'Select Foreman in a new task.',
	'One agent will work. You can see it in the chat.': 'One agent in the chat.',
	'Both agents are ready. The chat shows the default one.': 'Both agents are ready.',
	'Show the intro again…': 'Repeat setup…',
	'Choose a keymap and change any shortcut. You see conflicts at once.':
		'Keymap, shortcut editing, and conflict checks.',
	'Brigadir runs agents through their CLIs and works only with your subscription. API keys are not supported.':
		'Agents use their CLI subscriptions. API keys are unsupported.',
	'Checking git and GitHub CLI…': 'Checking Git and GitHub CLI…',
	'Choose a folder with code. Brigadir finds every git repository inside it.':
		'Choose a code folder to find repos.',
	'Choose how you follow your tasks.': 'Task board or list.',
	'Code font and colors. The diff uses the same theme.':
		'Code font and colors in the editor and diff.',
	'Completion, go to definition, problems. About 0.45 GB of memory for each project.':
		'Code completion, definitions, and diagnostics. About 0.45 GB per project.',
	'Git is ready. You can install GitHub CLI later.': 'Git is ready.',
	Intro: 'Initial setup',
	'Look at the window: it changes as you choose.': 'Theme, accent, text size, and layout.',
	'Looking for agents on this Mac…': 'Finding agents…',
	'No banners. A task that waits for you glows in the sidebar.':
		'No banners. Tasks awaiting input are marked in the sidebar.',
	'Not found. You need it for pull requests and checks.': 'Not found. Required for PRs and checks.',
	'Not requested yet. macOS asks one time.': 'Permission not requested yet.',
	'Notifications are allowed': 'Notifications allowed',
	'The agent works in the project folder. You can change this for each task.':
		'Works in the project folder.',
	'The diff shows all that the agent changed since the task started.':
		'All changes since task start.',
	'The diff shows only uncommitted changes, as git status does.': 'Uncommitted changes.',
	'The project Prettier. If there is none, the language server.':
		'Project Prettier, or the language server if Prettier is unavailable.',
	'The repositories appear in the sidebar on the left.': 'Discovered repos in the sidebar.',
	'There is no agent. You need at least one.': 'At least one agent is required.',
	'You need an agent to continue. Install Claude Code or Codex, then check again.':
		'Install Claude Code or Codex, then check again.',
	'Looking…': 'Searching…',
	'Not found on this Mac': 'Not found on this computer',
	'Find in view': 'Find in current panel',
	'Reveal in Finder': 'Show in file manager',
	'Select node': 'Select element',
	'Show diff': 'Show changes',
	'Disk and buffer': 'Disk file and unsaved edits',
	'replaced $ matches': 'Replaced $ matches',
	'A stray carriage return (CR) in this line': 'Stray CR character on this line',
	'The files return when the task continues and its worktree is created again.':
		'Resuming the task recreates its worktree and files.',
	'What is wrong with these lines?': 'Comment on the selected code',
	'{n} selected': 'Selected: {n}',
	'No task is selected.': 'No task selected.',
	'Checkbox and radio': 'Checkboxes and radio buttons',
	'Controls only; no workspace data is changed.': 'Control examples. Project data is unchanged.',
	'macOS permission': 'System permission',
	'Brigadir notifications are turned off in macOS.':
		'Brigadir notifications are off in system settings.',
	'Notifications are turned off in macOS': 'Notifications are off in system settings',
	'Brigadir does not show notifications.': 'Notifications are off.',
	'Quiet while I am viewing the task': 'Mute the task being viewed',
	'The agent is waiting for your permission.': 'The agent is waiting for permission.',
	'Max concurrent': 'Concurrent agents',
	'Waiting for a free agent slot.': 'Waiting for a free slot.',
	'Agent options are available after the first launch.':
		'Agent options appear after the first launch.',
	'Set aside for later': 'Deferred tasks',
	'Drop here and the agent starts': 'Drop to start',
	'Drop here what you have accepted': 'Accepted tasks',
	'The merge did not resolve itself': 'Unresolved merge conflicts',
	'Resolve it myself': 'Resolve manually',
	'Conflict places open in the editor': 'Opens conflicts in the editor',
	'Let the agent resolve': 'Ask the agent to resolve',
	'A separate turn; you accept the result': 'Separate turn. You confirm the result.',
	'Conflict resolved': 'resolved',
	'Edit by hand': 'Edit manually',
	'Resolved by the agent': 'resolved by the agent',
	'Let the agent finish resolving': 'Ask the agent to finish',
	'Commit or stash the changes before merging.': 'Commit or stash changes before merging.',
	'Resolve every conflict place first.': 'Resolve all conflicts first.',
	'No conflict places are left.': 'All conflicts resolved.',
	'Conflict place': 'Conflict',
	'Ignored .env files go into a new worktree.': 'Copies ignored .env files into a new worktree.',
	'No commits with this file yet: Git does not track it.':
		'Git does not track this file yet. No commits.',
	'What changed since the task started.': 'Changes since task start.',
	'What is not committed yet, as in git status.': 'Uncommitted changes.',
	'As default': 'Default',
	'Nothing formats this file.': 'No formatter for this file.',
	'The PR did not open here. Opened in the browser.':
		'Could not open the PR in the app. Opened in the browser.',
	crashed: 'failed',
	'Stopped by you · the output stays until the tab is closed':
		'Stopped manually. Output stays until the tab closes.',
	'Reading PRs from GitHub…': 'Loading PRs from GitHub…',
	'Older closed PRs are on GitHub': 'Older closed PRs on GitHub',
	'Reading the PR from GitHub…': 'Loading the PR from GitHub…',
	'Reading runs from GitHub…': 'Loading runs from GitHub…',
	'Another review': 'New review',
	'Take the PR out of draft: GitHub asks the reviewers, and the PR can be merged':
		'Marks the PR ready and notifies reviewers. Merging depends on repo rules.',
	'The agent looks at what was done and where': 'The agent summarizes changes',
	'{n} unresolved': 'Unresolved: {n}',
	'What to look at': 'What to review',
	'{n} will go': 'To merge: {n}',
	'GitHub did not merge the PR. The dialog stays open.': 'GitHub did not merge the PR.',
	'check failed': 'failed',
	'check running': 'running',
	'checks green': 'passed',
	'Downloading the PR branch from GitHub…': 'Fetching the PR branch…',
	'Reading the file changes…': 'Loading file changes…',
	'In the main tree, the branch stays': 'Main tree, without switching branches',
	'Branch {branch}, dependencies can be installed and run':
		'Branch {branch}. Dependencies can be installed and code run.',
	'The window stopped because of an error': 'Window error',
	'Agents and commands continue to run. When the window reloads, your tasks and chats stay in their places.':
		'Agents and commands keep running.',
	'Copy the details': 'Copy details',
	'The task window stopped because of an error': 'Task window error',
	'The board stopped because of an error': 'Board error',
	'The chat stopped because of an error': 'Chat error',
	'The document stopped because of an error': 'Document error',
	'The panel stopped because of an error': 'Panel error',
	'The console stopped because of an error': 'Console error',
	'The browser stopped because of an error': 'Browser error',
	'The simulator stopped because of an error': 'Simulator error',
	'The Brigadir window crashes again': 'Repeated Brigadir window crash',
	'The task could not be created.': 'Could not create the task.',
	'Starts once created · new branch': 'Starts immediately · new branch',
	'Goes to the backlog · new branch': 'Backlog · new branch',
	'Open in the sheet…': 'Task options…',
	'The folder could not be added.': 'Could not add the folder.',
	'reading only': 'read-only',
	'The person declined adding the folder.': 'declined',
	'The person declined the message.': 'declined',
	'Merge commit method': 'Merge commit',
	'The folder is already in the task.': 'already in the task',
	'Looking at your editor': 'Reading the editor',
	'Looked at your editor': 'Read the editor',
	'Looking at the PR': 'Reading the PR',
	'Looked at the PR': 'Read the PR',
	'is finished': 'finished',
	'The answer comes when the subagent finishes': 'Answer after the subagent finishes',
	'The subscription sign-in expired and did not renew, so the message did not reach the agent. After you sign in, Brigadir sends it again.':
		'Sign-in expired. Sign in again to resend automatically.',
	'The subscription sign-in expired and did not renew, so the agent did not start. After you sign in, it starts again.':
		'Sign-in expired. Sign in again to restart the agent automatically.',
	'Waiting for the sign-in in the browser…': 'Waiting for browser sign-in…',
	'The browser opened the {agent} sign-in page. Once you sign in, the message goes to the agent by itself.':
		'{agent} sign-in opened. The message sends automatically after sign-in.',
	'Sign-in was not finished: the page closed before the end of the sign-in.':
		'Sign-in incomplete. The page was closed.',
	'Signed in to {agent} · the message was sent again': 'Signed in to {agent}. Message resent.',
	'What do you want to know about these lines?': 'Question about the selected lines',
	'Undo the apply': 'Undo changes',
	'The lines changed after the answer. Ask again.': 'Lines changed after the answer. Ask again.',
	'The answer stays until the window closes.': 'Answer available until the window closes.',
	'«{title}» is completed': '“{title}” completed',
	'Archive hides the tasks and deletes nothing.':
		'Keeps tasks and history. Removes clean worktrees; preserves uncommitted changes.',
	'Archive hides the task and deletes nothing.':
		'Keeps the task and history. Removes its clean worktree; preserves uncommitted changes.',
	'Worktrees were already removed by the archive; nothing is lost':
		'Worktrees were removed during archiving.',
	'Worktrees with uncommitted changes are removed: {files}':
		'Uncommitted worktree changes will be lost: {files}',
	'The worktree is removed. Continuing the task creates it again from this branch.':
		'Worktree removed. Resuming recreates it from this branch.',
	'change snapshots are in place': 'change snapshots saved',
	'Goes to the archive today': 'Archives today',
	'Goes to the archive tomorrow': 'Archives tomorrow',
	'Only tasks you marked completed. Stopped and failed tasks stay in the sidebar.':
		'Only tasks marked completed.',
	'Completed tasks go to the archive after {days}': 'Completed tasks archive after {days}',
	'The task cannot go to the archive while its agent works.':
		'Cannot archive while the agent is working.',
	'Goes to the agent as text: the model id and the provider. The task model does not change.':
		'Task model stays unchanged.',
	'Opened because files changed in a read-only repo.':
		'Opened automatically because a read-only repo changed.',
	'Opens by itself when other files change there.': 'Opens when other files change in these repos.',
	'The task only reads these repos, but files in them changed during the turn.':
		'These repos are read-only for this task. Files changed during the turn.',
	'Opened because a repo of the task is unavailable.':
		'Opened automatically because a repo is unavailable.',
	'Opens by itself when another repo becomes unavailable.':
		'Opens when another repo becomes unavailable.',
	'Brigadir does not see these repos on disk. Their changes are not tracked until the folder comes back.':
		'Repos unavailable on disk. Change tracking resumes when access returns.',
	'Opened because the agent reached the subscription limit.':
		'Opened automatically because the subscription limit was reached.',
	'Opens by itself at the next limit.': 'Opens when the limit is reached again.',
	'The message has already left the queue.': 'The message is no longer queued.',
	'Could not compare {file} with the disk.': 'Could not compare {file} with its disk version.',
	'Could not read the commit list.': 'Could not load the changes to commit.',
	'Files changed. Review the commit list again.': 'Files changed. Review the changes to commit.',
	'Commit changes': 'Commit',
	'The branch changed. Refresh the commit list.': 'Branch changed. Refresh the changes to commit.',
	'Files or staging changed. Review the commit list again.':
		'Files or staging changed. Review the changes to commit.',
	'Could not mark {file} resolved.': 'Could not mark conflicts in {file} as resolved.',
	'Could not take the PR out of draft.': 'Could not mark the PR ready for review.',
	'Could not switch node selection.': 'Could not toggle element selection.',
	'Could not attach the node.': 'Could not attach the element.',
	'Could not add the text. It is kept.': 'Could not add the text. Text saved.',
	'Could not kill the process.': 'Could not force quit the process.',
	'Could not filter the tree.': 'Could not filter the files.',
	'Could not save the formatter.': 'Could not save the formatter selection.',
	'Could not read why this changed.': 'Could not determine why this changed.',
	'Could not save the collapsed projects.': 'Could not save which projects are collapsed.',
	'Could not save the collapsed crews.': 'Could not save which crews are collapsed.',
	'Could not save the collapsed completed tasks.':
		'Could not save whether completed tasks are collapsed.',
	'Could not attach the selection to the chat.': 'Could not attach the selected lines to the chat.',
	'The binary file {file} does not open in the editor.':
		'The editor cannot open binary file {file}.',
	'⌘V or drag: images and files': '{shortcut} or drag files and images',
	'⌘+click opens in editor': '{shortcut} opens in editor',
	'⌘+click opens the link': '{shortcut} opens the link',
	'⌘↩ send · Esc cancel': '{shortcut} send · Esc cancel',
	'No worktrees to remove': 'No worktrees to remove',
	'Development server': 'Development server',
	'Show all (layout)': 'Show all',
	'agent (tab)': 'agent',
	'will click {target}': 'click {target}',
	'will hover {target}': 'hover {target}',
	'will type into {target}': 'type into {target}',
	'will press {key}': 'press {key}',
	'will scroll the page': 'scroll the page',
	'will select in {target}': 'select in {target}',
	'will go back': 'go back',
	'will go forward': 'go forward',
	'will reload the page': 'reload the page',
	'will allow notifications': 'allow notifications',
	'will block notifications': 'block notifications',
	'will reset notifications': 'reset notifications',
	'Decline (show the page)': 'Decline',
	'Again (password)': 'Again',
	'Log (remote access)': 'Log',
	'Change (password)': 'Change',
	'Available (machine)': 'Available',
	'Checking… (machine)': 'Checking…',
	'Window open (machine)': 'Window open',
	'window open (machine)': 'window open',
	'Go to (machines)': 'Go to',
	'Unavailable (machine)': 'Unavailable',
	'Try again (connection)': 'Try again',
	'Add a device': 'Add device',
	'Working now (cover)': 'Working now',
	'Retry (link)': 'Retry',
	'Retry (turn)': 'Retry',
	'new task (state)': 'new task',
	'Try again (asleep)': 'Try again',
	'from (base)': 'from',
	'Previous (file)': 'Previous',
	'Next (file)': 'Next',
	'Review (verb)': 'Review',
	'Review (noun)': 'Review',
	'failed (check)': 'failed',
	'commented (review)': 'commented',
	'Read the changes (step)': 'Read the changes',
	'Less (summary)': 'Less',
	'Dismiss (marker)': 'Dismiss',
	'Comment (review)': 'Comment',
	'unavailable (machine)': 'unavailable',
	'{n} done (workers)': '{n} done',
	'Merge by hand…': 'Merge…',
	'Side: yours': 'Yours',
	'Side: theirs': 'Theirs',
	'Resolved: merged': 'Merged',
	'Resolved: kept': 'Kept',
	'Resolved: deleted': 'Deleted',
	'review (conflict)': 'review',
	'Result (merge)': 'Result',
	'Pull requests (tab)': 'Pull requests',
	'Draft (column)': 'Draft',
	'Tasks (section)': 'Tasks',
	'Pull requests (section)': 'Pull requests',
	'Settings (rail)': 'Settings',
	'Open (column)': 'Open',
	'In review (column)': 'In review',
	'Closed (column)': 'Closed',
	'Task (link)': 'Task',
	'Ask (notifications)': 'Ask',
	'Allow (notifications)': 'Allow',
	'Block (notifications)': 'Block',
	'«+» under an agent adds a subordinate. Drag an agent onto an agent to add a check.':
		'Drag an agent onto an agent to add a check.',
	'Short one-off jobs: PR summaries, commit and PR texts, branch names, prompt suggestions. Change it for one run where you start it.':
		'Short one-off jobs: PR summaries, commit and PR texts, branch names, prompt suggestions.',
	'Only this review. The foreman merges the findings.': 'Only this review.',
	'The agent reports total context usage without a breakdown.': 'No breakdown.',
	'Sends /compact: the agent summarises the conversation and frees context':
		'Compact the conversation (/compact)',
	'A new {agent} session. It gets the selection, not the answers above.':
		'New {agent} session. Answers above are not passed on.',
	'The changes are lost. You confirm first.': 'The changes are lost.',
	'Last lines · updates every second': 'Last lines',
	'Control this machine from Brigadir on another computer: tasks, terminal, browser and simulator run here.':
		'Control this machine from another computer.',
	'Other devices see this machine by this name. By default, the system name.':
		'Defaults to the system name.',
	'At least 10 characters. Kept only as a hash; devices stay paired. Current connections are dropped, the next one asks for the new password.':
		'At least 10 characters. Current connections will drop.',
	'Who, when and from where: pairing, sign-ins, failed tries (and those refused at TLS), revocation, blocking. File:':
		'File:',
	'Since {time} · {address} · {network}. Agents, terminals, browser and simulator work here; {device} controls them.':
		'Since {time} · {address} · {network}',
	'Double-click or → opens a folder. Path on {machine}:': 'Path on {machine}:',
	'Control Brigadir on another computer from this window. A machine is paired once with a code, and you sign in with the password set on it.':
		'Control Brigadir on another computer.',
	'The agent rereads the PR and leaves comments on the lines. They become drafts of your review: nothing goes to GitHub without you.':
		'The agent’s comments become review drafts.',
	'Resolving by hand is on the computer: the merge strip and the editor are there.':
		'Resolving by hand is on the computer.',
	'{agent} proposes commits from the diff. You can undo.':
		'{agent} proposes commits from the diff.',
	'They replaced your {commits}. Edit them like any other.': 'They replaced your {commits}.',
	'Each file opens for review in the merge view. You can keep resolving the others.':
		'Each file opens for review in the merge view.',
	'Sign in to {agent} to get a summary. The review works without it.':
		'Sign in to {agent} to get a summary.',
	'Could not write the summary: {reason}. The review works without it.':
		'Could not write the summary: {reason}.',
	'Reading {n}… The diff is ready to read meanwhile.': 'Reading {n}…',
	'This PR changes no files, so there is nothing to read or comment on lines. You can still send a verdict or a comment.':
		'This PR changes no files.',
	'The agent’s suggestions will be removed. Your comments stay. You can ask the agent again.':
		'The agent’s suggestions will be removed. Your comments stay.',
	'You are fine with merging. GitHub counts your approval.': 'GitHub counts your approval.',
	'From {n}. Edit freely.': 'From {n}.',
	'Generating needs comments from step 2. Write it yourself or leave it empty.':
		'Generating needs comments from step 2.',
};
/** spec/pull-requests-and-ci#resolve-conflicts: a reason main throws in English is shown translated when it is one of ours. */
export function isMessageKey(value: string): value is MessageKey {
	return Object.hasOwn(uk, value);
}
export function t(locale: Locale, key: MessageKey): string {
	return locale === 'uk' ? uk[key] : (english[key] ?? key);
}
/** spec/appearance#evolution-redesign: «2 changed» above Customize per action; Ukrainian agrees with «дія» in four forms (rule 9). */
export function changedActionCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'змінена', few: 'змінені', many: 'змінених', other: 'зміненої' }
			: { one: 'changed', few: 'changed', many: 'changed', other: 'changed' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/** spec/pull-requests-and-ci#review-launch: «3 lines» of the project review notes; four forms for uk (rule 9). */
export function noteLineCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'рядок', few: 'рядки', many: 'рядків', other: 'рядка' }
			: { one: 'line', few: 'lines', many: 'lines', other: 'lines' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
export function taskCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'задача', few: 'задачі', many: 'задач', other: 'задачі' }
			: { one: 'task', few: 'tasks', many: 'tasks', other: 'tasks' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/** spec/search-menus-and-commands#search-tabs: counts in Search Everywhere — matches, files («у N файлах» as `file-in`), actions and settings; four forms for uk. */
export function searchCount(
	locale: Locale,
	kind: 'match' | 'file' | 'file-in' | 'action' | 'setting',
	count: number
): string {
	const form = new Intl.PluralRules(locale).select(count) as 'one' | 'few' | 'many' | 'other';
	const forms: Record<typeof kind, Record<'one' | 'few' | 'many' | 'other', string>> = locale ===
	'uk'
		? {
				match: { one: 'збіг', few: 'збіги', many: 'збігів', other: 'збігу' },
				file: { one: 'файл', few: 'файли', many: 'файлів', other: 'файлу' },
				'file-in': { one: 'файлі', few: 'файлах', many: 'файлах', other: 'файла' },
				action: { one: 'дія', few: 'дії', many: 'дій', other: 'дії' },
				setting: {
					one: 'налаштування',
					few: 'налаштування',
					many: 'налаштувань',
					other: 'налаштування',
				},
			}
		: {
				match: { one: 'match', few: 'matches', many: 'matches', other: 'matches' },
				file: { one: 'file', few: 'files', many: 'files', other: 'files' },
				'file-in': { one: 'file', few: 'files', many: 'files', other: 'files' },
				action: { one: 'action', few: 'actions', many: 'actions', other: 'actions' },
				setting: { one: 'setting', few: 'settings', many: 'settings', other: 'settings' },
			};
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[kind][form] ?? forms[kind].other}`;
}
/** spec/notifications-slack-notes-and-schedules#schedules: «2 runs missed» — «Пропущено 2 запуски»; four forms for uk (rule 9). */
export function missedRunsText(locale: Locale, count: number): string {
	const n = new Intl.NumberFormat(locale).format(count),
		form = new Intl.PluralRules(locale).select(count);
	if (locale !== 'uk') return `${n} ${count === 1 ? 'run' : 'runs'} missed`;
	const forms: Record<string, string> = {
		one: 'запуск',
		few: 'запуски',
		many: 'запусків',
		other: 'запуску',
	};
	return `Пропущено ${n} ${forms[form] ?? forms.other}`;
}
/** spec/notifications-slack-notes-and-schedules#message-classes: the toast's duplicate counter for screen readers — «2 рази», «5 разів», «21 раз». */
export function timesCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'раз', few: 'рази', many: 'разів', other: 'разу' }
			: { one: 'time', few: 'times', many: 'times', other: 'times' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
export function commandCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'команда', few: 'команди', many: 'команд', other: 'команди' }
			: { one: 'command', few: 'commands', many: 'commands', other: 'commands' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/** A foreman's subordinates in the crew tree — «1 підлеглий», «3 підлеглі», «5 підлеглих» (rule 9: four forms for uk). */
export function subordinateCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'підлеглий', few: 'підлеглі', many: 'підлеглих', other: 'підлеглого' }
			: { one: 'subordinate', few: 'subordinates', many: 'subordinates', other: 'subordinates' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/** spec/chat-turns-plans-and-questions#background-commands: «1 фонова команда», «2 фонові команди», «5 фонових команд», «1,5 фонової команди». */
export function backgroundCommandCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? {
					one: 'фонова команда',
					few: 'фонові команди',
					many: 'фонових команд',
					other: 'фонової команди',
				}
			: {
					one: 'background command',
					few: 'background commands',
					many: 'background commands',
					other: 'background commands',
				};
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/** spec/chat-turns-plans-and-questions#background-subagents: «1 сабагент», «3 сабагенти», «5 сабагентів» (rule 9: four uk forms). */
export function subagentCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'сабагент', few: 'сабагенти', many: 'сабагентів', other: 'сабагента' }
			: { one: 'subagent', few: 'subagents', many: 'subagents', other: 'subagents' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/** spec/chat-turns-plans-and-questions#background-subagents: several items of background work — «2 сабагенти · 1 фонова команда»; one kind alone reads as its count. */
export function backgroundWorkCount(locale: Locale, count: number, subagents = 0): string {
	const commands = count - subagents;
	return [
		...(subagents > 0 ? [subagentCount(locale, subagents)] : []),
		...(commands > 0 || subagents === 0 ? [backgroundCommandCount(locale, commands)] : []),
	].join(' · ');
}
/** spec/chat#tool-groups: the tool group header — «21 виклик», «4 виклики», «5 викликів» (GLOSSARY: «N викликів», rule 9: four uk forms). */
export function toolCallCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'виклик', few: 'виклики', many: 'викликів', other: 'виклику' }
			: { one: 'tool call', few: 'tool calls', many: 'tool calls', other: 'tool calls' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/** spec/chat#tool-groups: failed calls in a tool group — «1 помилка», «2 помилки», «5 помилок». */
export function toolErrorCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'помилка', few: 'помилки', many: 'помилок', other: 'помилки' }
			: { one: 'error', few: 'errors', many: 'errors', other: 'errors' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/**
 * spec/chat#subagents: the tokens a subagent spent, as the adapter reported them — «1 токен», «3 токени», «34k токенів».
 * spec/appearance#evolution-redesign: from 1000 the count is short (`formatTokenCount`); a short count takes the plural of «many».
 */
export function tokenCount(locale: Locale, count: number): string {
	const short = count >= 1000,
		form = short ? 'many' : new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'токен', few: 'токени', many: 'токенів', other: 'токена' }
			: { one: 'token', few: 'tokens', many: 'tokens', other: 'tokens' };
	return `${short ? formatTokenCount(count) : new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/** spec/chat#tool-groups: changed files past the header's chips — «ще 1 файл», «ще 3 файли», «ще 23 файли», «ще 5 файлів». */
export function moreFileCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count),
		number = new Intl.NumberFormat(locale).format(count);
	if (locale !== 'uk') return `${number} more ${count === 1 ? 'file' : 'files'}`;
	const word =
		({ one: 'файл', few: 'файли', many: 'файлів', other: 'файлу' } as Record<string, string>)[
			form
		] ?? 'файлів';
	return `ще ${number} ${word}`;
}

export function commentCount(locale: Locale, count: number): string {
	if (locale === 'en') return `${count} ${count === 1 ? 'comment' : 'comments'}`;
	const form = new Intl.PluralRules('uk').select(count);
	const word =
		{ one: 'коментар', few: 'коментарі', many: 'коментарів', other: 'коментаря' }[
			form as 'one' | 'few' | 'many' | 'other'
		] ?? 'коментаря';
	return `${count} ${word}`;
}

/** spec/remote-access-and-mobile#phone-task-tools: approvals a merge still waits for — «1 схвалення», «3 схвалення», «5 схвалень». */
export function approvalCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'схвалення', few: 'схвалення', many: 'схвалень', other: 'схвалення' }
			: { one: 'approval', few: 'approvals', many: 'approvals', other: 'approvals' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/** spec/remote-access-and-mobile#phone-task-tools: failed checks in the PR header — «1 не пройшла», «2 не пройшли», «5 не пройшли». */
export function failedCheckCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'не пройшла', few: 'не пройшли', many: 'не пройшли', other: 'не пройшли' }
			: { one: 'failed', few: 'failed', many: 'failed', other: 'failed' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}
/** spec/remote-access-and-mobile#phone-task-tools: unresolved threads — «1 невирішений», «2 невирішені», «5 невирішених». */
export function unresolvedCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'невирішений', few: 'невирішені', many: 'невирішених', other: 'невирішеного' }
			: { one: 'unresolved', few: 'unresolved', many: 'unresolved', other: 'unresolved' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[form as keyof typeof forms] ?? forms.other}`;
}

/** Code locations in the references list (spec/editor-code-intelligence#references-and-problems): four `uk` forms. */
export function locationCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const word =
		locale === 'en'
			? count === 1
				? 'location'
				: 'locations'
			: ({ one: 'місце', few: 'місця', many: 'місць', other: 'місця' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'місця');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}
const ukForm = (count: number, forms: { one: string; few: string; many: string; other: string }) =>
	(forms as Record<string, string>)[new Intl.PluralRules('uk').select(count)] ?? forms.many;
/** spec/appearance#evolution-redesign: risky spots of the PR summary — «1 ризикове місце», «2 ризикові місця», «5 ризикових місць». */
export function riskyCount(locale: Locale, count: number): string {
	const number = new Intl.NumberFormat(locale).format(count);
	if (locale === 'en') return `${number} risky ${count === 1 ? 'spot' : 'spots'}`;
	return `${number} ${ukForm(count, { one: 'ризикове місце', few: 'ризикові місця', many: 'ризикових місць', other: 'ризикового місця' })}`;
}
/** spec/appearance#evolution-redesign: commits pushed after the summary — «1 новий коміт», «2 нові коміти», «5 нових комітів». */
export function newCommitCount(locale: Locale, count: number): string {
	const number = new Intl.NumberFormat(locale).format(count);
	if (locale === 'en') return `${number} new ${count === 1 ? 'commit' : 'commits'}`;
	return `${number} ${ukForm(count, { one: 'новий коміт', few: 'нові коміти', many: 'нових комітів', other: 'нового коміту' })}`;
}
/** spec/appearance#evolution-redesign: open review threads — «1 тред», «2 треди», «5 тредів». */
function reviewThreadCount(locale: Locale, count: number): string {
	const number = new Intl.NumberFormat(locale).format(count);
	if (locale === 'en') return `${number} ${count === 1 ? 'thread' : 'threads'}`;
	return `${number} ${ukForm(count, { one: 'тред', few: 'треди', many: 'тредів', other: 'треду' })}`;
}
/** spec/appearance#evolution-redesign: what the agent gets to fix — «2 коментарі й 1 тред», «2 comments and 1 thread». */
export function handedCount(locale: Locale, comments: number, threads: number): string {
	if (!threads) return commentCount(locale, comments);
	if (!comments) return reviewThreadCount(locale, threads);
	return `${commentCount(locale, comments)} ${locale === 'en' ? 'and' : 'й'} ${reviewThreadCount(locale, threads)}`;
}
/** «1 чернетка», «2 чернетки», «5 чернеток» (rule 9: four uk forms). */
export function draftCount(locale: Locale, count: number): string {
	const number = new Intl.NumberFormat(locale).format(count);
	if (locale === 'en') return `${number} draft${count === 1 ? '' : 's'}`;
	const word =
		(
			{ one: 'чернетка', few: 'чернетки', many: 'чернеток', other: 'чернетки' } as Record<
				string,
				string
			>
		)[new Intl.PluralRules('uk').select(count)] ?? 'чернеток';
	return `${number} ${word}`;
}
/** spec/pull-requests-and-ci#pr-panel: the age of a PR in the list — «12 хв», «3 год», «вчора», «3 дні». */
export function prAge(locale: Locale, iso: string, now = Date.now()): string {
	const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000)),
		number = new Intl.NumberFormat(locale);
	if (minutes < 1) return locale === 'en' ? 'now' : 'зараз';
	if (minutes < 60) return locale === 'en' ? `${minutes} min` : `${number.format(minutes)} хв`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return locale === 'en' ? `${hours} h` : `${number.format(hours)} год`;
	const days = Math.floor(hours / 24);
	if (days === 1) return locale === 'en' ? 'yesterday' : 'вчора';
	if (locale === 'en') return `${days} d`;
	const form = new Intl.PluralRules('uk').select(days);
	return `${number.format(days)} ${({ one: 'день', few: 'дні', many: 'днів', other: 'дня' } as Record<string, string>)[form] ?? 'днів'}`;
}
/**
 * spec/pull-requests-and-ci#ready-card: how far a branch is ahead of its base — the card's `3 commits ahead of stage`, the compact list's and the
 * menu's `3 ahead of stage` (`short`). Four forms for uk (rule 9).
 */
export function commitsAhead(locale: Locale, count: number, base: string, short = false): string {
	const number = new Intl.NumberFormat(locale).format(count);
	if (locale === 'en')
		return short
			? `${number} ahead of ${base}`
			: `${number} ${count === 1 ? 'commit' : 'commits'} ahead of ${base}`;
	if (short) return `${number} попереду ${base}`;
	const form = new Intl.PluralRules('uk').select(count);
	const word =
		{ one: 'коміт', few: 'коміти', many: 'комітів', other: 'коміту' }[
			form as 'one' | 'few' | 'many' | 'other'
		] ?? 'коміту';
	return `${number} ${word} попереду ${base}`;
}
/** spec/pull-requests-and-ci#ready-card: when the branch last moved on origin — `pushed 2 min ago`, the time as in a PR row (`prAge`). */
export function pushedAgo(locale: Locale, iso: string, now = Date.now()): string {
	const age = prAge(locale, iso, now);
	if (now - Date.parse(iso) < 60_000) return t(locale, 'pushed just now');
	if (age === prAge(locale, new Date(now - 86_400_000).toISOString(), now))
		return t(locale, 'pushed yesterday');
	return t(locale, 'pushed {time} ago').replace('{time}', age);
}
/** The tooltip of the PR counter in the repo row (spec/pull-requests-and-ci#repo-counter): words only here, the badge has signs and numbers. */
export function prCountTitle(
	locale: Locale,
	open: number,
	closed: number,
	waiting: boolean
): string {
	const number = new Intl.NumberFormat(locale).format,
		uk = (count: number, one: string, few: string, many: string) =>
			(({ one, few, many, other: few }) as Record<string, string>)[
				new Intl.PluralRules('uk').select(count)
			] ?? many;
	const parts =
		locale === 'en'
			? [
					`${open} open PR${open === 1 ? '' : 's'}`,
					`${closed} closed in 7 days`,
					...(waiting ? ['some wait for you'] : []),
				]
			: [
					`${number(open)} ${uk(open, 'відкритий', 'відкриті', 'відкритих')} PR`,
					`${number(closed)} ${uk(closed, 'закритий', 'закриті', 'закритих')} за 7 днів`,
					...(waiting ? ['є ті, що чекають тебе'] : []),
				];
	return parts.join(' · ');
}
/** spec/tasks#backlog-edit: the paperclip on a backlog card — «3 вкладення», «5 вкладень». */
export function attachmentCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const word =
		locale === 'en'
			? count === 1
				? 'attachment'
				: 'attachments'
			: ({ one: 'вкладення', few: 'вкладення', many: 'вкладень', other: 'вкладення' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'вкладення');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}
/** spec/git#main-tree-branches: «3 незакомічені зміни», «5 незакомічених змін». */
export function uncommittedCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const words =
		locale === 'en'
			? count === 1
				? 'uncommitted change'
				: 'uncommitted changes'
			: ({
					one: 'незакомічена зміна',
					few: 'незакомічені зміни',
					many: 'незакомічених змін',
					other: 'незакоміченої зміни',
				}[form as 'one' | 'few' | 'many' | 'other'] ?? 'незакоміченої зміни');
	return `${new Intl.NumberFormat(locale).format(count)} ${words}`;
}
export function fileCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const word =
		locale === 'en'
			? count === 1
				? 'file'
				: 'files'
			: ({ one: 'файл', few: 'файли', many: 'файлів', other: 'файла' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'файла');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}

/** spec/remote-access-and-mobile#client-ui-seam: when a folder of the working machine changed, as the folder browser says it. */
export function folderAge(locale: Locale, at: number | null, now: number = Date.now()): string {
	if (at === null || !Number.isFinite(at)) return '';
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 60)
		return t(locale, '{minutes} min ago').replace('{minutes}', String(Math.max(1, minutes)));
	const day = (value: number) => {
		const date = new Date(value);
		return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	};
	const days = Math.round((day(now) - day(at)) / 86_400_000);
	if (days <= 0) return t(locale, 'today (folder)');
	if (days === 1) return t(locale, 'yesterday (folder)');
	const counted = (
		count: number,
		en: [string, string],
		uk: Record<'one' | 'few' | 'many' | 'other', string>
	) => {
		const form = new Intl.PluralRules(locale).select(count) as 'one' | 'few' | 'many' | 'other';
		return `${new Intl.NumberFormat(locale).format(count)} ${locale === 'en' ? en[count === 1 ? 0 : 1] : (uk[form] ?? uk.other)}`;
	};
	if (days < 7)
		return counted(days, ['day', 'days'], { one: 'день', few: 'дні', many: 'днів', other: 'дня' });
	if (days < 30)
		return counted(Math.floor(days / 7), ['week', 'weeks'], {
			one: 'тиждень',
			few: 'тижні',
			many: 'тижнів',
			other: 'тижня',
		});
	if (days < 60) return t(locale, 'a month (folder)');
	const date = new Date(at);
	return date.getFullYear() === new Date(now).getFullYear()
		? new Intl.DateTimeFormat(locale, { month: 'long' }).format(date)
		: String(date.getFullYear());
}

/** `+3 рядки` after a multi-line command headline (spec/agents-and-providers#mapper-rules). */
export function moreLineCount(locale: Locale, count: number): string {
	if (locale === 'en') return `+${count} ${count === 1 ? 'line' : 'lines'}`;
	const form = new Intl.PluralRules('uk').select(count);
	return `+${count} ${{ one: 'рядок', few: 'рядки', many: 'рядків', other: 'рядка' }[form as 'one' | 'few' | 'many' | 'other'] ?? 'рядка'}`;
}
export function selectedLineCount(locale: Locale, count: number): string {
	if (locale === 'en') return `${count} ${count === 1 ? 'line' : 'lines'} selected`;
	const form = new Intl.PluralRules('uk').select(count);
	const word =
		{ one: 'рядок', few: 'рядки', many: 'рядків', other: 'рядка' }[
			form as 'one' | 'few' | 'many' | 'other'
		] ?? 'рядка';
	return `${count} ${word} виділено`;
}

/** spec/appearance#evolution-redesign: the tail of a quote cut to its first lines — `+4 lines`. */
export function moreLinesCount(locale: Locale, count: number): string {
	if (locale === 'en') return `+${count} ${count === 1 ? 'line' : 'lines'}`;
	const form = new Intl.PluralRules('uk').select(count);
	const word =
		{ one: 'рядок', few: 'рядки', many: 'рядків', other: 'рядка' }[
			form as 'one' | 'few' | 'many' | 'other'
		] ?? 'рядка';
	return `+${count} ${word}`;
}

export function reviewRemovalScope(locale: Locale, files: number, hasNote: boolean): string {
	const form = new Intl.PluralRules('uk').select(files),
		word = { one: 'файлі', few: 'файлах', many: 'файлах', other: 'файла' }[
			form as 'one' | 'few' | 'many' | 'other'
		];
	const scope = files
		? locale === 'uk'
			? ` у ${files} ${word}`
			: ` in ${fileCount(locale, files)}`
		: '';
	return `${scope} ${t(locale, hasNote ? 'will be deleted along with the general note. This cannot be undone.' : 'will be deleted. This cannot be undone.')}`;
}

/** Short relative age for cards and lists (spec/projects-and-board#project-screen RelativeAge): `now`, minutes, hours, days. */
export function relativeAge(
	locale: Locale,
	at: string | undefined,
	now: number = Date.now()
): string {
	if (!at) return '';
	const time = Date.parse(at);
	if (!Number.isFinite(time)) return '';
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	if (seconds < 60) return locale === 'uk' ? 'зараз' : 'now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return locale === 'uk' ? `${minutes} хв` : `${minutes} min`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return locale === 'uk' ? `${hours} год` : `${hours} hr`;
	const days = Math.round(hours / 24);
	return locale === 'uk' ? `${days} дн` : `${days} d`;
}
export function taskCountShort(locale: Locale, count: number): string {
	return taskCount(locale, count);
}

export function scopeCount(locale: Locale, count: number): string {
	const category = new Intl.PluralRules(locale).select(count);
	const forms =
		locale === 'uk'
			? { one: 'repo', few: 'repo', many: 'repo', other: 'repo' }
			: { one: 'repo', few: 'repos', many: 'repos', other: 'repos' };
	return `${new Intl.NumberFormat(locale).format(count)} ${forms[category as keyof typeof forms] ?? forms.other}`;
}

/** «бригадир + N агентів · M рівні» (spec/crew-templates-and-editor#crew-editor header, spec/tasks#sheet-rail popup tail). */
export function crewAgentCountLabel(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const word =
		locale === 'en'
			? count === 1
				? 'agent'
				: 'agents'
			: ({ one: 'агент', few: 'агенти', many: 'агентів', other: 'агента' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'агента');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}
export function crewLevelCountLabel(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const word =
		locale === 'en'
			? count === 1
				? 'level'
				: 'levels'
			: ({ one: 'рівень', few: 'рівні', many: 'рівнів', other: 'рівня' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'рівня');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}

export function commitCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const word =
		locale === 'en'
			? count === 1
				? 'commit'
				: 'commits'
			: ({ one: 'коміт', few: 'коміти', many: 'комітів', other: 'коміту' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'коміту');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}
/** spec/appearance#evolution-redesign: `2 conflicts` / `2 конфлікти`, four uk forms. */
export function conflictCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count) as 'one' | 'few' | 'many' | 'other';
	const word =
		locale === 'en'
			? count === 1
				? 'conflict'
				: 'conflicts'
			: ({ one: 'конфлікт', few: 'конфлікти', many: 'конфліктів', other: 'конфлікту' }[form] ??
				'конфлікти');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}
/** `1 of 5 conflicts` / `1 з 5 конфліктів`: the counter of the merge view (spec/appearance#evolution-redesign). */
export function conflictOf(locale: Locale, current: number, total: number): string {
	const n = new Intl.NumberFormat(locale);
	if (locale === 'en') return `${n.format(current)} of ${conflictCount(locale, total)}`;
	// «з 5 конфліктів»: the genitive plural after «з», «з 1 конфлікту», «з 21 конфлікту».
	const form = new Intl.PluralRules(locale).select(total);
	return `${n.format(current)} з ${n.format(total)} ${form === 'one' ? 'конфлікту' : 'конфліктів'}`;
}
/** `5 conflicts left` / `Лишилось 5 конфліктів`. */
export function conflictsLeftCount(locale: Locale, count: number): string {
	if (locale === 'en') return `${conflictCount(locale, count)} left`;
	const form = new Intl.PluralRules(locale).select(count);
	return `${form === 'one' ? 'Лишився' : 'Лишилось'} ${conflictCount(locale, count)}`;
}
/** `3 changes applied` / `3 changes not applied` (spec/appearance#evolution-redesign). */
export function changesAppliedCount(locale: Locale, count: number, applied: boolean): string {
	const form = new Intl.PluralRules(locale).select(count) as 'one' | 'few' | 'many' | 'other';
	const n = new Intl.NumberFormat(locale).format(count);
	if (locale === 'en')
		return `${n} ${count === 1 ? 'change' : 'changes'} ${applied ? 'applied' : 'not applied'}`;
	const word = { one: 'зміну', few: 'зміни', many: 'змін', other: 'зміни' }[form] ?? 'зміни';
	return applied ? `Застосовано ${n} ${word}` : `Не застосовано ${n} ${word}`;
}
export function conflictPlaceCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const word =
		locale === 'en'
			? count === 1
				? 'place'
				: 'places'
			: ({ one: 'місце', few: 'місця', many: 'місць', other: 'місця' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'місця');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}
/** spec/chat-turns-plans-and-questions#plan-row: `3 частини` / `3 parts`, four uk forms. */
export function planPartCountLabel(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const word =
		locale === 'en'
			? count === 1
				? 'part'
				: 'parts'
			: ({ one: 'частина', few: 'частини', many: 'частин', other: 'частини' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'частини');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}
/** spec/chat-turns-plans-and-questions#plan-row: `3 частини для 3 агентів`; the agent count is genitive in uk. */
export function planSplitLabel(locale: Locale, parts: number, agents: number): string {
	const form = new Intl.PluralRules(locale).select(agents);
	const number = new Intl.NumberFormat(locale).format(agents);
	const word =
		locale === 'en'
			? agents === 1
				? 'agent'
				: 'agents'
			: ({ one: 'агента', few: 'агентів', many: 'агентів', other: 'агента' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'агента');
	return `${planPartCountLabel(locale, parts)} ${locale === 'en' ? 'for' : 'для'} ${number} ${word}`;
}
/** spec/chat-turns-plans-and-questions#plan-approval: `18 рядків` / `18 lines`, four uk forms. */
export function planLinesLabel(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const word =
		locale === 'en'
			? count === 1
				? 'line'
				: 'lines'
			: ({ one: 'рядок', few: 'рядки', many: 'рядків', other: 'рядка' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'рядків');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}

/** spec/task-window-workspace#work-area: the agent's actions on its page, «12 дій» in the bar over it; four forms for uk. */
export function actionCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count);
	const word =
		locale === 'en'
			? count === 1
				? 'action'
				: 'actions'
			: ({ one: 'дія', few: 'дії', many: 'дій', other: 'дії' }[
					form as 'one' | 'few' | 'many' | 'other'
				] ?? 'дії');
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}

/** spec/remote-access-and-mobile#module-and-settings: «12 символів» under the new password. */
export function characterCount(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count) as 'one' | 'few' | 'many' | 'other';
	const word =
		locale === 'uk'
			? { one: 'символ', few: 'символи', many: 'символів', other: 'символу' }[form]
			: count === 1
				? 'character'
				: 'characters';
	return `${new Intl.NumberFormat(locale).format(count)} ${word}`;
}
/** spec/remote-access-and-mobile#module-and-settings: «Код не підійшов. Лишилось 3 спроби.» */
export function pairingAttemptsLeft(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count) as 'one' | 'few' | 'many' | 'other';
	const n = new Intl.NumberFormat(locale).format(count);
	if (locale === 'en')
		return `The code is not correct. ${n} ${count === 1 ? 'attempt is' : 'attempts are'} left.`;
	return {
		one: `Код не підійшов. Лишилась ${n} спроба.`,
		few: `Код не підійшов. Лишилось ${n} спроби.`,
		many: `Код не підійшов. Лишилось ${n} спроб.`,
		other: `Код не підійшов. Лишилось ${n} спроби.`,
	}[form];
}
/** spec/remote-access-and-mobile#module-and-settings: the text of «Revoke all devices?». */
export function revokeAllText(locale: Locale, count: number): string {
	const form = new Intl.PluralRules(locale).select(count) as 'one' | 'few' | 'many' | 'other';
	const n = new Intl.NumberFormat(locale).format(count);
	if (locale === 'en')
		return `${n} ${count === 1 ? 'device' : 'devices'} will not connect until paired again. The log and the machine name stay.`;
	return {
		one: `${n} пристрій більше не підключиться, поки його не спарити знову. Журнал і назва машини лишаються.`,
		few: `${n} пристрої більше не підключаться, поки їх не спарити знову. Журнал і назва машини лишаються.`,
		many: `${n} пристроїв більше не підключаться, поки їх не спарити знову. Журнал і назва машини лишаються.`,
		other: `${n} пристрою більше не підключаться, поки їх не спарити знову. Журнал і назва машини лишаються.`,
	}[form];
}
