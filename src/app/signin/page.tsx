import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { SignInForm } from '@/app/_components/sign-in-form';

export const dynamic = 'force-dynamic';

/** Only allow same-origin, single-slash paths as redirect targets (no open redirect). */
function safeNext(raw: string | undefined): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/';
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: rawNext } = await searchParams;
  const next = safeNext(rawNext);

  // Already signed in — no reason to show the gate.
  if (await getSession()) redirect(next);

  return (
    <section className="detail">
      <div className="wrap auth-wrap">
        <span className="eyebrow" style={{ display: 'block' }}>
          Sworn entry
        </span>
        <h1>Hold the door.</h1>
        <p className="about" style={{ marginTop: 14 }}>
          Sign in to back projects, deliver them, and read the ravens sent to you.
        </p>
        <SignInForm next={next} />
      </div>
    </section>
  );
}
