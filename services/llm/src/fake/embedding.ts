/**
 * The fake's embeddings: deterministic feature hashing, so the lanes with no
 * model (integration, E2E, the retrieval bench) still rank by meaning-ish.
 *
 * Each lower-cased word, and each adjacent word pair at half weight, adds a
 * signed 1 to one dimension (FNV-1a picks the dimension, a second seed picks
 * the sign, so collisions cancel instead of piling up). The vector is then
 * L2-normalised, like the real model's. Texts sharing words have a positive
 * cosine; texts sharing none sit near zero. A text with no words gets a fixed
 * unit vector rather than zeros: cosine against a zero vector is undefined,
 * and pgvector answers NaN.
 *
 * A query written in Qwen3-Embedding's instruction format
 * (`Instruct: <task>\nQuery: <query>`) is embedded as its query alone. The
 * real model is trained to read the instruction as a task, not as content;
 * hashing its words would make every question look alike to the fake.
 */
const INSTRUCTION = /^Instruct: [^\n]*\nQuery: /u;

function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const WORD = /[\p{L}\p{N}]+/gu;

export function hashEmbedding(text: string, dimensions = 1024): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new RangeError(`dimensions must be a positive integer, got ${String(dimensions)}`);
  }
  const vector = new Array<number>(dimensions).fill(0);
  const words = text.replace(INSTRUCTION, '').normalize('NFC').toLowerCase().match(WORD) ?? [];
  const add = (feature: string, weight: number) => {
    const sign = (fnv1a(feature, 0x01000193) & 1) === 0 ? 1 : -1;
    vector[fnv1a(feature) % dimensions]! += sign * weight;
  };
  words.forEach((word, i) => {
    add(word, 1);
    if (i > 0) add(`${words[i - 1]!} ${word}`, 0.5);
  });
  const norm = Math.hypot(...vector);
  if (norm === 0) {
    vector[fnv1a(text) % dimensions] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}
