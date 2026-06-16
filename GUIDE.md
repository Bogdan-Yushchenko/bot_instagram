# Гайд: Instagram-бот на Playwright + TypeScript

## Что делает этот бот

- Сканирует комментарии под постами каждые 60 секунд
- При нахождении ключевого слова — отвечает прямо под публикацией
- Сканирует входящие ЛС каждые 8 секунд, отвечает по ключевым словам
- Автоматически публикует «инструкцию» под каждым постом и обновляет её при изменении
- Хранит историю ответов чтобы не спамить одному пользователю дважды

---

## Стек технологий

| Инструмент | Зачем | Документация |
|---|---|---|
| **Node.js 22+** | Среда выполнения | https://nodejs.org/docs/latest/ |
| **TypeScript** | Типизированный JavaScript | https://www.typescriptlang.org/docs/ |
| **Playwright** | Управление браузером (Chromium) | https://playwright.dev/docs/intro |
| **tsx** | Запуск TS без компиляции + hot-reload | https://tsx.is |
| **PostgreSQL** | База данных для лидов и сценариев | https://www.postgresql.org/docs/ |
| **Prisma ORM** | Работа с БД из TypeScript | https://www.prisma.io/docs/ |
| **Docker** | Запуск PostgreSQL в контейнере | https://docs.docker.com/get-started/ |
| **Winston** | Логирование | https://github.com/winstonjs/winston |
| **dotenv** | Переменные окружения | https://github.com/motdotla/dotenv |

---

## Архитектура

```
src/
├── server.ts          # Точка входа: запускает Express + Poller
├── config/index.ts    # Конфиг из .env (валидация через zod)
├── instagram/
│   ├── client.ts      # Playwright: браузер, навигация, действия
│   └── Poller.ts      # Циклы опроса DM и постов
├── bot/
│   ├── BotService.ts          # Обработка входящих DM
│   ├── PostKeywordResponder.ts # Матчинг ключевых слов
│   ├── CommentLeadsTracker.ts  # Дедупликация ответов
│   ├── ScenarioEngine.ts       # Многошаговые сценарии продаж
│   └── data/
│       └── post_keywords.json  # Ключевые слова и ответы
├── leads/LeadService.ts        # CRUD лидов в БД
└── scenarios/                  # JSON-конфиги сценариев
```

### Поток данных

```
Instagram (браузер)
    │
    ▼
Playwright Client (client.ts)
    │  scanInbox() / scanRequests() / getRecentPostHrefs()
    ▼
Poller.ts
    ├─► [DM с ключевым словом] ──► sendDmToUser()
    ├─► [DM с триггером] ──────► BotService → ScenarioEngine
    └─► [Комментарий с ключевым словом] ──► replyToComment()
```

---

## Как работает авторизация в Instagram

Бот **не использует официальный API** — он управляет браузером как реальный пользователь.

### Получение сессии (session.json)

1. Войди в Instagram в браузере Chromium через Playwright в режиме `headless: false`
2. Вручную пройди логин (включая 2FA если есть)
3. Сохрани cookies через `context.storageState()` в файл `session.json`
4. Этот файл — замена пароля. **Храни его только локально, никогда не коммить в git**

```typescript
// Пример получения сессии
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('https://www.instagram.com/');
// Войди вручную в открывшемся окне
await page.pause(); // ждёт пока ты не нажмёшь Continue в инспекторе
await context.storageState({ path: 'session.json' });
await browser.close();
```

### Загрузка сессии при старте

```typescript
const { cookies } = JSON.parse(fs.readFileSync('session.json', 'utf-8'));
const context = await browser.newContext({
  storageState: { cookies, origins: [] },
  userAgent: 'Mozilla/5.0 ...', // обязательно реальный UA
});
```

---

## Безопасность и анти-бан

### Главные правила

| Риск | Защита |
|---|---|
| Детектирование по скорости | Задержки `waitForTimeout(300–3000ms)` между действиями |
| Детектирование по headless-браузеру | Реальный `userAgent` Chrome, viewport 1280×800 |
| Слишком много запросов | Интервалы: 8 секунд DM, 60 секунд посты |
| Одинаковые сообщения всем | Не делать — Instagram банит за спам |
| Повторные ответы одному пользователю | `comment_leads.json` — дедупликация по `username:keyword` |
| Хранение пароля | Используем только `session.json` (cookies), пароль нигде не хранится |
| Компрометация сессии | `.gitignore` содержит `session.json` |

### Что НЕ делать

- Не писать одинаковый текст более чем 5–10 раз за час — это триггер бана
- Не запускать бота с нескольких IP одновременно для одного аккаунта
- Не делать слишком много действий сразу после входа — «прогревай» аккаунт
- Не использовать основной аккаунт для тестирования — заведи отдельный

### Задержки (текущие в боте)

```typescript
// После навигации на страницу
await page.waitForTimeout(3_000);

// Между hover и click
await page.waitForTimeout(600);

// После отправки комментария
await page.waitForTimeout(2_000);
```

---

## Политика Instagram

**Важно:** Автоматизация Instagram нарушает их [Terms of Use](https://help.instagram.com/581066165581870). Использование такого бота — на твой страх и риск.

- Официальный API для бизнеса: https://developers.facebook.com/docs/instagram-platform
- Разрешённый API ограничен: только бизнес-аккаунты, только Messaging API
- Playwright-автоматизация — это «серая зона», популярная для тестирования и небольших нагрузок

**Рекомендации:**
- Используй отдельный Instagram-аккаунт для бота
- Держи активность в пределах «человеческих» норм (не более ~50 действий в час)
- При бане аккаунт может быть восстановлен через апелляцию

---

## Настройка с нуля

### 1. Требования

- Node.js 22+ → https://nodejs.org/en/download/
- Docker Desktop → https://www.docker.com/products/docker-desktop/
- Git → https://git-scm.com/downloads

### 2. Клонирование и установка

```bash
git clone <твой-репозиторий>
cd bot_post
npm install
npx playwright install chromium
```

### 3. Конфигурация `.env`

```env
# Instagram
IG_USERNAME=твой_логин
IG_PASSWORD=твой_пароль
IG_WEB_COOKIES_FILE=session.json

# База данных
DATABASE_URL="postgresql://botuser:botpassword@localhost:5433/botdb"

# OpenAI (если используешь классификацию)
OPENAI_API_KEY=sk-...

# Сервер
PORT=3000
NODE_ENV=development
```

### 4. Запуск базы данных

```bash
docker-compose up -d
npx prisma migrate dev
npx prisma generate
```

### 5. Получение сессии Instagram

```bash
npx tsx get_session.mts   # запустит браузер — войди вручную
```

### 6. Запуск бота (dev)

```bash
npm run dev   # tsx watch src/server.ts
```

### 7. Запуск бота (production)

```bash
npm run build   # компиляция TypeScript
npm start       # node dist/server.js
```

---

## Ключевые слова (`post_keywords.json`)

```json
{
  "keywords": [
    {
      "trigger": "гайд",
      "reply": "📚 Текст ответа на ключевое слово"
    }
  ],
  "defaultReply": "Текст инструкции, которая публикуется под каждым постом"
}
```

- `trigger` — подстрока (регистронезависимая), которую бот ищет в комментариях и ЛС
- `reply` — ответ, который бот публикует/отправляет
- `defaultReply` — инструкция, автоматически размещаемая под каждым новым постом

---

## Файлы состояния (не коммить в git)

| Файл | Содержимое |
|---|---|
| `session.json` | Cookies авторизации Instagram |
| `commented_posts.json` | Какой текст бот написал под каким постом (для обновления) |
| `comment_leads.json` | Кому и на какое слово уже ответил (дедупликация) |

---

## Расширение бота

### Добавить ключевое слово

Открой `src/bot/data/post_keywords.json` и добавь в массив `keywords`:
```json
{ "trigger": "новое_слово", "reply": "Ответ на это слово" }
```
Не забудь добавить новое слово в `defaultReply` чтобы инструкция под постом обновилась.

### Добавить сценарий продаж (многошаговый)

Создай JSON-файл в `src/scenarios/` по образцу `saas_pitch.json`.
Добавь триггерные слова в поле `triggers` — бот начнёт сценарий когда получит такое слово в ЛС.

### Изменить интервалы опроса

В `src/instagram/Poller.ts`:
```typescript
const DM_POLL_MS   = 8_000;   // каждые 8 секунд
const POST_POLL_MS = 60_000;  // каждую минуту
```

---

## Мониторинг

Бот логирует всё через Winston. Уровни:
- `info` — нормальная работа (найден комментарий, отправлен ответ)
- `warn` — не критично (кнопка не найдена, fallback)
- `error` — ошибка опроса (навигация упала, таймаут)
- `debug` — детали (нет триггера в ЛС)

Запуск с выводом в файл:
```bash
npm run dev 2>&1 | tee bot_output.txt
```

Health check endpoint: `GET http://localhost:3000/health`
