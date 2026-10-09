import { VerifyEmailForm } from '@/app/_components/verify-email-form';

export const dynamic = 'force-dynamic';

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <section className="detail">
      <div className="wrap auth-wrap">
        <span className="eyebrow" style={{ display: 'block' }}>
          Sworn word
        </span>
        <h1>Confirm your email.</h1>
        <p className="about" style={{ marginTop: 14 }}>
          One click seals it — this proves the address is yours.
        </p>
        <VerifyEmailForm token={token ?? null} />
      </div>
    </section>
  );
}
