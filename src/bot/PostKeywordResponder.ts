import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

interface KeywordEntry {
  trigger: string;
  reply: string;
}

interface PostKeywordsConfig {
  keywords: KeywordEntry[];
  defaultReply: string;
}

export class PostKeywordResponder {
  private readonly config: PostKeywordsConfig;

  constructor() {
    const filePath = path.join(__dirname, 'data/post_keywords.json');
    this.config = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PostKeywordsConfig;
    logger.info('Post keywords loaded', { count: this.config.keywords.length });
  }

  getDefaultReply(): string {
    return this.config.defaultReply;
  }

  getReply(commentText: string): string {
    return this.getMatch(commentText).reply;
  }

  getMatch(commentText: string): { keyword: string; reply: string } {
    const lower = commentText.toLowerCase();
    for (const entry of this.config.keywords) {
      if (lower.includes(entry.trigger.toLowerCase())) {
        return { keyword: entry.trigger, reply: entry.reply };
      }
    }
    return { keyword: '__default__', reply: this.config.defaultReply };
  }
}
