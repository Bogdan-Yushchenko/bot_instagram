import { Scenario } from '../scenarios/types';
import { scenarioLoader } from '../scenarios/loader';

export class TriggerMatcher {
  /**
   * Checks whether the message text contains any registered trigger keyword.
   * Returns the matched Scenario or null.
   */
  match(text: string): Scenario | null {
    const lower = text.toLowerCase();

    for (const keyword of scenarioLoader.getTriggerKeywords()) {
      if (lower.includes(keyword)) {
        return scenarioLoader.getByTrigger(keyword);
      }
    }

    return null;
  }
}
