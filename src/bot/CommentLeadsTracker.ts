import * as fs from 'fs';
import { logger } from '../utils/logger';

interface LeadComment {
  text: string;
  keyword: string;
  commentedAt: string;
  replied: boolean;
  repliedAt?: string;
  replyPreview?: string;
}

type LeadsData = Record<string, { comments: LeadComment[] }>;

const FILE_PATH = 'comment_leads.json';

export class CommentLeadsTracker {
  private data: LeadsData;

  constructor() {
    this.data = fs.existsSync(FILE_PATH)
      ? (JSON.parse(fs.readFileSync(FILE_PATH, 'utf-8')) as LeadsData)
      : {};
    logger.info('Comment leads loaded', { users: Object.keys(this.data).length });
  }

  hasReplied(username: string, keyword: string): boolean {
    return this.data[username]?.comments.some(c => c.keyword === keyword && c.replied) ?? false;
  }

  recordReply(username: string, keyword: string, commentText: string, replyText: string): void {
    if (!this.data[username]) this.data[username] = { comments: [] };
    this.data[username].comments.push({
      text: commentText,
      keyword,
      commentedAt: new Date().toISOString(),
      replied: true,
      repliedAt: new Date().toISOString(),
      replyPreview: replyText.substring(0, 100),
    });
    this.save();
    logger.info('Lead recorded', { username, keyword });
  }

  private save(): void {
    fs.writeFileSync(FILE_PATH, JSON.stringify(this.data, null, 2));
  }
}
