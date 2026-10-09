import { ForgotPasswordForm } from '@/app/_components/forgot-password-form';

export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  return (
    <section className="detail">
      <div className="wrap auth-wrap">
        <span className="eyebrow" style={{ display: 'block' }}>
          Lost the word
        </span>
        <h1>Reset your password.</h1>
        <p className="about" style={{ marginTop: 14 }}>
          Enter your email and we&rsquo;ll send a link to set a new one.
        </p>
        <ForgotPasswordForm />
      </div>
    </section>
  );
}
