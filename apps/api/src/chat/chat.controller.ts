/**
 * `POST /chat/:conversationId/messages`: ask, and read the answer as it is
 * written (stream contract v1 in @rag/shared, `chat.ts`).
 *
 * Everything that can be refused is refused BEFORE the stream starts, as an
 * ordinary JSON error: a bad body (400), a conversation that is not yours
 * (404), an answer already being written in it (409), the chat budget (429).
 * Once the 200 and the event-stream headers are out, a failure can only be
 * an `error` event, so nothing that can be checked first is left for then.
 *
 * The reader stops a generation by closing the request. `close` on the
 * response before it was ended is that signal: it aborts the run, which
 * aborts the model call, and the answer is stored STOPPED with what was sent
 * (SPECS #5). Nothing is written after that.
 */
import { Body, Controller, Param, Post, Res } from '@nestjs/common';
import type { AnswerEvent } from '@rag/answer';
import {
  CHAT_STREAM_VERSION,
  NOT_FOUND_ANSWER,
  idSchema,
  sendMessageSchema,
  sseFrame,
  type ChatStreamEvent,
  type SendMessage,
  type SessionUser,
} from '@rag/shared';
import type { Response } from 'express';

import { CurrentUser } from '../common/session.guard';
import { Budget } from '../common/throttle';
import { ZodPipe } from '../common/zod.pipe';
import { ChatService, type Begun } from './chat.service';

/** A comment line this often keeps a proxy from closing a stream while a CPU model reads the prompt. */
export const HEARTBEAT_MS = 15_000;

/** An answer event as the wire carries it. */
export function wireEvent(
  begun: Pick<Begun, 'questionId' | 'answerId'>,
  event: AnswerEvent,
): ChatStreamEvent {
  switch (event.type) {
    case 'retrieval':
      return {
        event: 'retrieval',
        data: {
          version: CHAT_STREAM_VERSION,
          questionId: begun.questionId,
          answerId: begun.answerId,
          sources: event.sources,
          staleDocuments: event.staleDocuments,
        },
      };
    case 'token':
      return { event: 'token', data: { text: event.text } };
    case 'citation':
      return {
        event: 'citation',
        data: { marker: event.marker, documentId: event.documentId, chunkId: event.chunkId },
      };
    case 'abstain':
      return {
        event: 'abstain',
        data: {
          text: NOT_FOUND_ANSWER,
          reason: event.reason,
          bestSimilarity:
            event.bestSimilarity === null ? null : Math.min(1, Math.max(-1, event.bestSimilarity)),
          nearest: event.nearest,
        },
      };
  }
}

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Budget('chat')
  @Post(':conversationId/messages')
  async send(
    @CurrentUser() user: SessionUser,
    @Param('conversationId', new ZodPipe(idSchema)) conversationId: string,
    @Body(new ZodPipe(sendMessageSchema)) body: SendMessage,
    @Res() response: Response,
  ): Promise<void> {
    const begun = await this.chat.begin(user.id, conversationId, body.content);

    response.status(200).set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx and similar proxies buffer a response unless told not to.
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();

    const stop = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) stop.abort();
    });
    const open = () => !stop.signal.aborted && !response.writableEnded;
    const write = (event: ChatStreamEvent) => {
      if (open()) response.write(sseFrame(event));
    };
    const heartbeat = setInterval(() => {
      if (open()) response.write(': ping\n\n');
    }, HEARTBEAT_MS);

    try {
      const outcome = await this.chat.run(begun, {
        signal: stop.signal,
        emit: (event) => write(wireEvent(begun, event)),
      });
      const citations = await this.chat.finish(begun, outcome);
      if (citations === null) {
        // The conversation was deleted while the answer was written: nothing
        // was stored, and the reader must not be told it was.
        write({
          event: 'error',
          data: {
            code: 'failed',
            message: 'The conversation was deleted while this answer was written.',
          },
        });
      } else if (outcome.status === 'DONE') {
        write({
          event: 'done',
          data: {
            answerId: begun.answerId,
            citations,
            dropped: outcome.dropped.map((d) => ({ raw: d.raw, labels: [...d.labels] })),
            usage: outcome.usage,
            timings: outcome.timings,
          },
        });
      } else if (outcome.status === 'FAILED') {
        if (outcome.failure?.code === 'internal') {
          console.error('[chat] answer failed', outcome.failure.cause);
        }
        write({
          event: 'error',
          data: {
            code: outcome.failure?.code ?? 'internal',
            message: outcome.failure?.message ?? 'Something went wrong while answering.',
          },
        });
      }
    } catch (error) {
      // `finish` failed (the database went away mid-answer): never leave the
      // row STREAMING, and never put the error's text on the wire.
      console.error('[chat] could not store the answer', error);
      await this.chat
        .abandon(begun, 'The answer could not be saved.')
        .catch((again: unknown) => console.error('[chat] could not mark the answer failed', again));
      write({
        event: 'error',
        data: { code: 'internal', message: 'The answer could not be saved.' },
      });
    } finally {
      clearInterval(heartbeat);
      if (!response.writableEnded) response.end();
    }
  }
}
