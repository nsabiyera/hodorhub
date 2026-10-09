import { NextResponse } from 'next/server';
import { updateTask, updateTaskSchema } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

// US-6.3 — move or reassign a task. A volunteer may move their own task;
// reassignment stays a coordinator's decision.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const input = updateTaskSchema.parse(await readJson(req));
    await updateTask(session.userId, id, input);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
