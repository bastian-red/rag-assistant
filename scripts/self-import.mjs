#!/usr/bin/env node
/**
 * Bans a workspace package from importing itself by its own name.
 *
 * This exists because of a real one. `packages/db/prisma/seed.mts` imported
 * `createPrismaClient` from `@rag/db`, which is the package it lives in. A
 * package name resolves through `package.json#exports`, which points at `dist/`,
 * and turbo's `^build` builds a task's DEPENDENCIES, never the package itself.
 * So the import worked on every machine that had built once (a stale `dist/`
 * answered it) and failed on the first clean CI runner, in two jobs at once:
 * `tsc` with TS2307 and the seed with ERR_MODULE_NOT_FOUND.
 *
 * The rule: inside a package, reach its own code with a relative path. The
 * package name is for everyone else.
 *
 * Usage:
 *   node scripts/self-import.mjs              scan every workspace
 *   node scripts/self-import.mjs --self-test  run this file's own cases
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The workspace globs from pnpm-workspace.yaml, one level deep each. */
const WORKSPACE_PARENTS = ['apps', 'services', 'packages'];
const WORKSPACE_DIRS = ['e2e'];

const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'generated',
  'coverage',
  'playwright-report',
  'test-results',
]);

/**
 * Module specifiers in import, export-from, dynamic import and require. Comment
 * lines are skipped first, because a doc comment explaining how outsiders import
 * the package (`packages/db/src/client.ts` has one) is not an import.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;

/** @returns {{line: number, specifier: string}[]} */
export function findSelfImports(text, name) {
  const findings = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    for (const match of line.matchAll(SPECIFIER)) {
      const specifier = match[2];
      if (specifier === name || specifier.startsWith(`${name}/`)) {
        findings.push({ line: index + 1, specifier });
      }
    }
  }
  return findings;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(extname(entry.name))) yield full;
  }
}

function workspaces() {
  const dirs = WORKSPACE_DIRS.map((d) => join(ROOT, d));
  for (const parent of WORKSPACE_PARENTS) {
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(ROOT, parent, entry.name));
    }
  }
  return dirs
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => ({
      dir,
      name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name,
    }));
}

const NAME = '@rag/db';
const SELF_TESTS = [
  {
    // The exact bug this file exists for.
    name: 'a named import of the package itself is caught',
    text: "import { createPrismaClient } from '@rag/db';\n",
    expected: 1,
  },
  {
    name: 'a subpath of the package is caught',
    text: "import x from '@rag/db/errors';\n",
    expected: 1,
  },
  { name: 'a dynamic import is caught', text: "const m = await import('@rag/db');\n", expected: 1 },
  { name: 'a require is caught', text: 'const m = require("@rag/db");\n', expected: 1 },
  { name: 'a re-export is caught', text: "export * from '@rag/db';\n", expected: 1 },
  {
    name: 'a relative import passes',
    text: "import { a } from '../src/client.ts';\n",
    expected: 0,
  },
  {
    name: 'another workspace package passes',
    text: "import { b } from '@rag/shared';\n",
    expected: 0,
  },
  {
    name: 'a package whose name merely starts the same passes',
    text: "import { c } from '@rag/dbx';\n",
    expected: 0,
  },
  {
    name: 'a doc comment showing how outsiders import it passes',
    text: " *     see, so `import { createPrismaClient } from '@rag/db'` works from ESM.\n",
    expected: 0,
  },
  {
    name: 'reports the 1-based line',
    text: "// ok\nimport { a } from './a';\nimport { d } from '@rag/db';\n",
    expected: 1,
    check: (findings) => findings[0].line === 3,
  },
];

function selfTest() {
  let failed = 0;
  for (const testCase of SELF_TESTS) {
    const findings = findSelfImports(testCase.text, NAME);
    const ok = findings.length === testCase.expected && (testCase.check?.(findings) ?? true);
    if (!ok) {
      failed += 1;
      process.stderr.write(
        `  ✖ ${testCase.name}\n    expected ${testCase.expected} finding(s), got ${findings.length}\n`,
      );
    }
  }
  if (failed > 0) {
    process.stderr.write(`\nSelf-import scanner self-test: ${failed} case(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write(`Self-import scanner self-test: ${SELF_TESTS.length} cases pass.\n`);
}

function scan() {
  let files = 0;
  const violations = [];
  const packages = workspaces();
  for (const { dir, name } of packages) {
    for (const file of walk(dir)) {
      files += 1;
      for (const finding of findSelfImports(readFileSync(file, 'utf8'), name)) {
        violations.push({ file: relative(ROOT, file), name, ...finding });
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write('Packages importing themselves by name:\n\n');
    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${v.line}  '${v.specifier}' inside ${v.name}\n`);
    }
    process.stderr.write(
      `\n${violations.length} violation(s). A package name resolves to its dist/, which a\n` +
        'clean checkout has not built. Use a relative path to the source instead.\n',
    );
    process.exit(1);
  }

  process.stdout.write(`No self-imports: ${files} files in ${packages.length} workspaces clean.\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  if (process.argv.includes('--self-test')) selfTest();
  else scan();
}
