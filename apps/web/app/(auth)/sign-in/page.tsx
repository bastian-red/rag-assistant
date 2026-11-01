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
    <main id="main" className="page">
      <h1>Sign in to your library</h1>
      <div className="panel">
        <AuthForm next={next} action={signInAction} />
      </div>
      <p className="muted">
        Two demo accounts, each with its own private library:{' '}
        <code translate="no">alma@rag.test</code> and <code translate="no">bruno@rag.test</code>.
        Passwords are in the README.
      </p>
    </main>
  );
}
