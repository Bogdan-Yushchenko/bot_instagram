import { Browser, BrowserContext, chromium, Page } from 'playwright';
import * as fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';

const IG_ROOT = 'https://www.instagram.com';

export interface ScrapedMessage {
  hash: string;
  text: string;
  isOutgoing: boolean;
}

export interface InboxThread {
  href: string;
  username: string;
  messages: ScrapedMessage[];
}

export interface PostComment {
  hash: string;       // stable ID: username + text slice
  postHref: string;   // e.g. /p/ABC123/
  username: string;
  text: string;
}

export class InstagramClient {
  private browser!: Browser;
  private context!: BrowserContext;
  private dmPage!: Page;   // used exclusively for DM inbox scanning + sending
  private postPage!: Page; // used exclusively for post comment scanning + posting

  // username → thread href, populated during inbox scan
  private readonly hrefByUsername = new Map<string, string>();

  // Convenience getter — DM operations use this page
  private get page(): Page { return this.dmPage; }

  async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });

    const cookiesPath = config.IG_WEB_COOKIES_FILE ?? 'session.json';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { cookies } = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8')) as { cookies: any[] };

    this.context = await this.browser.newContext({
      storageState: { cookies, origins: [] },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    // DM page
    this.dmPage = await this.context.newPage();
    await this.dmPage.goto(`${IG_ROOT}/direct/inbox/`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    await this.dmPage.waitForTimeout(2_000);

    if (this.dmPage.url().includes('/accounts/login')) {
      throw new Error(
        'Instagram session expired — copy a fresh session.json from bot_direct',
      );
    }

    // Separate page for post operations so DM polling doesn't interfere
    this.postPage = await this.context.newPage();

    logger.info('Playwright client launched', { username: config.IG_USERNAME });
  }

  getSelfUsername(): string {
    return config.IG_USERNAME;
  }

  // ── Inbox scan ──────────────────────────────────────────────────────────────

  async scanInbox(): Promise<InboxThread[]> {
    await this.navigateTo(`${IG_ROOT}/direct/inbox/`);
    await this.page.waitForTimeout(1_500);

    const hrefs = await this.page.$$eval(
      'a[href*="/direct/t/"]',
      els => [...new Set(els.map(el => el.getAttribute('href') ?? '').filter(Boolean))],
    );

    const threads: InboxThread[] = [];
    for (const href of hrefs) {
      const thread = await this.scrapeThread(href);
      if (thread) threads.push(thread);
    }

    return threads;
  }

  // Also scan pending message requests (users who don't follow the bot)
  async scanRequests(): Promise<InboxThread[]> {
    await this.navigateTo(`${IG_ROOT}/direct/inbox/`, 'requests');
    await this.page.waitForTimeout(1_500);

    const hrefs = await this.page.$$eval(
      'a[href*="/direct/t/"]',
      els => [...new Set(els.map(el => el.getAttribute('href') ?? '').filter(Boolean))],
    );

    const threads: InboxThread[] = [];
    for (const href of hrefs) {
      const thread = await this.scrapeThread(href);
      if (thread) threads.push(thread);
    }

    return threads;
  }

  private async scrapeThread(href: string): Promise<InboxThread | null> {
    await this.navigateTo(`${IG_ROOT}${href}`);
    await this.page.waitForTimeout(1_500);

    // Extract the other user's username from the header
    const username = await this.extractUsername();
    if (!username) return null;

    // Self-conversation guard
    if (username.toLowerCase() === config.IG_USERNAME.toLowerCase()) return null;

    this.hrefByUsername.set(username, href);

    const messages = await this.extractMessages();
    return { href, username, messages };
  }

  private async extractUsername(): Promise<string | null> {
    try {
      return await this.page.$eval(
        'header a[href]:not([href*="/direct/"])',
        el => {
          const m = (el.getAttribute('href') ?? '').match(/^\/([a-zA-Z0-9._]+)\/?$/);
          return m ? m[1] ?? null : null;
        },
      );
    } catch {
      // Fallback: parse page title
      try {
        const m = (await this.page.title()).match(/^(.+?)\s*[·•·]/);
        return m ? (m[1] ?? '').trim() || null : null;
      } catch {
        return null;
      }
    }
  }

  private extractMessages(): Promise<ScrapedMessage[]> {
    // This callback runs in the browser process — all DOM APIs are available there.
    // We use Function constructor form so tsc doesn't try to type-check browser globals.
    return this.page.evaluate(
      new Function(`
        const W = window.innerWidth;
        const results = [];
        for (const row of document.querySelectorAll('[role="row"]')) {
          const textEl = row.querySelector('[dir="auto"]');
          if (!textEl) continue;
          const text = (textEl.innerText || '').trim();
          if (!text) continue;
          const rect = textEl.getBoundingClientRect();
          const isOutgoing = rect.right > W * 0.75;
          const hash = text.slice(0, 40) + '_' + Math.round(rect.top);
          results.push({ hash, text, isOutgoing });
        }
        return results;
      `) as () => ScrapedMessage[],
    );
  }

  // ── Send ────────────────────────────────────────────────────────────────────

  async sendMessage(username: string, text: string): Promise<void> {
    const href = this.hrefByUsername.get(username);
    if (!href) {
      logger.warn('Thread href not found for user — cannot send', { username });
      return;
    }

    await this.navigateTo(`${IG_ROOT}${href}`);
    await this.page.waitForTimeout(1_000);

    const input = this.page.locator('[contenteditable="true"]').last();
    await input.click();
    await input.fill(text);
    await this.page.waitForTimeout(300);
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(800);

    logger.debug('DM sent', { username, preview: text.substring(0, 60) });
  }

  // ── Posts / comments (use postPage — isolated from DM polling) ──────────────

  async getRecentPostHrefs(limit = 6): Promise<string[]> {
    await this.postPage.goto(`${IG_ROOT}/${config.IG_USERNAME}/`, {
      waitUntil: 'load', timeout: 20_000,
    }).catch(() => {});

    // Wait until at least one post link appears in the DOM (SPA may render late)
    await this.postPage.waitForSelector('a[href*="/p/"]', { timeout: 8_000 }).catch(() => {});

    return this.postPage.$$eval(
      'a[href*="/p/"]',
      (els, max) =>
        [...new Set(els.map(el => el.getAttribute('href') ?? '').filter(h => h.includes('/p/')))]
          .slice(0, max),
      limit,
    );
  }

  async getPostComments(postHref: string): Promise<PostComment[]> {
    await this.postPage.goto(`${IG_ROOT}${postHref}`, {
      waitUntil: 'load', timeout: 20_000,
    }).catch(() => {});
    await this.postPage.waitForTimeout(4_000);

    // Diagnostic: log element counts to identify correct selectors
    const diag = await this.postPage.evaluate(
      new Function(`
        return {
          url: window.location.href,
          li: document.querySelectorAll('li').length,
          ulLi: document.querySelectorAll('ul li').length,
          dirAuto: document.querySelectorAll('[dir="auto"]').length,
          articleLi: document.querySelectorAll('article li').length,
          aHref: document.querySelectorAll('a[href^="/"]').length,
        };
      `) as () => Record<string, unknown>,
    );
    logger.info('Post page DOM', diag);

    return this.postPage.evaluate(
      new Function('postHref', `
        const results = [];
        const seen = new Set();

        // Strategy 1: ul li with username link + dir=auto text
        for (const li of document.querySelectorAll('ul li')) {
          const usernameEl = li.querySelector('a[href^="/"]');
          const textEl = li.querySelector('[dir="auto"]') || li.querySelector('span');
          if (!usernameEl || !textEl) continue;
          const username = (usernameEl.getAttribute('href') || '').replace(/\\//g, '');
          const text = (textEl.innerText || textEl.textContent || '').trim();
          if (!username || !text || text.length < 1) continue;
          const key = username + '_' + text.slice(0, 30);
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ hash: key, postHref, username, text });
        }

        if (results.length > 0) return results;

        // Strategy 2: walk all [dir="auto"] elements, find nearest username link
        // Skip timestamp-like text and Instagram reserved paths
        const tsPattern = /^\\d+\\s*[smhd]$|^\\d+\\s*(min|hour|day|week|month|sec|хв|год|дн|тиж|міс|сек)/i;
        const reserved = new Set(['reels','explore','direct','p','tv','stories','accounts','reel','highlights']);
        for (const textEl of document.querySelectorAll('[dir="auto"]')) {
          const text = (textEl.innerText || textEl.textContent || '').trim();
          if (!text || text.length < 2) continue;
          if (tsPattern.test(text)) continue; // skip timestamps
          let parent = textEl.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!parent) break;
            const link = parent.querySelector('a[href^="/"]');
            if (link) {
              // Skip links that are inside the text element itself (e.g. @mentions)
              if (textEl.contains(link)) { parent = parent.parentElement; continue; }
              const username = (link.getAttribute('href') || '').replace(/\\//g, '');
              if (!username || reserved.has(username.toLowerCase())) break;
              const key = username + '_' + text.slice(0, 30);
              if (!seen.has(key)) {
                seen.add(key);
                results.push({ hash: key, postHref, username, text });
              }
              break;
            }
            parent = parent.parentElement;
          }
        }

        return results;
      `) as (postHref: string) => PostComment[],
      postHref,
    );
  }

  async postComment(postHref: string, text: string): Promise<void> {
    await this.postPage.goto(`${IG_ROOT}${postHref}`, {
      waitUntil: 'load', timeout: 20_000,
    }).catch(() => {});
    await this.postPage.waitForTimeout(3_000);

    await this.postPage.evaluate(
      new Function('window.scrollTo(0, document.body.scrollHeight)') as () => void,
    );
    await this.postPage.waitForTimeout(1_000);

    const textarea = this.postPage.locator('textarea[placeholder]').last();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });
    await textarea.scrollIntoViewIfNeeded();
    await textarea.click();
    await this.postPage.waitForTimeout(500);
    await textarea.fill(text);
    await this.postPage.waitForTimeout(400);

    try {
      const btn = this.postPage.locator('[type="submit"]').last();
      if (await btn.isEnabled({ timeout: 1_500 })) {
        await btn.click();
      } else {
        await this.postPage.keyboard.press('Enter');
      }
    } catch {
      await this.postPage.keyboard.press('Enter');
    }

    await this.postPage.waitForTimeout(2_000);
    logger.info('Auto-comment posted', { postHref, preview: text.substring(0, 60) });
  }

  async replyToComment(postHref: string, commentUsername: string, replyText: string): Promise<void> {
    if (!this.postPage.url().includes(postHref)) {
      await this.postPage.goto(`${IG_ROOT}${postHref}`, {
        waitUntil: 'load', timeout: 20_000,
      }).catch(() => {});
      await this.postPage.waitForTimeout(2_000);
    }

    const textarea = this.postPage.locator('textarea[placeholder]').last();
    await textarea.waitFor({ state: 'visible', timeout: 8_000 });
    await textarea.click();
    await this.postPage.waitForTimeout(300);
    await textarea.fill(`@${commentUsername} ${replyText}`);
    await this.postPage.waitForTimeout(300);
    await this.postPage.keyboard.press('Enter');
    await this.postPage.waitForTimeout(1_500);

    logger.debug('Comment reply sent', { postHref, commentUsername });
  }

  /** Sends a DM to a commenter. Uses existing thread if known, otherwise inbox search. */
  async sendDmToUser(username: string, text: string): Promise<void> {
    logger.info('sendDmToUser', { username, knownThreads: [...this.hrefByUsername.keys()] });

    const existingHref = this.hrefByUsername.get(username);
    if (existingHref) {
      await this.postPage.goto(`${IG_ROOT}${existingHref}`, {
        waitUntil: 'domcontentloaded', timeout: 20_000,
      }).catch(() => {});
      await this.postPage.waitForTimeout(2_000);
      await this._sendInCurrentThread(text);
      logger.info('DM sent via existing thread', { username, preview: text.substring(0, 60) });
      return;
    }

    // Navigate to inbox and search for the user's thread there
    await this.postPage.goto(`${IG_ROOT}/direct/inbox/`, {
      waitUntil: 'domcontentloaded', timeout: 20_000,
    }).catch(() => {});
    await this.postPage.waitForTimeout(2_500);

    // Log thread titles visible in inbox
    const inboxThreads = await this.postPage.$$eval(
      'a[href*="/direct/t/"]',
      els => els.map(el => ({ href: el.getAttribute('href'), text: (el as HTMLElement).innerText?.trim().slice(0, 40) })).slice(0, 10),
    );
    logger.info('Inbox threads on postPage', { count: inboxThreads.length, threads: inboxThreads });

    // Try to find the user's thread in the inbox list
    const threadLink = this.postPage
      .locator('a[href*="/direct/t/"]')
      .filter({ hasText: username })
      .first();

    if (await threadLink.count() > 0) {
      await threadLink.click({ timeout: 3_000 });
      await this.postPage.waitForTimeout(2_000);
      await this._sendInCurrentThread(text);
      logger.info('DM sent via inbox thread', { username, preview: text.substring(0, 60) });
      return;
    }

    // Last resort: click the compose (new message) button in inbox
    logger.warn('Thread not found in inbox, trying compose button', { username });
    const composeBtn = this.postPage.locator('[aria-label*="New"], [aria-label*="Нов"], [aria-label*="new"]').first();
    await composeBtn.click({ timeout: 5_000 });
    await this.postPage.waitForTimeout(1_500);

    const searchInput = this.postPage.locator('input').first();
    await searchInput.waitFor({ state: 'visible', timeout: 5_000 });
    await searchInput.fill(username);
    await this.postPage.waitForTimeout(2_000);

    const anyResult = this.postPage.locator('*').filter({ hasText: new RegExp(`^${username}$`) }).first();
    await anyResult.click({ timeout: 5_000 });
    await this.postPage.waitForTimeout(500);

    const nextBtn = this.postPage.locator('button').filter({ hasText: /next|chat|далі/i }).first();
    await nextBtn.click({ timeout: 3_000 }).catch(() => {});
    await this.postPage.waitForTimeout(2_000);

    await this._sendInCurrentThread(text);
    logger.info('DM sent via compose flow', { username, preview: text.substring(0, 60) });
  }

  private async _sendInCurrentThread(text: string): Promise<void> {
    const input = this.postPage.locator('[contenteditable="true"]').last();
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.click();
    await input.fill(text);
    await this.postPage.waitForTimeout(400);
    await this.postPage.keyboard.press('Enter');
    await this.postPage.waitForTimeout(1_500);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async navigateTo(url: string, hash?: string): Promise<void> {
    const target = hash ? `${url}#${hash}` : url;
    if (this.page.url() === target) return;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}
