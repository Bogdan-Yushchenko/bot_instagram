import { Lead, LeadCategory, LeadStatus, MessageDirection } from '@prisma/client';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';

export class LeadService {
  async findOrCreate(instagramId: string, username?: string): Promise<Lead> {
    const existing = await prisma.lead.findUnique({ where: { instagramId } });
    if (existing) return existing;

    const lead = await prisma.lead.create({
      data: { instagramId, username },
    });

    logger.info('New lead created', { instagramId, leadId: lead.id, username });
    return lead;
  }

  async findByInstagramId(instagramId: string): Promise<Lead | null> {
    return prisma.lead.findUnique({ where: { instagramId } });
  }

  async updateScenarioStep(
    leadId: string,
    scenarioId: string,
    currentStepId: string,
  ): Promise<Lead> {
    return prisma.lead.update({
      where: { id: leadId },
      data: { scenarioId, currentStepId },
    });
  }

  async updateStatus(leadId: string, status: LeadStatus): Promise<Lead> {
    return prisma.lead.update({
      where: { id: leadId },
      data: { status },
    });
  }

  async updateCategory(leadId: string, category: LeadCategory): Promise<Lead> {
    return prisma.lead.update({
      where: { id: leadId },
      data: { category },
    });
  }

  async saveMessage(
    leadId: string,
    text: string,
    direction: MessageDirection,
    instagramMsgId?: string,
  ): Promise<void> {
    await prisma.message.create({
      data: { leadId, text, direction, instagramMsgId },
    });
  }

  async getHistory(leadId: string, limit = 20) {
    return prisma.message.findMany({
      where: { leadId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
}
