import * as fs from 'fs';
import { InstagramClient } from './client';
import { BotService } from '../bot/BotService';
import { PostKeywordResponder } from '../bot/PostKeywordResponder';
import { CommentLeadsTracker } from '../bot/CommentLeadsTracker';
import { logger } from '../utils/logger';

const DM_POLL_MS     = 8_000;
const POST_POLL_MS   = 60_000;
const COMMENTED_FILE = 'commented_posts.json';

export class Poller {
  private readonly seenDmHashes      = new Set<string>();
  // Tracks "username:keyword" within a session to avoid retrying a DM that was just sent
  private readonly seenLeadKeys      = new Set<string>();
  private readonly autoCommentedPosts = new Set<string>(
    fs.existsSync(COMMENTED_FILE)
      ? (JSON.parse(fs.readFileSync(COMMENTED_FILE, 'utf-8')) as string[])
      : [],
  );
  private readonly postKeywords  = new PostKeywordResponder();
  private readonly leadsTracker  = new CommentLeadsTracker();

  constructor(
    private readonly igClient: InstagramClient,
    private readonly botService: BotService,
  ) {}

  async start(): Promise<void> {
    await this.igClient.launch();
    await this.scanDMs(true);
    await this.scanPosts(true);
    logger.info('Startup scan done — polling started', {
      dmInterval: `${DM_POLL_MS / 1000}s`,
      postInterval: `${POST_POLL_MS / 1000}s`,
    });
    setInterval(() => void this.scanDMs(false),  DM_POLL_MS);
    setInterval(() => void this.scanPosts(false), POST_POLL_MS);
  }

  // ── DM polling ──────────────────────────────────────────────────────────────

  private async scanDMs(seedOnly: boolean): Promise<void> {
    try {
      const [inboxResult, requestsResult] = await Promise.allSettled([
        this.igClient.scanInbox(),
        this.igClient.scanRequests(),
      ]);
      const threads = [
        ...(inboxResult.status    === 'fulfilled' ? inboxResult.value   : []),
        ...(requestsResult.status === 'fulfilled' ? requestsResult.value : []),
      ];
      for (const { username, messages } of threads) {
        for (const msg of messages) {
          if (msg.isOutgoing) continue;
          if (this.seenDmHashes.has(msg.hash)) continue;
          this.seenDmHashes.add(msg.hash);
          if (seedOnly) continue;
          await this.botService.handleDirectMessage(username, msg.text, msg.hash, username);
        }
      }
    } catch (err) {
      logger.error('DM poll error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Post comment polling ─────────────────────────────────────────────────────

  private async scanPosts(seedOnly: boolean): Promise<void> {
    try {
      const postHrefs = await this.igClient.getRecentPostHrefs(6);
      logger.info('Post scan', { seedOnly, found: postHrefs.length });

      for (const postHref of postHrefs) {
        if (!seedOnly && !this.autoCommentedPosts.has(postHref)) {
          const intro = this.postKeywords.getDefaultReply();
          await this.igClient.postComment(postHref, intro);
          this.autoCommentedPosts.add(postHref);
          fs.writeFileSync(COMMENTED_FILE, JSON.stringify([...this.autoCommentedPosts]));
        }

        const comments = await this.igClient.getPostComments(postHref);
        logger.info('Comments scraped', { postHref, count: comments.length });

        for (const comment of comments) {
          if (comment.username.toLowerCase() === this.igClient.getSelfUsername().toLowerCase()) continue;

          const { keyword, reply } = this.postKeywords.getMatch(comment.text);
          // Only react to actual keyword matches, not generic comments
          if (keyword === '__default__') continue;
          const leadKey = `${comment.username}:${keyword}`;

          // Session-level dedup: already handled in this run
          if (this.seenLeadKeys.has(leadKey)) continue;

          // Persistent dedup: already replied across sessions
          if (this.leadsTracker.hasReplied(comment.username, keyword)) {
            this.seenLeadKeys.add(leadKey); // cache so we skip on next scans too
            continue;
          }

          // During startup scan: mark already-replied ones but don't send new ones
          if (seedOnly) continue;

          // New unhandled comment — send DM
          this.seenLeadKeys.add(leadKey);

          logger.info('New comment detected', {
            postHref,
            username: comment.username,
            keyword,
            preview: comment.text.substring(0, 60),
          });

          await this.igClient.sendDmToUser(comment.username, reply);
          this.leadsTracker.recordReply(comment.username, keyword, comment.text, reply);

          logger.info('DM reply sent', { username: comment.username, keyword });
        }
      }
    } catch (err) {
      logger.error('Post poll error', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
