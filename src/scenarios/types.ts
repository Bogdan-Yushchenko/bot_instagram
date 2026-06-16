import { LeadCategory, LeadStatus } from '@prisma/client';

export type NextType = 'step' | 'classify';

export interface StepNext {
  type: NextType;
  /** For type: 'step' — go directly to this step */
  stepId?: string;
  /** For type: 'classify' — name of the classifier function to use */
  classifier?: string;
  /** For type: 'classify' — maps LeadCategory value to the next stepId */
  branches?: Partial<Record<LeadCategory | 'UNKNOWN', string>>;
}

export interface ScenarioStep {
  id: string;
  /** Message template. Supports {MATERIAL_LINK} and other placeholders. */
  message?: string;
  /** Update lead status after executing this step */
  setStatus?: LeadStatus;
  /** Set lead category (used in classify branches) */
  setCategory?: LeadCategory;
  /** Whether the bot waits for a user reply before advancing */
  waitForReply: boolean;
  next?: StepNext;
}

export interface Scenario {
  id: string;
  /** Lowercase keywords that trigger this scenario */
  triggers: string[];
  initialStep: string;
  steps: Record<string, ScenarioStep>;
}
