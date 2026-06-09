require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ─── Налаштування ────────────────────────────────────────────────────────────

const USERNAME          = process.env.IG_USERNAME;
const PASSWORD          = process.env.IG_PASSWORD;
const CHECK_INTERVAL    = parseInt(process.env.CHECK_INTERVAL    || '8000',  10); // ms між перевірками
const DISCOVERY_INTERVAL= parseInt(process.env.DISCOVERY_INTERVAL|| '60000', 10); // ms між пошуком нових чатів

// Фрази-тригери та відповіді на них
const RULES = [
  { trigger: 'ціна',  reply: 'Привіт! Ціна — 500грн, пишіть для замовлення 😊' },
  { trigger: 'hello', reply: 'Hey! How can I help you?' },
  { trigger: 'info',  reply: 'Детальніше на нашому сайті: example.com' },
];

const SESSION_FILE = path.join(__dirname, 'session.json');

// Кеш відомих чатів і кількість повідомлень на момент останньої перевірки
const knownThreads = new Set(); // pathname-посилання, наприклад /direct/t/12345/
const threadState  = {};        // href → кількість span-ів при останній перевірці

// ─── Допоміжні функції ───────────────────────────────────────────────────────

// Закриває попап «Turn on Notifications» якщо він з'явився
async function dismissNotifPopup(page) {
  try {
    const btn = page.locator('button:has-text("Not Now"), button:has-text("Not now")').first();
    if (await btn.isVisible({ timeout: 1500 })) {
      await btn.click();
      await page.waitForTimeout(500);
    }
  } catch {}
}

// ─── Логін (тільки якщо session.json не існує) ───────────────────────────────

async function login(page, context) {
  console.log('Входимо в Instagram...');
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Закрити попап куків якщо є
  try {
    const cookieBtn = page.locator('button:has-text("Allow all cookies"), button:has-text("Decline optional cookies")').first();
    if (await cookieBtn.isVisible({ timeout: 4000 })) {
      await cookieBtn.click();
      await page.waitForTimeout(1500);
    }
  } catch {}

  await page.waitForSelector('input[name="username"], input[name="email"]', { timeout: 15000 });
  const userInput = await page.$('input[name="username"]') ?? await page.$('input[name="email"]');
  const passInput = await page.$('input[name="password"]') ?? await page.$('input[name="pass"]');

  await userInput.fill(USERNAME);
  await passInput.fill(PASSWORD);
  await passInput.press('Enter');
  await page.waitForTimeout(6000);

  await dismissNotifPopup(page);
  await context.storageState({ path: SESSION_FILE });
  console.log('Увійшли! Сесія збережена.');
}

// ─── Пошук нових чатів ───────────────────────────────────────────────────────

// Сканує сайдбар inbox-у: клікає по кожній бесіді та запам'ятовує URL
// Instagram рендерить бесіди як div[tabindex="0"], не як <a> теги
async function discoverInbox(page) {
  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(3000);

  if (page.url().includes('/accounts/login')) return false; // сесія прострочена

  await dismissNotifPopup(page);

  // Збираємо координати елементів ДО кліків (уникаємо stale handles після SPA-навігації)
  const items = await page.$$('div[tabindex="0"]');
  const positions = [];
  for (const item of items) {
    try {
      const box  = await item.boundingBox();
      const text = (await item.textContent().catch(() => '')).toLowerCase();
      // Беремо тільки широкі елементи в лівій панелі — це картки бесід
      if (!box || box.width < 150 || box.x > 500 || box.height < 40) continue;
      if (text.includes('search') || text.includes('new post') || text.includes('settings')) continue;
      positions.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    } catch {}
  }

  // Клікаємо кожну бесіду по координатах — сторінка залишається як SPA, назад не потрібно
  for (const pos of positions) {
    try {
      await page.mouse.click(pos.x, pos.y);
      await page.waitForTimeout(1200);
      const url = page.url();
      if (url.includes('/direct/t/')) {
        knownThreads.add(new URL(url).pathname);
      }
    } catch {}
  }

  return true;
}

// Сканує сторінку запитів (від незнайомих людей)
async function discoverRequests(page) {
  try {
    await page.goto('https://www.instagram.com/direct/requests/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(3000);

  if (page.url().includes('/accounts/login')) return;

  const items = await page.$$('div[tabindex="0"]');
  for (const item of items) {
    try {
      const box  = await item.boundingBox();
      const text = (await item.textContent().catch(() => '')).toLowerCase();
      if (!box || box.x < 60 || box.width < 150) continue;
      if (text.includes('hidden') || text.includes('delete all')) continue;

      await item.click();
      await page.waitForTimeout(2000);
      const url = page.url();
      if (url.includes('/direct/t/')) {
        knownThreads.add(new URL(url).pathname);
      }
      // На сторінці запитів SPA не зберігається — повертаємось назад
      await page.goto('https://www.instagram.com/direct/requests/');
      await page.waitForTimeout(2500);
    } catch {}
  }
}

// ─── Перевірка одного чату ────────────────────────────────────────────────────

async function checkThread(page, href) {
  try {
    await page.goto(`https://www.instagram.com${href}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(2000);
  await dismissNotifPopup(page);

  // Якщо це запит на спілкування — приймаємо
  try {
    const acceptBtn = page.locator('text="Accept"').last();
    if (await acceptBtn.isVisible({ timeout: 1000 })) {
      await acceptBtn.click();
      console.log('Прийнято запит на повідомлення');
      await page.waitForTimeout(4000);
      // Якщо поле вводу ще не з'явилось — перезавантажуємо
      const inputReady = await page.locator('div[contenteditable="true"][role="textbox"]').isVisible({ timeout: 5000 }).catch(() => false);
      if (!inputReady) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
      }
    }
  } catch {}

  // Збираємо всі текстові повідомлення зі сторінки
  const spans = await page.$$eval('span[dir="auto"]', els =>
    els.map(el => el.textContent?.trim()).filter(t => t && t.length > 1 && t.length < 200)
  ).catch(() => []);

  if (!spans.length) return;

  // Перший раз бачимо цей чат — запам'ятовуємо поточну кількість і виходимо
  // (щоб не відповідати на старі повідомлення після перезапуску бота)
  if (!(href in threadState)) {
    threadState[href] = spans.length;
    return;
  }

  const lastCount = threadState[href];
  if (spans.length <= lastCount) return; // нових повідомлень нема

  // Перевіряємо тільки нові повідомлення (від lastCount до кінця), з найновіших
  const newSpans = spans.slice(lastCount);
  for (let i = newSpans.length - 1; i >= 0; i--) {
    const msgText  = newSpans[i];
    const textLower = msgText.toLowerCase();

    for (const rule of RULES) {
      if (textLower.includes(rule.trigger.toLowerCase())) {
        const input = page.locator('div[contenteditable="true"][role="textbox"]').last();
        if (!(await input.isVisible({ timeout: 3000 }).catch(() => false))) return;

        await input.click();
        await page.waitForTimeout(300);
        await input.type(rule.reply, { delay: 20 });
        await page.keyboard.press('Enter');

        threadState[href] = spans.length;
        console.log(`Відповів: "${msgText}" -> "${rule.reply}"`);
        await page.waitForTimeout(1000);
        return; // одна відповідь за цикл
      }
    }
  }

  // Тригерів не знайдено — позначаємо повідомлення як переглянуті
  threadState[href] = spans.length;
}

// ─── Головна функція ─────────────────────────────────────────────────────────

async function start() {
  if (!USERNAME || !PASSWORD) {
    console.error('Немає IG_USERNAME або IG_PASSWORD у .env');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(fs.existsSync(SESSION_FILE) ? { storageState: SESSION_FILE } : {}),
  });
  const page = await context.newPage();

  // Зберігаємо сесію при закритті (Ctrl+C)
  process.on('SIGINT', async () => {
    console.log('\nЗупиняємо бота...');
    await context.storageState({ path: SESSION_FILE });
    await browser.close();
    process.exit(0);
  });

  // Перевіряємо чи сесія ще дійсна
  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(3000);

  if (page.url().includes('/accounts/login')) {
    await login(page, context);
  } else {
    console.log('Сесія актуальна — вхід не потрібен!');
  }

  console.log(`Бот запущений! Перевірка кожні ${CHECK_INTERVAL / 1000}с, пошук нових чатів кожні ${DISCOVERY_INTERVAL / 1000}с`);

  let lastDiscoveryTime = 0;

  // Основний цикл — while замість setInterval щоб цикли не перетинались
  while (true) {
    // Шукаємо нові чати раз на DISCOVERY_INTERVAL
    if (Date.now() - lastDiscoveryTime >= DISCOVERY_INTERVAL) {
      process.stdout.write('Сканую чати...');
      const ok = await discoverInbox(page);
      if (ok === false) {
        console.log('\nСесія закінчилась — перезапусти бота.');
        break;
      }
      await discoverRequests(page);
      lastDiscoveryTime = Date.now();
      console.log(` знайдено: ${knownThreads.size}`);
    }

    // Перевіряємо кожен відомий чат
    for (const href of [...knownThreads]) {
      await checkThread(page, href);
    }

    await page.waitForTimeout(CHECK_INTERVAL);
  }
}

start().catch(err => {
  console.error('Критична помилка:', err.message);
  process.exit(1);
});
