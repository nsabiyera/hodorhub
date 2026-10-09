import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { RegisterForm } from '@/app/_components/register-form';

export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  // Already signed in — no reason to register again.
  if (await getSession()) redirect('/');

  return (
    <section className="detail">
      <div className="wrap auth-wrap">
        <span className="eyebrow" style={{ display: 'block' }}>
          Take the oath
        </span>
        <h1>Join the watch.</h1>
        <p className="about" style={{ marginTop: 14 }}>
          Register your organisation. Charities post the help they need; companies deliver it with
          donated employee time.
        </p>
        <RegisterForm />
      </div>
    </section>
  );
}
