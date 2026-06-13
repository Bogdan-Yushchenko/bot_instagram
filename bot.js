require('dotenv').config();
const { chromium } = require('playwright');
const { OpenAI }   = require('openai');
const path = require('path');
const fs   = require('fs');

// ─── Configuration ────────────────────────────────────────────────────────────

const USERNAME          = process.env.IG_USERNAME;
const PASSWORD          = process.env.IG_PASSWORD;
const CHECK_INTERVAL    = parseInt(process.env.CHECK_INTERVAL    || '15000', 10);
const REQUESTS_INTERVAL = parseInt(process.env.REQUESTS_INTERVAL || '120000', 10);
const MAX_RETRIES       = 3;
const OPENAI_TIMEOUT    = 30_000; // 30 seconds
const RETRY_DELAY       = 60_000; // 60 seconds between retries

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const SESSION_FILE  = path.join(__dirname, 'session.json');
const STATE_FILE    = path.join(__dirname, 'bot_state.json');
const PROFILES_FILE = path.join(__dirname, 'user_profiles.json');

const userProfiles = {};

// threadState[href] = {
//   lastUserMsg:    string|null  — user message that already received a reply (DONE)
//   lastBotMsg:     string|null  — bot reply that was actually sent
//   pendingUserMsg: string|null  — user message currently being processed
//   status:         'DONE'|'ERROR'  (PROCESSING is transient — reset to ERROR on restart)
//   retries:        number       — number of failed attempts for pendingUserMsg
//   retryAt:        number|null  — epoch ms after which a retry is allowed
//   greetingSent:   boolean      — true once the greeting message has been sent
// }
const threadState = {};
const sentReplies = new Set(); // known bot reply texts — used for outgoing message detection

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, href, msg) {
  const ts  = new Date().toISOString().slice(11, 23);
  const tag = href ? href.replace('/direct/t/', '').replace(/\/$/, '') : '-';
  console.log(`[${ts}] [${level.padEnd(10)}] [${tag}] ${msg}`);
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  const t = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
  );
  return Promise.race([promise, t]);
}

// ─── State persistence ────────────────────────────────────────────────────────

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    let crashedCount = 0;
    for (const [href, val] of Object.entries(data.threads || {})) {
      if (!val || typeof val !== 'object') continue;
      if (!val.lastUserMsg && !val.pendingUserMsg) continue;

      // Crash recovery: any thread stuck in PROCESSING was interrupted mid-flight —
      // reset to ERROR so it gets retried on the next cycle.
      if (val.status === 'PROCESSING') {
        val.status   = 'ERROR';
        val.retries  = (val.retries || 0) + 1;
        val.retryAt  = Date.now(); // retry immediately
        crashedCount++;
        log('STARTUP', href, `crashed mid-processing → ERROR, retries: ${val.retries}`);
      }

      threadState[href] = val;
      if (val.lastBotMsg) sentReplies.add(val.lastBotMsg);
    }
    (data.replies || []).forEach(r => sentReplies.add(r));

    const total  = Object.keys(threadState).length;
    const errors = Object.values(threadState).filter(s => s.status === 'ERROR').length;
    log('STARTUP', null, `loaded ${total} threads (${errors} ERROR, ${crashedCount} crash-reset), ${sentReplies.size} known replies`);
  } catch {}
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      threads: threadState,
      replies: [...sentReplies].slice(-500),
    }));
  } catch {}
}

function loadProfiles() {
  try {
    const data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    Object.assign(userProfiles, data);
    log('STARTUP', null, `loaded ${Object.keys(userProfiles).length} user profiles`);
  } catch {}
}

function saveProfiles() {
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(userProfiles, null, 2));
  } catch {}
}

// ─── OpenAI reply ─────────────────────────────────────────────────────────────

async function getAIReply(history) {
  if (!openai) { log('ERROR', null, 'OPENAI_API_KEY not set'); return null; }
  const systemPrompt = process.env.OPENAI_SYSTEM_PROMPT ||
    'You are a friendly Instagram assistant. Reply briefly and helpfully. Use one short paragraph, no line breaks.';
  const reply = await withTimeout(
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, ...history],
      max_tokens: 200,
    }),
    OPENAI_TIMEOUT
  );
  return reply.choices[0].message.content.replace(/\n+/g, ' ').trim();
}

// ─── Psychological profile ────────────────────────────────────────────────────

async function updateUserProfile(href, messages, username) {
  if (!openai) return;
  const isBotMsg = (m) => m.isOutgoing || sentReplies.has(m.text);
  const userMsgs = messages.filter(m => !isBotMsg(m));
  if (userMsgs.length === 0) return;

  const conversationText = messages.slice(-40).map(m =>
    `${isBotMsg(m) ? 'Асистент' : 'Користувач'}: ${m.text}`
  ).join('\n');

  const prevProfile = userProfiles[href]?.fullProfile
    ? `\n\nПопередній профіль:\n${userProfiles[href].fullProfile}`
    : '';

  const userLabel = username ? `@${username}` : href;

  try {
    const result = await withTimeout(
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Ти — психологічний аналітик платформи онлайн-терапії. Аналізуй ТІЛЬКИ повідомлення Користувача (не Асистента). Склади структурований психологічний профіль УКРАЇНСЬКОЮ МОВОЮ. Включи розділи: 1) Емоційний стан, 2) Риси особистості, 3) Стиль спілкування, 4) Основні теми та запити, 5) Ймовірні потреби, 6) Рівень ризику (суїцидальні думки / криза: низький / середній / високий). Будь точним і лаконічним (до 250 слів). Це приватні дані лише для власника платформи.',
          },
          {
            role: 'user',
            content: `Instagram користувач: ${userLabel}\n\nРозмова:\n${conversationText}${prevProfile}\n\nОнови психологічний профіль цього користувача.`,
          },
        ],
        max_tokens: 400,
      }),
      OPENAI_TIMEOUT
    );
    const profile = result.choices[0].message.content.trim();
    userProfiles[href] = {
      username:     username || userProfiles[href]?.username || null,
      lastUpdated:  new Date().toISOString(),
      messageCount: userMsgs.length,
      fullProfile:  profile,
    };
    saveProfiles();
    log('PROFILE', href, `updated — @${username || '?'} (${userMsgs.length} user msgs)`);
  } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function dismissNotifPopup(page) {
  try {
    const btn = page.locator('button:has-text("Not Now"), button:has-text("Not now")').first();
    if (await btn.isVisible({ timeout: 1500 })) { await btn.click(); await page.waitForTimeout(500); }
  } catch {}
}

function getUnreadFromTitle(title) {
  const m = title.match(/\((\d+)\)/);
  return m ? parseInt(m[1]) : 0;
}

// Returns chat messages as {text, isOutgoing}.
// Direction is detected by horizontal position: right edge > 80% of viewport = outgoing.
async function getMessages(page) {
  return page.$$eval('span[dir="auto"]', els => {
    const W       = window.innerWidth;
    const OUT_EDGE = W * 0.80;
    return els.map(el => {
      const text = el.textContent?.trim();
      if (!text || text.length <= 2 || text.length > 500) return null;
      const l = text.toLowerCase();
      // Skip UI status labels
      if (l === 'seen' || l === 'delivered' || l === 'sending') return null;
      if (l.startsWith('seen ') || l.startsWith('active ') || l.startsWith('liked ')) return null;
      // Skip timestamps and date separators
      if (/^\d{1,2}:\d{2}(\s*(am|pm))?$/i.test(text)) return null;
      if (/^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(text)) return null;
      if (/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d/i.test(text)) return null;
      const rect = el.getBoundingClientRect();
      return { text, isOutgoing: (rect.x + rect.width) > OUT_EDGE };
    }).filter(Boolean);
  }).catch(() => []);
}

// Extracts the Instagram username of the conversation partner from the thread page.
// Looks for a profile link in the header (/username/), falls back to the page title.
async function getThreadUsername(page) {
  try {
    const username = await page.$$eval('header a[href], [role="main"] a[href]', els => {
      for (const el of els) {
        const href = el.getAttribute('href') || '';
        const m = href.match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
        if (m && !['direct', 'explore', 'reels', 'stories', 'accounts', 'p', 'tv'].includes(m[1])) {
          return m[1];
        }
      }
      return null;
    });
    if (username) return username;
  } catch {}
  // Fallback: page title is often "Username · Direct · Instagram"
  try {
    const m = (await page.title()).match(/^(.+?)\s*[·•·]/);
    if (m && m[1].trim()) return m[1].trim();
  } catch {}
  return null;
}

// Checks whether any leaf text node inside a sidebar item has bold font weight.
// Instagram bolds the preview text of unread conversations.
async function hasUnreadIndicator(item) {
  return item.evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.childElementCount === 0 && node.textContent?.trim()) {
        if (parseInt(window.getComputedStyle(node).fontWeight) >= 700) return true;
      }
      node = walker.nextNode();
    }
    return false;
  }).catch(() => true);
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function login(page, context) {
  log('LOGIN', null, 'logging in to Instagram...');
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  try {
    const btn = page.locator('button:has-text("Allow all cookies"), button:has-text("Decline optional cookies")').first();
    if (await btn.isVisible({ timeout: 4000 })) { await btn.click(); await page.waitForTimeout(1500); }
  } catch {}
  await page.waitForSelector('input[name="username"], input[name="email"]', { timeout: 15000 });
  const u = await page.$('input[name="username"]') ?? await page.$('input[name="email"]');
  const p = await page.$('input[name="password"]') ?? await page.$('input[name="pass"]');
  await u.fill(USERNAME); await p.fill(PASSWORD); await p.press('Enter');
  await page.waitForTimeout(6000);
  await dismissNotifPopup(page);
  await context.storageState({ path: SESSION_FILE });
  log('LOGIN', null, 'logged in, session saved');
}

// ─── Process a single thread ──────────────────────────────────────────────────

async function processThread(page, href) {
  await dismissNotifPopup(page);

  // Accept incoming message request if the Accept button is present
  try {
    const acceptBtn = page.locator('text="Accept"').last();
    if (await acceptBtn.isVisible({ timeout: 1000 })) {
      await acceptBtn.click();
      log('ACCEPT', href, 'request accepted');
      await page.waitForTimeout(2000);
      try {
        const btns = await page.$$eval('button', bs =>
          bs.filter(b => b.offsetParent !== null).map(b => b.textContent?.trim()).filter(Boolean)
        );
        const skip   = ['cancel', 'not now', 'decline', 'block', 'delete', 'report', 'skip'];
        const target = btns.find(t => !skip.some(s => t.toLowerCase().includes(s)));
        if (target) {
          await page.locator(`button:has-text("${target}")`).first().click();
          log('ACCEPT', href, `moved to: "${target}"`);
          await page.waitForTimeout(1500);
        }
      } catch {}
      const ready = await page.locator('div[contenteditable="true"][role="textbox"]').isVisible({ timeout: 5000 }).catch(() => false);
      if (!ready) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); }
    }
  } catch {}

  const messages = await getMessages(page);
  if (!messages.length) return;

  // A message is considered outgoing (bot's) if it's positioned on the right side
  // OR if its text is in our sentReplies set (handles old messages from before this session).
  const isBot = (m) => m.isOutgoing || sentReplies.has(m.text);

  // ── Greeting ──
  // Send once per contact. Check if the greeting text is already visible in the chat
  // before sending to avoid duplicates on restart.
  const greetingMsg = process.env.OPENAI_GREETING_MESSAGE;
  if (greetingMsg && !threadState[href]?.greetingSent) {
    const greetingVisible = messages.some(m => isBot(m) && m.text === greetingMsg);
    if (greetingVisible) {
      // Greeting is already in the chat — just mark it so we don't check again
      threadState[href] = { lastUserMsg: null, pendingUserMsg: null, status: 'DONE', retries: 0, retryAt: null, ...(threadState[href] || {}), greetingSent: true };
      saveState();
      log('GREET', href, 'greeting already in chat — marked');
    } else {
      log('GREET', href, 'sending greeting...');
      try {
        const input = page.locator('div[contenteditable="true"][role="textbox"]').last();
        if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
          await input.click();
          await page.waitForTimeout(300);
          await input.type(greetingMsg, { delay: 20 });
          await page.keyboard.press('Enter');
          sentReplies.add(greetingMsg);
          threadState[href] = {
            lastUserMsg: null, pendingUserMsg: null, status: 'DONE', retries: 0, retryAt: null,
            ...(threadState[href] || {}),
            greetingSent: true,
            lastBotMsg:   greetingMsg,
          };
          saveState();
          log('GREET', href, `"${greetingMsg.substring(0, 80)}"`);
          await page.waitForTimeout(1500);
        }
      } catch (e) {
        log('ERROR', href, `greeting failed: ${e.message}`);
      }
    }
  }

  // Find the most recent message from the user (scan backwards)
  let lastUserMsg = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isBot(messages[i])) { lastUserMsg = messages[i].text; break; }
  }
  if (!lastUserMsg) return;

  const state     = threadState[href] || {};
  const now       = Date.now();
  const isPending = lastUserMsg === state.pendingUserMsg;

  // Already replied to this exact message — nothing to do
  if (lastUserMsg === state.lastUserMsg) return;

  // This message previously failed — check retry limit and backoff timer
  if (isPending) {
    if ((state.retries || 0) >= MAX_RETRIES) {
      log('SKIP', href, `max retries (${MAX_RETRIES}) reached: "${lastUserMsg.substring(0, 50)}"`);
      threadState[href] = { ...state, lastUserMsg, status: 'DONE', pendingUserMsg: null, retries: 0, retryAt: null };
      saveState();
      return;
    }
    if ((state.retryAt || 0) > now) {
      const waitSec = Math.ceil(((state.retryAt || 0) - now) / 1000);
      log('BACKOFF', href, `retry in ${waitSec}s (attempt ${state.retries}/${MAX_RETRIES})`);
      return;
    }
    log('RETRY', href, `attempt ${(state.retries || 0) + 1}/${MAX_RETRIES}: "${lastUserMsg.substring(0, 50)}"`);
  } else {
    log('RECEIVED', href, `new message: "${lastUserMsg.substring(0, 60)}"`);
  }

  // ── PROCESSING ── Mark as in-progress before the async GPT call
  threadState[href] = { ...state, pendingUserMsg: lastUserMsg, status: 'PROCESSING', retries: state.retries || 0 };
  saveState();
  log('PROCESSING', href, 'started');

  // ── GPT request ── Build conversation history from the last 10 messages
  log('GPT_REQ', href, 'sending to OpenAI...');
  const history = messages.slice(-10).map(m => ({
    role:    isBot(m) ? 'assistant' : 'user',
    content: m.text,
  }));

  let reply;
  try {
    reply = await getAIReply(history);
  } catch (e) {
    const retries = (state.retries || 0) + 1;
    threadState[href] = { ...threadState[href], status: 'ERROR', retries, retryAt: now + RETRY_DELAY };
    saveState();
    log('ERROR', href, `OpenAI failed (${e.message}), retries: ${retries}/${MAX_RETRIES}`);
    return;
  }

  if (!reply) {
    const retries = (state.retries || 0) + 1;
    threadState[href] = { ...threadState[href], status: 'ERROR', retries, retryAt: now + RETRY_DELAY };
    saveState();
    log('ERROR', href, `OpenAI returned empty reply, retries: ${retries}/${MAX_RETRIES}`);
    return;
  }

  log('GPT_OK', href, `reply ready: "${reply.substring(0, 60)}"`);

  const safeReply = reply.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // ── Send to Instagram ──
  log('IG_SEND', href, 'typing reply...');
  try {
    const input = page.locator('div[contenteditable="true"][role="textbox"]').last();
    if (!(await input.isVisible({ timeout: 3000 }).catch(() => false))) {
      throw new Error('textbox not visible');
    }
    await input.click();
    await page.waitForTimeout(300);
    await input.type(safeReply, { delay: 20 });
    await page.keyboard.press('Enter');
  } catch (e) {
    const retries = (state.retries || 0) + 1;
    threadState[href] = { ...threadState[href], status: 'ERROR', retries, retryAt: now + RETRY_DELAY };
    saveState();
    log('ERROR', href, `Instagram send failed (${e.message}), retries: ${retries}/${MAX_RETRIES}`);
    return;
  }

  // ── DONE — the message is only marked as processed after a successful send ──
  sentReplies.add(safeReply);
  threadState[href] = {
    ...state,
    lastUserMsg,
    lastBotMsg:     safeReply,
    pendingUserMsg: null,
    status:         'DONE',
    retries:        0,
    retryAt:        null,
  };
  saveState();
  log('DONE', href, `"${lastUserMsg.substring(0, 40)}" → "${safeReply.substring(0, 60)}"`);
  const username = await getThreadUsername(page);
  await updateUserProfile(href, messages, username);
  await page.waitForTimeout(1000);
}

// ─── Inbox check ──────────────────────────────────────────────────────────────

async function checkInbox(page) {
  // Retry ERROR threads first — they need attention regardless of new inbox activity
  const errorThreads = Object.entries(threadState)
    .filter(([, s]) => s.status === 'ERROR' && (s.retryAt || 0) <= Date.now());

  if (errorThreads.length > 0) {
    log('QUEUE', null, `retrying ${errorThreads.length} ERROR thread(s)`);
    for (const [href] of errorThreads) {
      try {
        await page.goto(`https://www.instagram.com${href}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1800);
        if (page.url().includes('/accounts/login')) return { ok: false };
        await processThread(page, href);
      } catch (e) {
        log('ERROR', href, `retry navigation failed: ${e.message}`);
      }
    }
    // Return to inbox before scanning for new messages
    try {
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);
    } catch {}
  }

  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(2500);
  if (page.url().includes('/accounts/login')) return { ok: false };
  await dismissNotifPopup(page);

  const titleUnread = getUnreadFromTitle(await page.title());
  if (titleUnread === 0) return { ok: true, hasHiddenUnread: false };

  // Collect clickable sidebar items and filter to those with unread indicators
  const items = await page.$$('div[tabindex="0"]');
  const candidates = [];
  for (const item of items) {
    try {
      const box = await item.boundingBox();
      if (!box || box.width < 150 || box.x > 500 || box.height < 40) continue;
      const text = (await item.textContent().catch(() => '')).toLowerCase();
      if (text.includes('search') || text.includes('new post') || text.includes('settings')) continue;
      const unread = await hasUnreadIndicator(item);
      candidates.push({ x: box.x + box.width / 2, y: box.y + box.height / 2, unread });
    } catch {}
  }

  const hasAnyUnread = candidates.some(c => c.unread);
  const toClick      = hasAnyUnread ? candidates.filter(c => c.unread) : candidates;

  log('QUEUE', null, `inbox: ${titleUnread} unread, clicking ${toClick.length} thread(s)`);

  for (const pos of toClick) {
    try {
      await page.mouse.click(pos.x, pos.y);
      await page.waitForTimeout(1800);
      const url = page.url();
      if (!url.includes('/direct/t/')) continue;
      const href = new URL(url).pathname;
      log('QUEUED', href, 'opening thread');
      await processThread(page, href);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      await dismissNotifPopup(page);
    } catch {}
  }

  const titleAfter = getUnreadFromTitle(await page.title());
  return { ok: true, hasHiddenUnread: titleAfter > 0 };
}

// ─── Message requests check ───────────────────────────────────────────────────

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
      const cur = page.url();
      if (!cur.includes('/direct/t/')) continue;
      const href = new URL(cur).pathname;
      log('QUEUED', href, 'new request');
      await processThread(page, href);
      processed++;
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    } catch {}
  }
  return processed;
}

async function checkRequests(page) {
  await checkRequestsPage(page, 'https://www.instagram.com/direct/requests/');
  await checkRequestsPage(page, 'https://www.instagram.com/direct/requests/hidden/');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function start() {
  if (!USERNAME || !PASSWORD) { log('ERROR', null, 'missing credentials in .env'); process.exit(1); }
  if (!openai) log('WARN', null, 'OPENAI_API_KEY not set — replies will be skipped');

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(fs.existsSync(SESSION_FILE) ? { storageState: SESSION_FILE } : {}),
  });
  const page = await context.newPage();

  process.on('SIGINT', async () => {
    log('STARTUP', null, 'shutting down...');
    await context.storageState({ path: SESSION_FILE });
    await browser.close();
    process.exit(0);
  });

  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(3000);

  loadState();
  loadProfiles();

  if (page.url().includes('/accounts/login')) {
    await login(page, context);
  } else {
    log('STARTUP', null, 'session valid, skipping login');
  }

  // On startup: visit every known thread once to catch messages that were marked
  // as read by a previous session but never received a reply.
  const knownThreads = Object.keys(threadState);
  if (knownThreads.length > 0) {
    log('STARTUP', null, `scanning ${knownThreads.length} known thread(s) for missed messages...`);
    for (const href of knownThreads) {
      try {
        await page.goto(`https://www.instagram.com${href}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1800);
        if (page.url().includes('/accounts/login')) break;
        await processThread(page, href);
      } catch (e) {
        log('ERROR', href, `startup scan failed: ${e.message}`);
      }
    }
    try {
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);
    } catch {}
    log('STARTUP', null, 'startup scan complete');
  }

  log('STARTUP', null, `bot running — inbox every ${CHECK_INTERVAL / 1000}s, requests every ${REQUESTS_INTERVAL / 1000}s`);

  let lastRequestsCheck = 0;

  while (true) {
    try {
      const result = await checkInbox(page);
      if (result?.ok === false) { log('ERROR', null, 'session expired'); break; }
      const now = Date.now();
      if (result.hasHiddenUnread || (now - lastRequestsCheck) >= REQUESTS_INTERVAL) {
        await checkRequests(page);
        lastRequestsCheck = Date.now();
      }
    } catch (err) {
      if (err.message?.includes('closed') || err.message?.includes('Target')) {
        log('STARTUP', null, 'browser closed'); break;
      }
      log('ERROR', null, err.message);
    }
    try { await page.waitForTimeout(CHECK_INTERVAL); } catch { break; }
  }
}

start().catch(err => { log('ERROR', null, `fatal: ${err.message}`); process.exit(1); });
