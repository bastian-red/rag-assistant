import Link from 'next/link';

/**
 * One answer for "does not exist" and "not yours to see". Another user's
 * document is indistinguishable from one that never existed, by design.
 */
export default function NotFound() {
  return (
    <main id="main" className="page">
      <h1>Nothing here</h1>
      <p className="muted">That page does not exist, or it is not yours to see.</p>
      <Link href="/">Back to your library</Link>
    </main>
  );
}
