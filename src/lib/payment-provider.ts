/**
 * Tool-contract seam for the payment provider (US-10.6). Everything that talks
 * to Stripe (or any successor) goes through this interface, so the domain never
 * imports a vendor SDK and the whole subscribe flow is testable offline.
 *
 * Invoices are deliberately NOT mirrored into our database: the provider is
 * their system of record, and a local copy would drift the moment a refund or
 * adjustment happened there. We fetch them.
 */
export interface CheckoutRequest {
  organisationId: string;
  planCode: string;
  /** Where the provider returns the CSR manager after paying. */
  returnUrl: string;
}
export interface CheckoutSession {
  checkoutId: string;
  url: string;
}
/** What the provider tells us once money has actually moved. */
export interface ConfirmedCheckout {
  checkoutId: string;
  organisationId: string;
  planCode: string;
  customerRef: string;
  subscriptionRef: string;
}
export interface Invoice {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
  issuedAt: string;
  url: string | null;
}

export interface PaymentProviderClient {
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /**
   * Verify and decode a provider callback. Returns null when the payload is not
   * a completed checkout we should act on. Signature verification lives HERE,
   * inside the provider, so no route can accidentally trust an unsigned body.
   */
  verifyCheckoutCallback(
    rawBody: string,
    signature: string | null,
  ): Promise<ConfirmedCheckout | null>;
  cancelSubscription(subscriptionRef: string): Promise<void>;
  listInvoices(customerRef: string): Promise<Invoice[]>;
}
