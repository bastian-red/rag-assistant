/**
 * One question asked in a conversation: stored, answered, stored again.
 *
 *   begin   the question (DONE) and an empty STREAMING answer, in one
 *           transaction; 409 while another answer in the conversation is
 *           being written
 *   run     `answer()` from @rag/answer over this person's retrieval scope
 *   finish  the answer's text and status, its citations and its trace, in
 *           one transaction
 *
 * Retrieval is scoped to the asking person (and the conversation's
 * collection) inside its SQL, so the prompt can only ever hold their own
 * passages (SPECS #3). Citations are stored against chunks locked with
 * `FOR KEY SHARE` in the same transaction: a document deleted while the
 * answer streamed has no chunks left, and its citations keep their copied
 * title, page and quote with `chunk_id` null instead of failing the write.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  answer,
  PROMPT_VERSION,
  type AnswerEvent,
  type AnswerOutcome,
  type Exchange,
} from '@rag/answer';
import { ONE_STREAMING_ANSWER, Prisma, violatedUniqueIndex } from '@rag/db';
import { createLlm, type Ollama } from '@rag/llm';
import { cachedSpace, retrieve, retrievalOptions } from '@rag/retrieval';
import { DomainError, titleFromQuestion, type CitationView, type LlmClient } from '@rag/shared';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { ConversationsService } from '../conversations/conversations.service';
import { OLLAMA } from '../infra/infra.module';
import { PrismaService } from '../infra/prisma.service';

export interface Begun {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly collectionId: string | null;
  readonly question: string;
  readonly questionId: string;
  readonly answerId: string;
  readonly history: readonly Exchange[];
}

const clamp = (n: number | null) => (n === null ? null : Math.min(1, Math.max(-1, n)));

@Injectable()
export class ChatService {
  private readonly llm: LlmClient;
  private readonly space: () => Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(OLLAMA) ollama: Ollama,
  ) {
    this.llm = createLlm(
      { baseUrl: config.ollamaUrl, chatModel: config.chatModel, embedModel: config.embedModel },
      ollama,
    );
    this.space = cachedSpace(() => this.llm.embeddingSpace());
  }

  /** The retrieval options this process runs with: the measured defaults, or the lane's threshold. */
  options() {
    return retrievalOptions(
      this.config.minSimilarity === null ? {} : { minSimilarity: this.config.minSimilarity },
    );
  }

  async begin(ownerId: string, conversationId: string, question: string): Promise<Begun> {
    const conversation = await this.conversations.owned(ownerId, conversationId);
    const history = await this.conversations.history(ownerId, conversationId);
    const write = () =>
      this.prisma.client.$transaction(async (tx) => {
        const asked = await tx.message.create({
          data: { ownerId, conversationId, role: 'USER', content: question, status: 'DONE' },
          select: { id: true },
        });
        const reply = await tx.message.create({
          data: {
            ownerId,
            conversationId,
            role: 'ASSISTANT',
            content: '',
            status: 'STREAMING',
            model: this.config.chatModel,
          },
          select: { id: true },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            updatedAt: new Date(),
            ...(conversation.messages === 0 ? { title: titleFromQuestion(question) } : {}),
          },
        });
        return { questionId: asked.id, answerId: reply.id };
      });

    const busy = () =>
      new DomainError(
        'CONFLICT',
        'An answer is still being written in this conversation. Stop it or wait for it.',
      );
    // An answer a dead process left behind is settled first; a live one is
    // refused without trying the insert (a failed insert is logged by the
    // client as an error, and a 409 is not one). Two requests racing past
    // this check still meet the unique index, and the loser gets the same 409.
    await this.conversations.settleOrphans(ownerId, conversationId);
    const streaming = await this.prisma.client.message.count({
      where: { conversationId, ownerId, status: 'STREAMING' },
    });
    if (streaming > 0) throw busy();
    let ids: { questionId: string; answerId: string };
    try {
      ids = await write();
    } catch (error) {
      if (violatedUniqueIndex(error, ONE_STREAMING_ANSWER)) throw busy();
      throw error;
    }
    return {
      ownerId,
      conversationId,
      collectionId: conversation.collectionId,
      question,
      ...ids,
      history,
    };
  }

  run(
    begun: Begun,
    options: { signal: AbortSignal; emit: (event: AnswerEvent) => void },
  ): Promise<AnswerOutcome> {
    const retrievalOverrides = this.options();
    return answer(
      {
        chat: (messages, chatOptions) => this.llm.chat(messages, chatOptions),
        retrieve: (query) =>
          retrieve(
            {
              prisma: this.prisma.client,
              embed: (texts) => this.llm.embed(texts),
              embeddingSpace: this.space,
            },
            { ownerId: begun.ownerId, query, collectionId: begun.collectionId },
            retrievalOverrides,
          ),
      },
      { question: begun.question, history: begun.history },
      options,
    );
  }

  /**
   * Store the outcome. Returns the stored citations, or null when the answer
   * row is gone (the conversation was deleted while it streamed).
   */
  async finish(begun: Begun, outcome: AnswerOutcome): Promise<CitationView[] | null> {
    const documentOf = new Map(
      (outcome.retrieval?.sources ?? []).map((s) => [s.marker, s.documentId]),
    );
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.message.updateMany({
        where: { id: begun.answerId, ownerId: begun.ownerId, status: 'STREAMING' },
        data: {
          content: outcome.content,
          status: outcome.status,
          error:
            outcome.status === 'FAILED' ? (outcome.failure?.message ?? 'The answer failed.') : null,
        },
      });
      if (updated.count === 0) return null;

      const cited = [...new Set(outcome.citations.map((c) => c.chunkId))];
      const alive = new Set(
        cited.length === 0
          ? []
          : (
              await tx.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "chunks"
                WHERE "id" IN (${Prisma.join(cited)}) AND "owner_id" = ${begun.ownerId}
                FOR KEY SHARE`
            ).map((r) => r.id),
      );
      const citations: CitationView[] = outcome.citations.map((c) => {
        const live = alive.has(c.chunkId);
        return {
          marker: c.marker,
          chunkId: live ? c.chunkId : null,
          documentId: live ? (documentOf.get(c.marker) ?? null) : null,
          documentTitle: c.documentTitle,
          page: c.page,
          quote: c.quote,
          quoteStart: c.quoteStart,
          quoteEnd: c.quoteEnd,
        };
      });
      if (citations.length > 0) {
        await tx.citation.createMany({
          data: citations.map((c) => ({
            ownerId: begun.ownerId,
            messageId: begun.answerId,
            marker: c.marker,
            chunkId: c.chunkId,
            documentTitle: c.documentTitle,
            page: c.page,
            quote: c.quote,
            quoteStart: c.quoteStart,
            quoteEnd: c.quoteEnd,
          })),
        });
      }

      const retrieval = outcome.retrieval;
      if (retrieval !== null) {
        await tx.retrievalTrace.create({
          data: {
            ownerId: begun.ownerId,
            messageId: begun.answerId,
            query: retrieval.query,
            candidates: retrieval.candidates as unknown as Prisma.InputJsonValue,
            latencyMs: outcome.timings.totalMs,
            embedModel: retrieval.space,
            chatModel: this.config.chatModel,
            abstainReason: retrieval.abstained ? retrieval.reason : null,
            bestSimilarity: clamp(retrieval.bestSimilarity),
            dropped: outcome.dropped as unknown as Prisma.InputJsonValue,
            details: {
              status: outcome.status,
              failure: outcome.failure?.code ?? null,
              mode: retrieval.mode,
              minSimilarity: this.options().minSimilarity,
              promptVersion: PROMPT_VERSION,
              historyExchanges: outcome.prompt?.historyExchanges ?? 0,
              promptTokens: outcome.prompt?.tokens ?? null,
              sources: retrieval.sources.map((s) => ({ marker: s.marker, chunkIds: s.chunkIds })),
              skipped: retrieval.skipped,
              staleDocuments: retrieval.staleDocuments,
              timings: { retrieval: retrieval.timings, answer: outcome.timings },
              usage: outcome.usage,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }
      await tx.conversation.updateMany({
        where: { id: begun.conversationId, ownerId: begun.ownerId },
        data: { updatedAt: new Date() },
      });
      return citations;
    });
  }

  /** The last resort when `finish` itself failed: the row must not stay STREAMING. */
  async abandon(begun: Begun, message: string): Promise<void> {
    await this.prisma.client.message.updateMany({
      where: { id: begun.answerId, ownerId: begun.ownerId, status: 'STREAMING' },
      data: { status: 'FAILED', error: message },
    });
  }
}
