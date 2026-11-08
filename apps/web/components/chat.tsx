'use client';

import type { ChatStreamEvent } from '@rag/shared';
import { LIMITS } from '@rag/shared/constants';
import { createSseParser } from '@rag/shared/sse';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { spokenAnswer } from '../lib/answer';
import { dayWords } from '../lib/dates';
import {
  applyEvent,
  chipTarget,
  failTurn,
  pageWords,
  startTurn,
  stopTurn,
  type Turn,
} from '../lib/chat-state';
import { passageHref } from '../lib/passage';
import { nearestTickets, TICKET_STATE_WORDS, ticketsOf, type TicketRow } from '../lib/tickets';
import { AnswerText } from './answer-text';

interface Props {
  readonly conversationId: string;
  readonly turns: readonly Turn[];
  /** "“Home”" or "your whole library": what the question is asked over. */
  readonly scope: string;
  /** What each slip is stamped with: "Home", "Whole library". */
  readonly stamp: string;
}

const NOT_FOUND = 'Not found in your documents.';

/**
 * A `[Sn]` marker in the answer: the ticket's number, set superscript, a
 * 24 px target (UX-AUDIT #7: the old boxed chip read as a form field and was
 * 20 px tall). Its number is the ticket's number, so they read as one object.
 */
function Chip({ turn, marker }: { readonly turn: Turn; readonly marker: number }) {
  const target = chipTarget(turn, marker);
  if (target.kind === 'unknown') return <span className="chip">{`[S${String(marker)}]`}</span>;
  if (target.kind === 'gone') {
    return (
      <span className="chip" data-gone="true">
        {marker}
        <span className="visually-hidden">
          {` (source ${String(marker)}, ${target.title}, since deleted)`}
        </span>
      </span>
    );
  }
  const page = pageWords(target.page);
  return (
    <Link
      className="chip"
      href={passageHref(target)}
      aria-label={`Source ${String(marker)}: ${target.title}${page === null ? '' : `, ${page}`}`}
      data-testid="citation-chip"
    >
      {marker}
    </Link>
  );
}

/**
 * The returned tickets (docs/DESIGN.md, the signature): what the desk pulled,
 * numbered, before the answer says a word. Live rows drop in one by one in
 * number order (CSS, stilled under reduced motion); stored rows are the cited
 * passages and do not animate.
 */
function Tickets({ row, live }: { readonly row: TicketRow; readonly live: boolean }) {
  return (
    <section
      className="tickets"
      aria-label={`${row.label}: ${row.count}`}
      data-live={live}
      data-testid="tickets"
    >
      <h3 className="tickets-label">
        {row.label} <span className="tickets-count">· {row.count}</span>
      </h3>
      <ol className="ticket-list">
        {row.tickets.map((ticket) => {
          const state = TICKET_STATE_WORDS[ticket.state];
          const head = (
            <>
              <span className="ticket-no num">
                <span className="visually-hidden">Source </span>
                {ticket.marker}
                <span className="visually-hidden">: </span>
              </span>
              <span className="ticket-title">{ticket.title}</span>
            </>
          );
          return (
            <li
              key={ticket.marker}
              className="ticket"
              data-state={ticket.state}
              data-testid="ticket"
            >
              {ticket.href === null ? (
                <span className="ticket-head">{head}</span>
              ) : (
                <Link className="ticket-head" href={ticket.href}>
                  {head}
                </Link>
              )}
              {ticket.where === null ? null : <span className="ticket-where">{ticket.where}</span>}
              <span className="ticket-excerpt">{ticket.excerpt}</span>
              {state === null ? null : (
                <span className="ticket-state" data-testid="ticket-state">
                  <span aria-hidden="true">{state.glyph} </span>
                  {state.word}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TurnView({ turn, stamp }: { readonly turn: Turn; readonly stamp: string }) {
  const row = ticketsOf(turn);
  const nearest = turn.abstained === null ? null : nearestTickets(turn.abstained.nearest);
  return (
    <article className="turn" data-testid="turn" data-status={turn.status}>
      <div className="slip">
        <p className="slip-label" aria-hidden="true">
          Call slip
        </p>
        {/* A heading per question, so a long conversation is navigable by its questions. */}
        <h2 className="question">
          <span className="visually-hidden">You asked: </span>
          {turn.question}
        </h2>
        <p className="stamp">
          <span className="visually-hidden">Asked of </span>
          {stamp}
          <span aria-hidden="true"> · </span>
          <span className="visually-hidden">, on </span>
          <time dateTime={turn.askedAt}>{dayWords(turn.askedAt)}</time>
        </p>
      </div>
      {turn.status === 'searching' ? (
        <p className="muted searching" data-testid="searching">
          <span aria-hidden="true">◌ </span>Searching your documents…
        </p>
      ) : null}
      {row === null ? null : <Tickets row={row} live={turn.sources.length > 0} />}
      {turn.staleDocuments > 0 ? (
        <p className="muted">
          {turn.staleDocuments === 1
            ? '1 document is being re-indexed and was not searched.'
            : `${String(turn.staleDocuments)} documents are being re-indexed and were not searched.`}
        </p>
      ) : null}
      <div className="answer" data-testid="answer">
        {turn.abstained !== null ? (
          <p className="abstain">
            <span aria-hidden="true">∅ </span>
            {NOT_FOUND} Nothing in reach was close enough to answer from.
          </p>
        ) : (
          <AnswerText
            text={turn.text}
            marker={(marker, key) => <Chip key={key} turn={turn} marker={marker} />}
          />
        )}
      </div>
      {nearest === null ? null : <Tickets row={nearest} live />}
      {turn.status === 'stopped' ? (
        <p className="status-word" data-testid="stopped">
          <span aria-hidden="true">■ </span>Stopped. The text above is what was written before you
          stopped it.
        </p>
      ) : null}
      {turn.status === 'failed' && turn.error !== null ? (
        <p className="status-word" data-state="danger" data-testid="answer-error">
          <span aria-hidden="true">⚠ </span>
          {turn.error}
        </p>
      ) : null}
    </article>
  );
}

/**
 * Ask, and watch the answer arrive: the returned tickets first, then the
 * words, each `[Sn]` a superscript ticket number that opens its passage. Stop keeps what was written (the API
 * stores the same text as STOPPED).
 *
 * The stream is read with fetch, not EventSource, because the request has a
 * body. Frames are parsed with the zod-free SSE parser; this app's server
 * already validated every event against contract v1 on its way through
 * (`lib/upstream.ts`). The finished answer is announced once, politely: a
 * live region over the streaming text would read every three characters.
 */
export function Chat({ conversationId, turns: initial, scope, stamp }: Props) {
  const router = useRouter();
  const [turns, setTurns] = useState<readonly Turn[]>(initial);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const controller = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const counter = useRef(0);

  useEffect(() => () => controller.current?.abort(), []);

  async function ask(text: string) {
    counter.current += 1;
    // The turn lives here and is copied into state after every change: reading
    // it back out of a state updater is not safe, React may run that later.
    let turn = startTurn(text, `pending-${String(counter.current)}`, new Date().toISOString());
    const show = (next: Turn) => {
      turn = next;
      setTurns((current) => current.map((t, i) => (i === current.length - 1 ? next : t)));
    };
    // The API names a conversation after its first question, as it stores it.
    let retitle = turns.length === 0;
    setTurns((current) => [...current, turn]);
    setQuestion('');
    setBusy(true);
    setAnnouncement('Searching your documents.');
    const abort = new AbortController();
    controller.current = abort;
    try {
      const response = await fetch(`/api/chat/${conversationId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }),
        signal: abort.signal,
      });
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || response.body === null || !type.startsWith('text/event-stream')) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        const message =
          response.status === 429
            ? 'Too many questions in a minute. Wait a moment and ask again.'
            : (body?.message ?? `The question could not be sent (${String(response.status)}).`);
        show(failTurn(turn, message));
        setAnnouncement(message);
        return;
      }
      const parser = createSseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const data = JSON.parse(frame.data) as unknown;
          show(applyEvent(turn, { event: frame.event, data } as ChatStreamEvent));
          if (retitle && frame.event === 'retrieval') {
            // The question is stored by now, so the server's heading has its
            // title. Once, early: a refresh still in flight when the reader
            // stops or leaves is cut off and Next falls back to a full load.
            retitle = false;
            router.refresh();
          }
        }
      }
      if (turn.status === 'answering' || turn.status === 'searching') {
        // The stream closed without `done`: the server went away mid-answer.
        show(failTurn(turn, 'The answer ended before it finished.'));
      }
      if (turn.status === 'done') {
        setAnnouncement(turn.abstained !== null ? NOT_FOUND : `Answer: ${spokenAnswer(turn.text)}`);
      } else if (turn.error !== null) {
        setAnnouncement(turn.error);
      }
    } catch {
      if (abort.signal.aborted) {
        show(stopTurn(turn));
        setAnnouncement('Stopped.');
      } else {
        const message = 'The connection dropped before the answer finished.';
        show(failTurn(turn, message));
        setAnnouncement(message);
      }
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (text === '' || busy) return;
    void ask(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function stop() {
    controller.current?.abort();
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
  }, [turns.length]);

  return (
    <>
      <div className="turns" data-testid="turns">
        {turns.length === 0 ? (
          <p className="muted" data-testid="no-turns">
            Ask anything about {scope}. Every answer names the passages it came from.
          </p>
        ) : (
          turns.map((turn) => <TurnView key={turn.key} turn={turn} stamp={stamp} />)
        )}
        <div ref={endRef} />
      </div>
      <form className="composer slip" onSubmit={onSubmit}>
        <label className="field">
          <span className="slip-label">Your question</span>
          <textarea
            className="field-input"
            name="question"
            rows={3}
            required
            maxLength={LIMITS.question}
            value={question}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            placeholder={`Ask about ${scope}…`}
          />
        </label>
        <div className="composer-foot">
          <p className="stamp">
            <span className="visually-hidden">Asked of </span>
            {stamp}
          </p>
          {/* Only where there is a keyboard to press them (UX-AUDIT #6). */}
          <span className="keys-hint muted">Enter to ask, Shift+Enter for a new line.</span>
          {busy ? (
            <button className="button" type="button" onClick={stop} data-testid="stop">
              <span aria-hidden="true">■ </span>Stop
            </button>
          ) : (
            <button
              className="button button-primary"
              type="submit"
              disabled={question.trim() === ''}
            >
              Ask
            </button>
          )}
        </div>
      </form>
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="announcer">
        {announcement}
      </p>
    </>
  );
}
