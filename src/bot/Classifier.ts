import { LeadCategory } from '@prisma/client';
import { logger } from '../utils/logger';

type ClassifierFn = (text: string) => LeadCategory;

// ── Keyword lists for MVP classification ──────────────────────────────────────
// Replace / extend these without changing the interface.
// Later: swap classifierFn with a Claude API call per classifier name.

const PRIVATE_KEYWORDS = [
  'частный', 'частная', 'частно', 'сам', 'сама', 'своя', 'свой',
  'независим', 'фриланс', 'самозанятый', 'самозанятая', '1️⃣', '1',
];

const CENTER_KEYWORDS = [
  'центр', 'организация', 'клиника', 'компания', 'команда', 'коллеги',
  'сотрудников', 'работников', 'несколько', '2️⃣', '2',
];

const BEGINNER_KEYWORDS = [
  'начинаю', 'начинающ', 'учусь', 'студент', 'только начал', 'только начала',
  'новичок', 'стажёр', 'курс', 'ещё нет клиент', 'пока нет', '3️⃣', '3',
];

const classifiers: Record<string, ClassifierFn> = {
  practice_type: (text): LeadCategory => {
    const lower = text.toLowerCase();

    // Order matters: check CENTER before PRIVATE to avoid "работаю сам в центре" confusion
    if (CENTER_KEYWORDS.some((kw) => lower.includes(kw))) return 'PSYCHOLOGY_CENTER';
    if (BEGINNER_KEYWORDS.some((kw) => lower.includes(kw))) return 'BEGINNER';
    if (PRIVATE_KEYWORDS.some((kw) => lower.includes(kw))) return 'PRIVATE_PRACTICE';

    logger.debug('Classifier: no match', { classifier: 'practice_type', text });
    return 'UNKNOWN';
  },
};

export class Classifier {
  classify(classifierName: string, text: string): LeadCategory {
    const fn = classifiers[classifierName];
    if (!fn) {
      logger.warn('Unknown classifier', { classifierName });
      return 'UNKNOWN';
    }
    return fn(text);
  }

  /**
   * Claude API integration point (future):
   *
   * async classifyWithAI(classifierName: string, text: string): Promise<LeadCategory> {
   *   const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
   *   const msg = await client.messages.create({
   *     model: 'claude-haiku-4-5-20251001',
   *     max_tokens: 32,
   *     messages: [{
   *       role: 'user',
   *       content: `Classify this reply from a psychologist into one of:
   *         PRIVATE_PRACTICE, PSYCHOLOGY_CENTER, BEGINNER, UNKNOWN.
   *         Reply with just the label.
   *         Text: "${text}"`,
   *     }],
   *   });
   *   return (msg.content[0].text.trim() as LeadCategory) ?? 'UNKNOWN';
   * }
   */
}
