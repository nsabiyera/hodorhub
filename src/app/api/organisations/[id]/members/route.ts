import { NextResponse } from 'next/server';
import { z } from 'zod';
import { inviteMember, listMembers } from '@/modules/identity';
import { assertSeatAvailable, getSeatUsage } from '@/modules/monetisation';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({
  email: z.string().email(),
  role: z.enum(['csr_manager', 'manager', 'volunteer', 'charity_owner']),
});

// US-1.4 (minimal) — an org admin invites a colleague by email + role.
// US-10.7 — the seat gate runs first, so a full plan is refused with 402 before
// a user record is created. Re-inviting an existing member is idempotent and
// consumes no seat, so it is deliberately still allowed at the limit.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { email, role } = schema.parse(await readJson(req));
    const alreadyMember = (await listMembers(session.userId, id)).some(
      (m) => m.email === email.toLowerCase(),
    );
    if (!alreadyMember) await assertSeatAvailable(id);
    const result = await inviteMember(session.userId, id, email, role);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

// US-10.7 — seats in use against the plan's limit.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const [members, usage] = await Promise.all([listMembers(session.userId, id), getSeatUsage(id)]);
    return NextResponse.json({ ...usage, members });
  } catch (e) {
    return errorResponse(e);
  }
}
