/**
 * Progress for a long eval phase: percent, rate and ETA computed from counts
 * (never estimated by eye), appended to /tmp/rag-eval/progress.log and printed.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const PROGRESS_LOG = '/tmp/rag-eval/progress.log';

/** One progress line; pure, so its arithmetic is tested. */
export function progressLine(
  title: string,
  done: number,
  total: number,
  elapsedSeconds: number,
  at: Date,
  note = '',
): string {
  const rate = done / Math.max(elapsedSeconds, 0.001);
  const eta = done === 0 ? 'ETA unknown' : `ETA ${String(Math.round((total - done) / rate))} s`;
  const percent = total === 0 ? 100 : Math.round((done / total) * 100);
  return `${at.toISOString()} ${title}: ${String(percent)}% (${String(done)}/${String(total)}), ${eta}, ${(rate * 60).toFixed(1)}/min${note === '' ? '' : `, ${note}`}`;
}

export function progress(title: string, log = PROGRESS_LOG) {
  mkdirSync(dirname(log), { recursive: true });
  const started = Date.now();
  return (done: number, total: number, note = '') => {
    const line = progressLine(title, done, total, (Date.now() - started) / 1000, new Date(), note);
    appendFileSync(log, `${line}\n`);
    console.info(line);
  };
}
