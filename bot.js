require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ─── Налаштування ────────────────────────────────────────────────────────────

const USERNAME           = process.env.IG_USERNAME;
const PASSWORD           = process.env.IG_PASSWORD;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '8000', 10);

// Фрази-тригери та відповіді
const RULES = [
  { trigger: 'ціна',  reply: 'Привіт! Ціна — 500грн, пишіть для замовлення 😊' },
  { trigger: 'hello', reply: 'Hey! How can I help you?' },
  { trigger: 'info',  reply: 'Детальніше на нашому сайті: example.com' },
];

const SESSION_FILE = path.join(__dirname, 'session.json');

// Скільки span-ів було в чаті на момент останньої обробки
const threadState = {};

// ─── Допоміжні ───────────────────────────────────────────────────────────────

async function dismissNotifPopup(page) {
  try {
    const btn = page.locator('button:has-text("Not Now"), button:has-text("Not now")').first();
    if (await btn.isVisible({ timeout: 1500 })) {
      await btn.click();
      await page.waitForTimeout(500);
    }
  } catch {}
}

// ─── Логін ───────────────────────────────────────────────────────────────────

async function login(page, context) {
  console.log('Входимо в Instagram...');
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  try {
    const cookieBtn = page.locator('button:has-text("Allow all cookies"), button:has-text("Decline optional cookies")').first();
    if (await cookieBtn.isVisible({ timeout: 4000 })) { await cookieBtn.click(); await page.waitForTimeout(1500); }
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

// ─── Обробка одного чату (вже відкритого) ────────────────────────────────────

async function processThread(page, href) {
  await dismissNotifPopup(page);

  // Прийняти запит на спілкування якщо є кнопка Accept
  try {
    const acceptBtn = page.locator('text="Accept"').last();
    if (await acceptBtn.isVisible({ timeout: 1000 })) {
      await acceptBtn.click();
      console.log('  Прийнято запит на повідомлення');
      await page.waitForTimeout(4000);
      const ready = await page.locator('div[contenteditable="true"][role="textbox"]').isVisible({ timeout: 5000 }).catch(() => false);
      if (!ready) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); }
    }
  } catch {}

  const spans = await page.$$eval('span[dir="auto"]', els =>
    els.map(el => el.textContent?.trim()).filter(t => t && t.length > 1 && t.length < 200)
  ).catch(() => []);
  if (!spans.length) return;

  // Перший раз — дивимось тільки останні 5 повідомлень (уникаємо старих після рестарту)
  const lastCount = threadState[href] ?? Math.max(0, spans.length - 5);

  if (spans.length <= lastCount) return; // нічого нового

  const newSpans = spans.slice(lastCount);
  for (let i = newSpans.length - 1; i >= 0; i--) {
    const msgText   = newSpans[i];
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

  threadState[href] = spans.length; // нових тригерів не знайдено — позначаємо як переглянуті
}

// ─── Перевірка inbox ─────────────────────────────────────────────────────────

async function checkInbox(page) {
  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(2500);
  if (page.url().includes('/accounts/login')) return { ok: false };
  await dismissNotifPopup(page);

  const titleUnread = getUnreadFromTitle(await page.title());

  // Немає непрочитаних — нічого не робимо
  if (titleUnread === 0) return { ok: true, hasHiddenUnread: false };

  // Є непрочитані — кликаємо ВСІ бесіди в inbox (threadState визначить чи є щось нове)
  const items = await page.$$('div[tabindex="0"]');
  const positions = [];
  for (const item of items) {
    try {
      const box  = await item.boundingBox();
      if (!box || box.width < 150 || box.x > 500 || box.height < 40) continue;
      const text = (await item.textContent().catch(() => '')).toLowerCase();
      if (text.includes('search') || text.includes('new post') || text.includes('settings')) continue;
      positions.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    } catch {}
  }

  for (const pos of positions) {
    try {
      await page.mouse.click(pos.x, pos.y);
      await page.waitForTimeout(1500);
      const url = page.url();
      if (!url.includes('/direct/t/')) {
        await page.goto('https://www.instagram.com/direct/inbox/');
        await page.waitForTimeout(2000);
        await dismissNotifPopup(page);
        continue;
      }
      const href = new URL(url).pathname;
      await processThread(page, href);
      await page.goto('https://www.instagram.com/direct/inbox/');
      await page.waitForTimeout(2000);
      await dismissNotifPopup(page);
    } catch {}
  }

  // Якщо в inbox взагалі не знайдено жодної бесіди — непрочитані в requests
  const hasHiddenUnread = positions.length === 0;
  return { ok: true, hasHiddenUnread };
}

// ─── Перевірка запитів (requests + hidden) ───────────────────────────────────

async function checkRequestsPage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(3000);
  if (page.url().includes('/accounts/login')) return 0;

  const items = await page.$$('div[tabindex="0"]');
  let processed = 0;
  for (const item of items) {
    try {
      const box  = await item.boundingBox();
      const text = (await item.textContent().catch(() => '')).toLowerCase();
      if (!box || box.x < 60 || box.width < 150) continue;
      if (text.includes('hidden') || text.includes('delete all') || text.includes('back')) continue;

      await item.click();
      await page.waitForTimeout(2000);
      const currentUrl = page.url();
      if (!currentUrl.includes('/direct/t/')) continue;

      const href = new URL(currentUrl).pathname;
      console.log('  Новий запит — обробляю...');
      await processThread(page, href);
      processed++;

      await page.goto(url);
      await page.waitForTimeout(2500);
    } catch {}
  }
  return processed;
}

// Читає кількість непрочитаних з заголовку вкладки: Instagram пише "(N) Direct • Instagram"
function getUnreadFromTitle(title) {
  const m = title.match(/\((\d+)\)/);
  return m ? parseInt(m[1]) : 0;
}

async function checkRequests(page) {
  const n = await checkRequestsPage(page, 'https://www.instagram.com/direct/requests/');
  const h = await checkRequestsPage(page, 'https://www.instagram.com/direct/requests/hidden/');
  if ((n + h) === 0) return false; // нічого не знайдено
  return true;
}

// ─── Головна функція ─────────────────────────────────────────────────────────

async function start() {
  if (!USERNAME || !PASSWORD) {
    console.error('Немає IG_USERNAME або IG_PASSWORD у .env'); process.exit(1);
  }

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(fs.existsSync(SESSION_FILE) ? { storageState: SESSION_FILE } : {}),
  });
  const page = await context.newPage();

  process.on('SIGINT', async () => {
    console.log('\nЗупиняємо бота...');
    await context.storageState({ path: SESSION_FILE });
    await browser.close();
    process.exit(0);
  });

  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(3000);

  if (page.url().includes('/accounts/login')) {
    await login(page, context);
  } else {
    console.log('Сесія актуальна — вхід не потрібен!');
  }

  console.log(`Бот запущений! Перевірка inbox кожні ${CHECK_INTERVAL / 1000}с, requests — тільки при сигналі`);

  while (true) {
    try {
      // Перевіряємо непрочитані повідомлення в inbox
      const result = await checkInbox(page);
      if (result === false || result?.ok === false) {
        console.log('Сесія закінчилась — перезапусти бота.');
        break;
      }

      // Перевіряємо requests ТІЛЬКИ якщо заголовок вкладки показує (N) непрочитаних
      // але в inbox нічого не знайдено — це сигнал що є запит від незнайомця
      if (result.hasHiddenUnread) {
        await checkRequests(page);
      }
    } catch (err) {
      if (err.message.includes('closed') || err.message.includes('Target')) {
        console.log('\nБраузер закрито — зупиняємо бота.');
        break;
      }
      console.error('Помилка:', err.message);
    }

    try {
      await page.waitForTimeout(CHECK_INTERVAL);
    } catch {
      break;
    }
  }
}

start().catch(err => {
  console.error('Критична помилка:', err.message);
  process.exit(1);
});
