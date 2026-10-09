import { NextResponse } from 'next/server';
import { createTask, taskSchema } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

// US-6.3 — the charity owner or the CSR manager adds a task to the board.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const input = taskSchema.parse(await readJson(req));
    const { taskId } = await createTask(session.userId, id, input);
    return NextResponse.json({ taskId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
