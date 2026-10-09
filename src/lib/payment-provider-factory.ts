import type { PaymentProviderClient } from './payment-provider';
import { FakePaymentProvider } from './fake-payment-provider';

// One process-wide fake so a checkout created by one request is still known to
// the callback that completes it. A real provider is stateless here — the
// state lives in the provider's own system.
const fake = new FakePaymentProvider();

/**
 * Selects the PaymentProviderClient named by PAYMENT_PROVIDER. 'fake' is
 * deterministic and offline. 'stripe' throws until real keys and the SDK are
 * wired: a workspace must never be upgraded "for free" on a fake while an
 * operator believes it was paid for (same rule as getModelProvider).
 */
export function getPaymentProvider(name: string): PaymentProviderClient {
  if (name === 'fake') return fake;
  if (name === 'stripe') {
    throw new Error('payment provider "stripe" is not wired yet (needs STRIPE_SECRET_KEY + SDK)');
  }
  throw new Error(`payment provider "${name}" is not configured`);
}
