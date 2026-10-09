import { NextResponse } from 'next/server';
import { listInvoices } from '@/modules/monetisation';
import { getPaymentProvider } from '@/lib/payment-provider-factory';
import { env } from '@/config/env';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-10.6 — invoices, read from the payment provider rather than a local mirror.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const invoices = await listInvoices(
      session.userId,
      id,
      getPaymentProvider(env.PAYMENT_PROVIDER),
    );
    return NextResponse.json({ invoices });
  } catch (e) {
    return errorResponse(e);
  }
}
