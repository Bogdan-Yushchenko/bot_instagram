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

        // Strategy 2: for each comment text element walk UP the DOM until we reach
        // the smallest ancestor that contains EXACTLY ONE "author" link.
        // Author links are identified by being /username/ (one path segment) AND
        // NOT inside a [dir="auto"] element (which would make them @mentions inside text).
        // This is order-independent: works whether the link appears before or after the text.
        const tsPattern = /^\\d+\\s*[smhd]$|^\\d+\\s*(min|hour|day|week|month|sec|хв|год|дн|тиж|міс|сек)/i;
        const reserved = new Set(['reels','explore','direct','p','tv','stories','accounts','reel','highlights','popular']);
        // Instagram UI strings that are not comment text
        const uiTexts = new Set(['reply','see translation','see more','view replies','load more comments','english','less','translate','follow','following']);

        function isAuthorLink(a) {
          if (a.closest('[dir="auto"]')) return false; // @mention inside comment text
          const parts = (a.getAttribute('href') || '').split('/').filter(Boolean);
          return parts.length === 1 && !reserved.has(parts[0].toLowerCase());
        }

        for (const textEl of document.querySelectorAll('[dir="auto"]')) {
          if (textEl.closest('a')) continue; // username display text — skip
          const text = (textEl.innerText || textEl.textContent || '').trim();
          if (!text || text.length < 2 || tsPattern.test(text)) continue;
          if (uiTexts.has(text.toLowerCase())) continue; // skip UI buttons
          if (/^©/.test(text)) continue; // skip footer copyright text
          if (/^@?[\\w.]{1,30}$/.test(text)) continue; // skip bare username display texts

          let container = textEl.parentElement;
          for (let d = 0; d < 12 && container && container.tagName !== 'BODY'; d++) {
            const authorLinks = [...container.querySelectorAll('a[href^="/"]')].filter(isAuthorLink);
            if (authorLinks.length === 1) {
              const username = authorLinks[0].getAttribute('href').split('/').filter(Boolean)[0];
              const key = username + '_' + text.slice(0, 30);
              if (!seen.has(key)) {
                seen.add(key);
                results.push({ hash: key, postHref, username, text });
              }
              break;
            }
            container = container.parentElement;
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
    await this.postPage.waitForTimeout(3_500);

    await this.postPage.evaluate(
      new Function('window.scrollTo(0, document.body.scrollHeight)') as () => void,
    );
    await this.postPage.waitForTimeout(1_000);

    // Instagram uses <textarea aria-label="Add a comment…"> (NOT placeholder, NOT contenteditable)
    // There is also a hidden aria-hidden="true" textarea — we must exclude it
    const textarea = this.postPage.locator('textarea:not([aria-hidden="true"])').last();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });
    await textarea.scrollIntoViewIfNeeded().catch(() => {});
    await textarea.click();
    await this.postPage.waitForTimeout(500);

    // fill() triggers React's input event in Playwright
    await textarea.fill(text);
    await this.postPage.waitForTimeout(800);

    // Click the "Post" / "Опублікувати" button that appears after typing
    const postBtn = this.postPage.locator('button').filter({
      hasText: /^(post|опублікувати|опубликовать|publish)$/i,
    }).last();
    try {
      await postBtn.waitFor({ state: 'visible', timeout: 3_000 });
      await postBtn.click();
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
      await this.postPage.waitForTimeout(3_000);
    }

    // Try to click "Reply" on the specific comment to create a threaded reply
    const usernameLink = this.postPage.locator(`a[href="/${commentUsername}/"]`).last();
    if (await usernameLink.count() > 0) {
      await usernameLink.scrollIntoViewIfNeeded().catch(() => {});
      await this.postPage.waitForTimeout(400);
      await usernameLink.hover().catch(() => {});
      await this.postPage.waitForTimeout(600);

      const replyBtn = this.postPage.locator('button, [role="button"]')
        .filter({ hasText: /^(reply|відповісти|ответить)$/i })
        .last();
      if (await replyBtn.count() > 0) {
        await replyBtn.click({ timeout: 3_000 }).catch(() => {});
        await this.postPage.waitForTimeout(600);
      }
    }

    // Use the visible comment textarea (not the hidden aria-hidden one)
    const textarea = this.postPage.locator('textarea:not([aria-hidden="true"])').last();
    await textarea.waitFor({ state: 'visible', timeout: 8_000 });
    await textarea.click();
    await this.postPage.waitForTimeout(300);
    await textarea.fill(`@${commentUsername} ${replyText}`);
    await this.postPage.waitForTimeout(400);

    const postBtn = this.postPage.locator('button').filter({
      hasText: /^(post|опублікувати|опубликовать|publish)$/i,
    }).last();
    try {
      await postBtn.waitFor({ state: 'visible', timeout: 3_000 });
      await postBtn.click();
    } catch {
      await this.postPage.keyboard.press('Enter');
    }

    await this.postPage.waitForTimeout(2_000);
    logger.info('Comment reply posted', { postHref, commentUsername, preview: replyText.substring(0, 60) });
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
    await this.postPage.waitForTimeout(2_500);

    // Find the search result that shows the exact username (in a list item or similar)
    const userResult = this.postPage
      .locator('[role="listbox"] [role="option"], [role="list"] > *, div[tabindex]')
      .filter({ hasText: username })
      .first();

    if ((await userResult.count()) === 0) {
      logger.warn('User not found in compose search', { username });
      return;
    }

    await userResult.click({ timeout: 5_000 });
    await this.postPage.waitForTimeout(800);

    const nextBtn = this.postPage.locator('button').filter({ hasText: /next|chat|далі|ок|ok/i }).first();
    if ((await nextBtn.count()) > 0) {
      await nextBtn.click({ timeout: 3_000 }).catch(() => {});
      await this.postPage.waitForTimeout(2_000);
    }

    // Verify we're in a DM thread before sending
    const currentUrl = this.postPage.url();
    if (!currentUrl.includes('/direct/')) {
      logger.warn('Not in DM thread after compose flow', { username, url: currentUrl });
      return;
    }

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

  async deleteOwnComment(postHref: string, commentText: string): Promise<void> {
    if (!this.postPage.url().includes(postHref)) {
      await this.postPage.goto(`${IG_ROOT}${postHref}`, {
        waitUntil: 'load', timeout: 20_000,
      }).catch(() => {});
      await this.postPage.waitForTimeout(3_000);
    }

    // Use the first line of the comment text as a unique anchor
    const textAnchor = commentText.split('\n')[0]?.trim().substring(0, 30) ?? '';
    if (!textAnchor) {
      logger.warn('No comment text anchor provided', { postHref });
      return;
    }

    // Mark the specific comment <li> by text content.
    // We walk up from the text node but STOP before entering <header>
    // so we never accidentally target the post-level "More options" button.
    const marked = await this.postPage.evaluate((anchor: string) => {
      const elements = document.querySelectorAll<HTMLElement>('span, [dir="auto"]');
      for (const el of elements) {
        if (!(el.textContent ?? '').includes(anchor)) continue;
        let parent: HTMLElement | null = el.parentElement;
        for (let i = 0; i < 10 && parent; i++) {
          if (parent.closest('header')) break;        // never touch post header area
          if (parent.tagName.toLowerCase() === 'li') {
            parent.setAttribute('data-del-target', '1');
            parent.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
          }
          parent = parent.parentElement;
        }
      }
      return false;
    }, textAnchor);

    if (!marked) {
      logger.warn('Own comment not found by text on post page', { postHref, textAnchor });
      return;
    }

    // Playwright hover on the marked <li> — this triggers real CSS :hover
    const commentRow = this.postPage.locator('[data-del-target="1"]');
    await commentRow.scrollIntoViewIfNeeded().catch(() => {});
    await this.postPage.waitForTimeout(400);
    await commentRow.hover().catch(() => {});
    await this.postPage.waitForTimeout(800);

    // Find options button SCOPED TO the comment row — never touches post-level buttons
    const optionsBtn = commentRow.locator(
      '[aria-label*="More"], [aria-label*="more"], [aria-label*="Більше"], [aria-label*="Ещё"]',
    ).first();

    const removeMarker = () =>
      this.postPage.evaluate(() => {
        document.querySelector('[data-del-target]')?.removeAttribute('data-del-target');
      });

    if ((await optionsBtn.count()) === 0) {
      logger.warn('Options button not found in comment row', { postHref, textAnchor });
      await removeMarker();
      return;
    }

    await optionsBtn.click({ timeout: 3_000 });
    await this.postPage.waitForTimeout(600);
    await removeMarker();

    // Click "Delete" in the popup (exact match to avoid partial matches like "Delete post")
    const deleteBtn = this.postPage
      .locator('button, [role="button"]')
      .filter({ hasText: /^(delete|видалити|удалить)$/i })
      .first();

    if ((await deleteBtn.count()) === 0) {
      logger.warn('Delete button not found in popup', { postHref });
      return;
    }

    await deleteBtn.click({ timeout: 3_000 });
    await this.postPage.waitForTimeout(800);

    // Confirm if Instagram shows a second confirmation dialog
    const confirmBtn = this.postPage
      .locator('button')
      .filter({ hasText: /^(delete|видалити|удалить)$/i })
      .last();
    if ((await confirmBtn.count()) > 0) {
      await confirmBtn.click({ timeout: 2_000 }).catch(() => {});
      await this.postPage.waitForTimeout(1_000);
    }

    logger.info('Auto-comment deleted', { postHref });
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
