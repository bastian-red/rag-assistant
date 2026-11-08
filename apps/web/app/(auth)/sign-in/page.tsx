import Link from 'next/link';

import { AuthForm } from '../../../components/auth-form';
import { safeNextPath } from '../../../lib/next-path';
import { signInAction } from '../actions';

export const metadata = { title: 'Sign in', robots: { index: false } };

/**
 * Sign in to your library. `next` is where a deep link was going; it is
 * validated here and again in the action, so a crafted value can only ever
 * land on a path of this site.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  return (
    <main id="main" className="page page-narrow">
      <h1>Sign in to your library</h1>
      <div className="panel">
        <AuthForm next={next} action={signInAction} />
      </div>
      <p>
        New here? <Link href="/sign-up">Create an account</Link>
      </p>
      {/*
        Local demo accounts on a local database, already published in the
        README; printed here so trying the app needs no second tab
        (UX-AUDIT #12). The app is never deployed, so these logins
        only ever open a reader's own local copy.
      */}
      <section aria-labelledby="demo-heading" className="demo">
        <h2 id="demo-heading">Demo accounts</h2>
        <p className="muted">Each has its own private library.</p>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Password</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code translate="no">alma@rag.test</code>
              </td>
              <td>
                <code translate="no">alma-password-2026</code>
              </td>
            </tr>
            <tr>
              <td>
                <code translate="no">bruno@rag.test</code>
              </td>
              <td>
                <code translate="no">bruno-password-2026</code>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  );
}
