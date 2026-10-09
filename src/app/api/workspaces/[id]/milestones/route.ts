import { NextResponse } from 'next/server';
import { createMilestone, milestoneSchema } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

// US-6.3 — only the charity owner draws the milestones; they are the charity's
// statement of what "delivered" means.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const input = milestoneSchema.parse(await readJson(req));
    const { milestoneId } = await createMilestone(session.userId, id, input);
    return NextResponse.json({ milestoneId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
