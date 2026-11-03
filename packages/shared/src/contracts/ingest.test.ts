import { describe, expect, it } from 'vitest';

import { LIMITS } from '../constants';
import {
  documentTitle,
  ingestChannel,
  ingestEventSchema,
  ingestJobOptions,
  ingestJobSchema,
  safeFilename,
} from './ingest';

const ID = 'cmvyipu990000jh1klg0198zp';

describe('documentTitle', () => {
  it('takes the first non-blank line of a text, without a heading mark', () => {
    expect(documentTitle('a.md', '\n\n#  Boiler   manual\nbody')).toBe('Boiler manual');
    expect(documentTitle('a.txt', '\uFEFFPlain first line\nsecond')).toBe('Plain first line');
  });

  it('falls back to the file name without its extension', () => {
    expect(documentTitle('Heat pump.pdf', null)).toBe('Heat pump');
    expect(documentTitle('notes.md', '   \n  ')).toBe('notes');
    expect(documentTitle('.env', null)).toBe('.env');
  });

  it('never exceeds the limit or ends in a space', () => {
    const long = `${'word '.repeat(100)}`;
    const title = documentTitle('a.md', long);
    expect([...title].length).toBeLessThanOrEqual(LIMITS.documentTitle);
    expect(title).toBe(title.trim());
    // A cut through an astral character keeps it whole.
    const astral = documentTitle('a.md', '\u{1F600}'.repeat(300));
    expect([...astral]).toHaveLength(LIMITS.documentTitle);
  });
});

describe('safeFilename', () => {
  it('keeps the last path segment and drops control characters', () => {
    expect(safeFilename('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('a\u0007b.md')).toBe('ab.md');
    expect(safeFilename('   ')).toBe('upload');
    expect([...safeFilename(`${'x'.repeat(300)}.md`)]).toHaveLength(255);
  });
});

describe('the ingest contract', () => {
  it('refuses a job with extra fields or a bad hash', () => {
    const job = { documentId: ID, ownerId: ID, sha256: 'a'.repeat(64) };
    expect(ingestJobSchema.parse(job)).toEqual(job);
    expect(() => ingestJobSchema.parse({ ...job, sha256: 'A'.repeat(64) })).toThrow();
    expect(() => ingestJobSchema.parse({ ...job, extra: 1 })).toThrow();
  });

  it('refuses progress past its total', () => {
    const event = {
      documentId: ID,
      collectionId: ID,
      status: 'EMBEDDING',
      progress: { done: 3, total: 2 },
      error: null,
      at: new Date(0).toISOString(),
    };
    expect(() => ingestEventSchema.parse(event)).toThrow(/done must not exceed total/u);
  });

  it('names one channel per owner and refuses anything that is not an id', () => {
    expect(ingestChannel(ID)).toBe(`ingest:events:${ID}`);
    expect(() => ingestChannel('*')).toThrow();
  });
});

describe('ingestJobOptions', () => {
  it('names the job by its document and hands out a copy each time', () => {
    const a = ingestJobOptions(ID);
    expect(a).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
      jobId: ID,
    });
    a.backoff.delay = 1;
    expect(ingestJobOptions(ID).backoff.delay).toBe(5000);
    // BullMQ refuses a custom id with a colon; an id never has one.
    expect(() => ingestJobOptions('a:b')).toThrow();
  });
});
