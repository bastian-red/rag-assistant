import Link from 'next/link';

import { SignUpForm } from '../../../components/sign-up-form';
import { signUpAction } from '../actions';

export const metadata = { title: 'Create an account', robots: { index: false } };

/** A new, private library: one empty collection to drop the first file into. */
export default function SignUpPage() {
  return (
    <main id="main" className="page">
      <h1>Create your library</h1>
      <div className="panel">
        <SignUpForm action={signUpAction} />
      </div>
      <p>
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </main>
  );
}
