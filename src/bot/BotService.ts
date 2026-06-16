import { InstagramClient } from '../instagram/client';
import { LeadService } from '../leads/LeadService';
import { ScenarioEngine } from './ScenarioEngine';
import { TriggerMatcher } from './TriggerMatcher';
import { logger } from '../utils/logger';

export class BotService {
  private readonly igClient = new InstagramClient();
  private readonly leadService = new LeadService();
  private readonly engine: ScenarioEngine;
  private readonly triggerMatcher = new TriggerMatcher();

  constructor() {
    this.engine = new ScenarioEngine(this.igClient, this.leadService);
  }

  getIgClient(): InstagramClient {
    return this.igClient;
  }

  /** Returns true if the text matches any scenario trigger keyword. */
  hasTrigger(text: string): boolean {
    return this.triggerMatcher.match(text) !== null;
  }

  async handleDirectMessage(
    senderId: string,
    text: string,
    msgId?: string,
    username?: string,
  ): Promise<void> {
    logger.info('Incoming DM', { senderId, username, preview: text.substring(0, 80), msgId });

    const lead = await this.leadService.findOrCreate(senderId, username);
    await this.leadService.saveMessage(lead.id, text, 'INBOUND', msgId);

    if (lead.status === 'NEW_LEAD') {
      const scenario = this.triggerMatcher.match(text);

      if (!scenario) {
        logger.debug('No trigger matched — ignoring', { senderId });
        return;
      }

      logger.info('Trigger matched — starting scenario', {
        scenarioId: scenario.id,
        senderId,
      });

      await this.engine.start(lead, scenario.id);
      return;
    }

    if (lead.scenarioId && lead.currentStepId) {
      await this.engine.advance(lead, text);
      return;
    }

    logger.debug('Lead has no active scenario', { senderId, status: lead.status });
  }
}
