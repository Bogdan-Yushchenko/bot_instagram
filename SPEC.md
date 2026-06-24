# Specification: Instagram Keyword-Based Lead Auto-Responder

## User Story

**As** an Instagram account owner (`bohdanyushchenko3d`),
**I want** the bot to detect keywords in post comments and direct messages and automatically reply with the matching information via DM,
**so that** I can capture and respond to leads instantly, without manually reading every comment or message.

## Acceptance Criteria

1. **Comment → DM reply**
   Given a user comments one of the tracked keywords (`гайд`, `запис`, `ціна`, `психолог`, `тест`) under a tracked post,
   when the bot scans comments (every 60s),
   then the bot sends that user a DM with the reply text mapped to the matched keyword, and that DM goes to the commenter who wrote it — never to a different user on the same post.

2. **No duplicate replies**
   Given a user has already received a reply for a specific keyword,
   when the same keyword is detected again from the same user (same post or a different one),
   then no second DM is sent — tracked via `comment_leads.json` keyed by `username + keyword`.

3. **DM keyword reply**
   Given a user sends a DM containing a keyword,
   when the bot scans DM inbox/requests (every 8s),
   then the bot replies in the same DM thread within one poll cycle, without invoking the scenario engine.

4. **Auto-instruction comment**
   Given a new post is published,
   when the bot scans posts and finds no existing auto-comment,
   then it publishes a comment listing all available keywords and what each unlocks.

5. **Auto-instruction stays current**
   Given the auto-instruction text changes (e.g. a keyword or reply is edited),
   when the bot scans the post,
   then it deletes the old auto-comment (only that comment, never the post) and republishes the updated one.

6. **Safe restart — no resend**
   Given the bot restarts,
   when it runs its seed scan,
   then it must not resend DMs for keywords already recorded as replied in `comment_leads.json`, and must not reprocess DM threads where the bot's message is already the last one in the thread.

7. **Safe restart — no message lost**
   Given the bot restarts while a DM thread's last message is an unanswered incoming message,
   when the seed scan runs,
   then it replies to that last message (keyword match, or scenario engine if no keyword matches).

8. **Self-comments excluded**
   Given a comment was authored by the bot's own account,
   when comments are scraped and matched,
   then that comment is excluded from triggering an outgoing DM.

9. **Session expiry is surfaced, not swallowed**
   Given `session.json` is expired or invalid,
   when the bot attempts to launch Playwright and load Instagram,
   then it logs a clear, actionable error (not a generic timeout/stack trace) and exits or retries — it must not loop silently producing empty scans.

10. **Scraper failure is visible**
    Given Instagram's DOM structure changes such that `getPostComments` returns 0 comments for a post known to have comments,
    when this happens for `N` consecutive scans (threshold TBD),
    then the bot logs a warning distinct from the normal "0 new keywords" case, so a human notices before leads go unanswered for days.

## Implementation Notes / Known Limitations

- **Author attribution**: `getPostComments` must attribute each comment to its real author regardless of DOM order or whether the author's link appears before or after the comment text in the markup (Instagram's comment DOM has no `<li>` structure, so this is order-independent by construction, not by luck). This is what AC1 and AC2 depend on — it is an implementation detail, not a separately observable behavior.
- **Cold-DM delivery**: when the recipient has never messaged the account before, Instagram may route the bot's DM to the recipient's "Message Requests" folder. The bot's responsibility ends at a successful send via the compose flow; recipient-side visibility/acceptance is outside the bot's control and is not a bug if the send itself succeeded.

## Definition of Done

- [x] Keyword matching is case-insensitive for Cyrillic and Latin text — enforced by `test/keywords.test.ts` (21 cases), runnable via `npm test`.
- [ ] `getPostComments` attributes each comment to its real author, verified across ≥2 posts and ≥3 distinct commenters via manual log inspection (`Comment pairs` diagnostic). *(no automated test yet — DOM scraping against live Instagram markup is not easily unit-tested; needs a recorded-HTML fixture test to become repeatable.)*
- [ ] `deleteOwnComment` removes only the bot's own comment — never the post itself (regression-tested manually once; no automated guard).
- [ ] `postComment` reliably targets the visible comment textarea (`textarea:not([aria-hidden="true"])`), not the hidden one.
- [ ] `comment_leads.json` contains exactly one entry per `(username, keyword)` pair with no cross-user misattribution.
- [ ] DM seed-scan on restart neither resends known replies nor silently drops a genuinely unanswered message.
- [ ] Session-expiry and scraper-failure cases (AC9, AC10) produce a distinguishable log signal — not yet implemented.
- [ ] `npx tsc --noEmit` passes with zero errors.
- [ ] Bot runs unattended through ≥30 minutes / multiple poll cycles with no uncaught exceptions in logs.
- [ ] `GUIDE.md` documents setup, security/anti-ban rules, and architecture for any future maintainer.
- [ ] `.gitignore` excludes all runtime state/secrets: `session.json`, `comment_leads.json`, `commented_posts.json`, `.env` (verified present).
