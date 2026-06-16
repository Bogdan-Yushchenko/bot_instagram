import { Lead } from '@prisma/client';
import { config } from '../config';
import { InstagramClient } from '../instagram/client';
import { LeadService } from '../leads/LeadService';
import { scenarioLoader } from '../scenarios/loader';
import { ScenarioStep } from '../scenarios/types';
import { Classifier } from './Classifier';
import { logger } from '../utils/logger';

export class ScenarioEngine {
  private readonly classifier = new Classifier();

  constructor(
    private readonly igClient: InstagramClient,
    private readonly leadService: LeadService,
  ) {}

  /** Starts a scenario from its initial step. */
  async start(lead: Lead, scenarioId: string): Promise<void> {
    const scenario = scenarioLoader.getById(scenarioId);
    if (!scenario) {
      logger.warn('Scenario not found', { scenarioId });
      return;
    }

    const step = scenario.steps[scenario.initialStep];
    if (!step) {
      logger.warn('Initial step not found', { scenarioId, initialStep: scenario.initialStep });
      return;
    }

    await this.executeStep(lead, step, scenarioId);
  }

  /** Advances the conversation after the user replies. */
  async advance(lead: Lead, userText: string): Promise<void> {
    if (!lead.scenarioId || !lead.currentStepId) return;

    const scenario = scenarioLoader.getById(lead.scenarioId);
    if (!scenario) return;

    const currentStep = scenario.steps[lead.currentStepId];
    if (!currentStep?.next) return;

    const { next } = currentStep;

    if (next.type === 'step' && next.stepId) {
      const nextStep = scenario.steps[next.stepId];
      if (nextStep) await this.executeStep(lead, nextStep, lead.scenarioId);
      return;
    }

    if (next.type === 'classify' && next.classifier && next.branches) {
      const category = this.classifier.classify(next.classifier, userText);

      // Persist the category only when it's definitive
      if (category !== 'UNKNOWN') {
        await this.leadService.updateCategory(lead.id, category);
      }

      const nextStepId = next.branches[category] ?? next.branches['UNKNOWN'];
      if (!nextStepId) {
        logger.warn('No branch defined for category', {
          category,
          currentStep: currentStep.id,
          scenarioId: lead.scenarioId,
        });
        return;
      }

      const nextStep = scenario.steps[nextStepId];
      if (nextStep) await this.executeStep(lead, nextStep, lead.scenarioId);
    }
  }

  private async executeStep(lead: Lead, step: ScenarioStep, scenarioId: string): Promise<void> {
    if (step.setStatus) {
      await this.leadService.updateStatus(lead.id, step.setStatus);
    }

    if (step.message) {
      const text = this.interpolate(step.message);

      await this.igClient.sendMessage(lead.instagramId, text);
      await this.leadService.saveMessage(lead.id, text, 'OUTBOUND');

      logger.info('Bot message sent', {
        leadId: lead.id,
        instagramId: lead.instagramId,
        scenarioId,
        stepId: step.id,
        status: step.setStatus,
      });
    }

    // Always persist the current step so we know where to advance next
    await this.leadService.updateScenarioStep(lead.id, scenarioId, step.id);
  }

  /** Replaces {PLACEHOLDER} tokens in message templates. */
  private interpolate(template: string): string {
    const vars: Record<string, string> = {
      MATERIAL_LINK: config.MATERIAL_LINK,
    };

    return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
  }
}
