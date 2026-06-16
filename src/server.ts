import 'dotenv/config';
import { createApp } from './app';
import { config } from './config';
import { prisma } from './db/client';
import { scenarioLoader } from './scenarios/loader';
import { BotService } from './bot/BotService';
import { Poller } from './instagram/Poller';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  scenarioLoader.load();

  await prisma.$connect();
  logger.info('Database connected');

  const botService = new BotService();
  const poller = new Poller(botService.getIgClient(), botService);
  await poller.start();

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    logger.info('Server started', { port: config.PORT, env: config.NODE_ENV });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.error('Fatal startup error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
