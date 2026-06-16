import path from 'path';
import fs from 'fs';
import { Scenario } from './types';
import { logger } from '../utils/logger';

class ScenarioLoader {
  private readonly scenarios = new Map<string, Scenario>();
  private readonly triggerMap = new Map<string, string>(); // keyword → scenario id

  load(): void {
    const dataDir = path.join(__dirname, 'data');
    const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      const raw = fs.readFileSync(path.join(dataDir, file), 'utf-8');
      const scenario = JSON.parse(raw) as Scenario;

      this.scenarios.set(scenario.id, scenario);

      for (const trigger of scenario.triggers) {
        this.triggerMap.set(trigger.toLowerCase(), scenario.id);
      }

      logger.info(`Scenario loaded: "${scenario.id}"`, {
        triggers: scenario.triggers,
        steps: Object.keys(scenario.steps).length,
      });
    }

    logger.info(`Total scenarios: ${this.scenarios.size}`);
  }

  getByTrigger(keyword: string): Scenario | null {
    const id = this.triggerMap.get(keyword.toLowerCase());
    return id != null ? (this.scenarios.get(id) ?? null) : null;
  }

  getById(id: string): Scenario | null {
    return this.scenarios.get(id) ?? null;
  }

  getTriggerKeywords(): string[] {
    return [...this.triggerMap.keys()];
  }
}

export const scenarioLoader = new ScenarioLoader();
