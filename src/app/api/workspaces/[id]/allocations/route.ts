import { NextResponse } from 'next/server';
import { z } from 'zod';
import { allocateVolunteer } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({
  volunteerUserId: z.string().uuid(),
  hoursPerWeek: z.number().int().min(1).max(40),
});

// US-6.1 — CSR manager allocates a volunteer to a delivery workspace.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { volunteerUserId, hoursPerWeek } = schema.parse(await readJson(req));
    const { allocationId } = await allocateVolunteer(
      session.userId,
      id,
      volunteerUserId,
      hoursPerWeek,
    );
    return NextResponse.json({ allocationId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
