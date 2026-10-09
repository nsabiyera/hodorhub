import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getSession } from '@/lib/auth';
import { getUserOrg } from '@/modules/identity';
import {
  getEntitlementSummary,
  PLANS,
  DEFAULT_PLAN_CODE,
  listInvoices,
} from '@/modules/monetisation';
import { getPaymentProvider } from '@/lib/payment-provider-factory';
import { env } from '@/config/env';
import SubscribeActions from './SubscribeActions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Plans — HodorHub' };

// US-10.5 — where an upgrade prompt leads: what each plan includes and which
// one you are on. Self-serve subscription is US-10.6 and needs a payment
// provider, so this page says so plainly rather than offering a button that
// cannot work.
export default async function BillingPage() {
  const session = await getSession();
  if (!session) redirect('/signin');
  const org = await getUserOrg(session.userId);
  if (!org || org.orgType !== 'corporation' || org.role !== 'csr_manager') redirect('/');

  const summary = await getEntitlementSummary(org.organisationId);
  const invoices = await listInvoices(
    session.userId,
    org.organisationId,
    getPaymentProvider(env.PAYMENT_PROVIDER),
  );
  const hasActiveSubscription = summary.planCode !== DEFAULT_PLAN_CODE;

  return (
    <section className="detail">
      <div className="wrap">
        <h1>Plans</h1>
        <p className="detail-line">
          Charities and supporters use HodorHub free, always. Corporations pay only for reporting,
          branding and scale — never for visibility or ranking.
        </p>

        {PLANS.map((plan) => (
          <div className="panel" style={{ marginTop: 20 }} key={plan.code}>
            <h3>
              {plan.name}
              {plan.code === summary.planCode && <span className="gift-chip"> Current plan</span>}
            </h3>
            <p className="detail-line">
              {plan.seatLimit === null ? 'Unlimited seats' : `Up to ${plan.seatLimit} seats`}
            </p>
            {plan.features.length === 0 ? (
              <p className="detail-line">
                The full core loop: discover projects, pledge, deliver, and log approved hours.
              </p>
            ) : (
              <ul>
                {plan.features.map((f) => (
                  <li key={f} className="detail-line">
                    {FEATURE_LABEL[f] ?? f}
                  </li>
                ))}
              </ul>
            )}
            <SubscribeActions
              organisationId={org.organisationId}
              planCode={plan.code}
              isCurrent={plan.code === summary.planCode}
              hasActiveSubscription={hasActiveSubscription}
            />
          </div>
        ))}

        <div className="panel" style={{ marginTop: 20 }}>
          <h3>Invoices</h3>
          {invoices.length === 0 ? (
            <p className="detail-line">
              No invoices yet — you are on the free plan. Invoices appear here once you subscribe.
            </p>
          ) : (
            invoices.map((inv) => (
              <div className="gift-row" key={inv.id}>
                <div className="gift-main">
                  <div className="role">
                    £{(inv.amountMinor / 100).toFixed(2)} {inv.currency}
                  </div>
                  <div className="detail-line">
                    {new Date(inv.issuedAt).toLocaleDateString('en-GB')} · {inv.status}
                  </div>
                </div>
                {inv.url && (
                  <a href={inv.url} target="_blank" rel="noopener noreferrer">
                    View
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

const FEATURE_LABEL: Record<string, string> = {
  csr_dashboard: 'CSR dashboard — donated hours, projects supported and outcomes',
  branding: 'Your logo and colour theme on your workspace surfaces',
  custom_domain: 'Custom domain with automatic TLS',
};
