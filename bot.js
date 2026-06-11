require('dotenv').config();
const { chromium } = require('playwright');
const { OpenAI }   = require('openai');
const path = require('path');
const fs   = require('fs');

// ─── Налаштування ────────────────────────────────────────────────────────────

const USERNAME       = process.env.IG_USERNAME;
const PASSWORD       = process.env.IG_PASSWORD;
const CHECK_INTERVAL    = parseInt(process.env.CHECK_INTERVAL    || '15000', 10);
const REQUESTS_INTERVAL = parseInt(process.env.REQUESTS_INTERVAL || '120000', 10); // 2 хв

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const SESSION_FILE = path.join(__dirname, 'session.json');
const STATE_FILE   = path.join(__dirname, 'bot_state.json');

const lastReplied = {}; // href → текст ОСТАННЬОЇ відповіді бота в цьому чаті
const sentReplies  = new Set(); // всі відправлені ботом тексти (для контексту GPT)

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(lastReplied, data.lastReplied || {});
    (data.replies || []).forEach(r => sentReplies.add(r));
    console.log(`Стан завантажено: ${Object.keys(lastReplied).length} чатів`);
  } catch {}
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastReplied,
      replies: [...sentReplies].slice(-500),
    }));
  } catch {}
}

// ─── GPT ─────────────────────────────────────────────────────────────────────

async function getAIReply(conversationHistory) {
  if (!openai) {
    console.error('OPENAI_API_KEY не встановлено в .env!');
    return null;
  }
  const systemPrompt = process.env.OPENAI_SYSTEM_PROMPT ||
    'Ти — менеджер Instagram акаунту. Відповідай клієнтам коротко, дружньо та по суті. Не пиши зайвого.';
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
      ],
      max_tokens: 300,
    });
    return response.choices[0].message.content.trim();
  } catch (e) {
    console.error('GPT помилка:', e.message);
    return null;
  }
}

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
      await page.waitForTimeout(2000);

      // Instagram може показати діалог "куди перемістити переписку"
      try {
        await page.waitForTimeout(1000);
        // Логуємо всі кнопки що з'явились — щоб знати точний текст
        const btns = await page.$$eval('button', bs =>
          bs.filter(b => b.offsetParent !== null).map(b => b.textContent?.trim()).filter(Boolean)
        );
        console.log('  Кнопки на сторінці:', btns.join(' | '));

        // Пробуємо натиснути "Primary" або першу кнопку що не є скасуванням
        const skip = ['cancel', 'not now', 'decline', 'block', 'delete', 'report', 'skip'];
        const target = btns.find(t => !skip.some(s => t.toLowerCase().includes(s)));
        if (target) {
          await page.locator(`button:has-text("${target}")`).first().click();
          console.log(`  Вибрано: "${target}"`);
          await page.waitForTimeout(1500);
        }
      } catch {}

      const ready = await page.locator('div[contenteditable="true"][role="textbox"]').isVisible({ timeout: 5000 }).catch(() => false);
      if (!ready) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); }
    }
  } catch {}

  const spans = await page.$$eval('span[dir="auto"]', els =>
    els.map(el => el.textContent?.trim()).filter(t => {
      if (!t || t.length <= 2 || t.length > 500) return false;
      const l = t.toLowerCase();
      // Ігноруємо системні тексти Instagram
      if (l === 'seen' || l === 'delivered' || l === 'sending') return false;
      if (l.startsWith('seen ') || l.startsWith('active ') || l.startsWith('liked ')) return false;
      return true;
    })
  ).catch(() => []);
  if (!spans.length) return;

  // Знаходимо з якого місця читати — відразу після останньої відповіді бота
  const myLastReply = lastReplied[href];
  if (myLastReply === undefined) {
    // Перший візит: запам'ятовуємо поточний стан і нічого не робимо
    // (щоб не відповідати на старі або власні повідомлення)
    lastReplied[href] = spans[spans.length - 1] ?? '';
    saveState();
    return;
  }

  const replyIdx = spans.lastIndexOf(myLastReply);
  const startIdx = replyIdx >= 0 ? replyIdx + 1 : spans.length; // якщо не знайдено — пропускаємо все

  if (startIdx >= spans.length) return; // нічого нового після нашої відповіді

  const newUserSpans = spans.slice(startIdx);
  const lastUserMsg  = newUserSpans[newUserSpans.length - 1];

  // Формуємо контекст для GPT: кілька повідомлень до нашої відповіді + нові від користувача
  const ctxBefore = spans.slice(Math.max(0, startIdx - 6), startIdx).map(s => ({
    role: sentReplies.has(s) || s === myLastReply ? 'assistant' : 'user',
    content: s,
  }));
  const ctxNew = newUserSpans.map(s => ({ role: 'user', content: s }));
  const history = [...ctxBefore, ...ctxNew];

  const reply = await getAIReply(history);
  if (!reply) return;

  const input = page.locator('div[contenteditable="true"][role="textbox"]').last();
  if (!(await input.isVisible({ timeout: 3000 }).catch(() => false))) return;
  await input.click();
  await page.waitForTimeout(300);
  await input.type(reply, { delay: 20 });
  await page.keyboard.press('Enter');

  sentReplies.add(reply);
  lastReplied[href] = reply;
  saveState();
  console.log(`GPT: "${lastUserMsg.substring(0, 40)}" → "${reply.substring(0, 60)}"`);
  await page.waitForTimeout(1000);
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
  if (titleUnread === 0) return { ok: true, hasHiddenUnread: false };

  // Є непрочитані — кликаємо всі бесіди в inbox
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
      await page.waitForTimeout(1800);
      const url = page.url();
      if (!url.includes('/direct/t/')) continue;
      const href = new URL(url).pathname;
      await processThread(page, href);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await dismissNotifPopup(page);
    } catch {}
  }

  // Перечитуємо title після обходу inbox — якщо ще показує (N), залишок у requests
  const titleAfter = getUnreadFromTitle(await page.title());
  const hasHiddenUnread = titleAfter > 0;
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

      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    } catch {}
  }
  return processed;
}

function getUnreadFromTitle(title) {
  const m = title.match(/\((\d+)\)/);
  return m ? parseInt(m[1]) : 0;
}

async function checkRequests(page) {
  const n = await checkRequestsPage(page, 'https://www.instagram.com/direct/requests/');
  const h = await checkRequestsPage(page, 'https://www.instagram.com/direct/requests/hidden/');
  return (n + h) > 0;
}

// ─── Головна функція ─────────────────────────────────────────────────────────

async function start() {
  if (!USERNAME || !PASSWORD) {
    console.error('Немає IG_USERNAME або IG_PASSWORD у .env'); process.exit(1);
  }
  if (!openai) {
    console.warn('⚠  OPENAI_API_KEY не встановлено — бот не зможе відповідати!');
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

  loadState();

  if (page.url().includes('/accounts/login')) {
    await login(page, context);
  } else {
    console.log('Сесія актуальна — вхід не потрібен!');
  }

  console.log(`Бот запущений! Inbox кожні ${CHECK_INTERVAL / 1000}с, requests кожні ${REQUESTS_INTERVAL / 1000}с`);

  let lastRequestsCheck = 0;

  while (true) {
    try {
      const result = await checkInbox(page);
      if (result === false || result?.ok === false) {
        console.log('Сесія закінчилась — перезапусти бота.');
        break;
      }

      const now = Date.now();
      if (result.hasHiddenUnread || (now - lastRequestsCheck) >= REQUESTS_INTERVAL) {
        await checkRequests(page);
        lastRequestsCheck = Date.now();
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
