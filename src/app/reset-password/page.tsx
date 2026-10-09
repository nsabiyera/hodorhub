import { ResetPasswordForm } from '@/app/_components/reset-password-form';

export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <section className="detail">
      <div className="wrap auth-wrap">
        <span className="eyebrow" style={{ display: 'block' }}>
          A new word
        </span>
        <h1>Set a new password.</h1>
        <p className="about" style={{ marginTop: 14 }}>
          Choose a new password for your account.
        </p>
        <ResetPasswordForm token={token ?? null} />
      </div>
    </section>
  );
}
