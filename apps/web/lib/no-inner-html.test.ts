/**
 * `dangerouslySetInnerHTML` does not appear in this app.
 *
 * An answer is where it is most tempting: the model writes markdown, and the
 * passages it quotes come from documents a user uploaded. From build step 9
 * the sanitized markdown tree is turned into React elements (hast to JSX),
 * never into an HTML string, so this gate stays absolute rather than growing an
 * allowlist of "trusted" files that a later edit quietly widens.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, '..');

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/u.test(path) && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('no raw HTML injection', () => {
  it('no component sets innerHTML', () => {
    const files = ['app', 'components', 'lib'].flatMap((dir) => walk(join(WEB, dir)));
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((file) =>
      /dangerouslySetInnerHTML|\.innerHTML\s*=/u.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => file.slice(WEB.length + 1))).toEqual([]);
  });
});
