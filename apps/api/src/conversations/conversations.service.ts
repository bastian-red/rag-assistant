/**
 * The signed-in person's conversations and their messages.
 *
 * Every query filters by `ownerId`, which is the whole of authorisation here:
 * another person's conversation answers 404, the same as one that does not
 * exist, so ids cannot be probed (`test/conversations.test.ts`).
 *
 * **Orphans.** An answer is STREAMING while it is written, and at most one per
 * conversation (`messages_one_streaming_per_conversation`). If the API
 * process dies mid-answer the row would stay STREAMING forever and block the
 * conversation. Every live answer stops itself at `ANSWER_DEADLINE_MS`, so a
 * STREAMING row older than that plus a grace minute has no writer left: it
 * is settled as FAILED when the conversation is read or asked again. The
 * age is compared in the database's clock, the one that wrote `created_at`.
 */
import { Injectable } from '@nestjs/common';
import { ANSWER_DEADLINE_MS, type Exchange } from '@rag/answer';
import { Prisma } from '@rag/db';
import {
  DomainError,
  type ConversationDetail,
  type ConversationList,
  type ConversationSummary,
  type MessageView,
} from '@rag/shared';

import { PrismaService } from '../infra/prisma.service';

/** A STREAMING answer older than this has no process writing it. */
export const ORPHAN_AFTER_MS = ANSWER_DEADLINE_MS + 60_000;

export const ORPHAN_ERROR = 'The server stopped while writing this answer. Ask again.';

/** A new conversation's title, until its first question names it. */
export const UNTITLED = 'New conversation';

/** How far back the prompt's history looks (the prompt keeps at most three exchanges). */
const HISTORY_MESSAGES = 20;

const summarySelect = {
  id: true,
  title: true,
  collectionId: true,
  createdAt: true,
  updatedAt: true,
} as const;

type SummaryRow = Prisma.ConversationGetPayload<{ select: typeof summarySelect }>;

function summaryOf(row: SummaryRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    collectionId: row.collectionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Earlier finished exchanges, oldest first: a question directly followed by
 * an answer that is DONE and not an abstention.
 */
export function exchangesOf(
  messages: readonly {
    role: 'USER' | 'ASSISTANT';
    status: string;
    content: string;
    abstained: boolean;
  }[],
): Exchange[] {
  const out: Exchange[] = [];
  for (let i = 0; i + 1 < messages.length; i += 1) {
    const question = messages[i]!;
    const reply = messages[i + 1]!;
    if (
      question.role === 'USER' &&
      reply.role === 'ASSISTANT' &&
      reply.status === 'DONE' &&
      !reply.abstained
    ) {
      out.push({ question: question.content, answer: reply.content });
      i += 1;
    }
  }
  return out;
}

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, collectionId: string | null): Promise<ConversationSummary> {
    if (collectionId !== null) {
      const owned = await this.prisma.client.collection.count({
        where: { id: collectionId, ownerId },
      });
      if (owned === 0) throw new DomainError('NOT_FOUND', 'No such collection.');
    }
    const row = await this.prisma.client.conversation.create({
      data: { ownerId, collectionId, title: UNTITLED },
      select: summarySelect,
    });
    return summaryOf(row);
  }

  async list(ownerId: string): Promise<ConversationList> {
    const rows = await this.prisma.client.conversation.findMany({
      where: { ownerId },
      select: summarySelect,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: 200,
    });
    return { conversations: rows.map(summaryOf) };
  }

  /** The conversation or 404, for this person only. */
  async owned(
    ownerId: string,
    id: string,
  ): Promise<{ id: string; collectionId: string | null; messages: number }> {
    const row = await this.prisma.client.conversation.findFirst({
      where: { id, ownerId },
      select: { id: true, collectionId: true, _count: { select: { messages: true } } },
    });
    if (row === null) throw new DomainError('NOT_FOUND', 'No such conversation.');
    return { id: row.id, collectionId: row.collectionId, messages: row._count.messages };
  }

  async detail(ownerId: string, id: string): Promise<ConversationDetail> {
    await this.settleOrphans(ownerId, id);
    const row = await this.prisma.client.conversation.findFirst({
      where: { id, ownerId },
      select: {
        ...summarySelect,
        messages: {
          // A question and its answer are written in one transaction, so they
          // share `created_at` (CURRENT_TIMESTAMP is the transaction's start).
          // The enum sorts in declaration order, USER before ASSISTANT.
          orderBy: [{ createdAt: 'asc' }, { role: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            role: true,
            content: true,
            status: true,
            error: true,
            createdAt: true,
            trace: { select: { abstainReason: true } },
            citations: {
              orderBy: { marker: 'asc' },
              select: {
                marker: true,
                chunkId: true,
                documentTitle: true,
                page: true,
                quote: true,
                quoteStart: true,
                quoteEnd: true,
                chunk: { select: { documentId: true } },
              },
            },
          },
        },
      },
    });
    if (row === null) throw new DomainError('NOT_FOUND', 'No such conversation.');
    const messages: MessageView[] = row.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      status: m.status,
      error: m.error,
      abstained: m.trace?.abstainReason != null,
      createdAt: m.createdAt.toISOString(),
      citations: m.citations.map((c) => ({
        marker: c.marker,
        chunkId: c.chunkId,
        documentId: c.chunk?.documentId ?? null,
        documentTitle: c.documentTitle,
        page: c.page,
        quote: c.quote,
        quoteStart: c.quoteStart,
        quoteEnd: c.quoteEnd,
      })),
    }));
    return { ...summaryOf(row), messages };
  }

  /** The finished exchanges the next answer's prompt may carry, oldest first. */
  async history(ownerId: string, conversationId: string): Promise<Exchange[]> {
    const rows = await this.prisma.client.message.findMany({
      where: { ownerId, conversationId },
      // Newest first, the answer before its question (see `detail`), then reversed.
      orderBy: [{ createdAt: 'desc' }, { role: 'desc' }, { id: 'desc' }],
      take: HISTORY_MESSAGES,
      select: {
        role: true,
        status: true,
        content: true,
        trace: { select: { abstainReason: true } },
      },
    });
    return exchangesOf(
      rows.reverse().map((m) => ({
        role: m.role,
        status: m.status,
        content: m.content,
        abstained: m.trace?.abstainReason != null,
      })),
    );
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const { count } = await this.prisma.client.conversation.deleteMany({ where: { id, ownerId } });
    if (count === 0) throw new DomainError('NOT_FOUND', 'No such conversation.');
  }

  /** Settle this conversation's answers that no process is writing any more. Returns how many. */
  async settleOrphans(ownerId: string, conversationId: string): Promise<number> {
    return this.prisma.client.$executeRaw`
      UPDATE "messages"
      SET "status" = 'FAILED', "error" = ${ORPHAN_ERROR}
      WHERE "conversation_id" = ${conversationId}
        AND "owner_id" = ${ownerId}
        AND "status" = 'STREAMING'
        AND "created_at" < now() - make_interval(secs => ${ORPHAN_AFTER_MS / 1000})`;
  }
}
