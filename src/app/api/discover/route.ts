import { NextResponse } from 'next/server';
import { listProjects } from '@/modules/discovery';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// US-4.1 / US-4.2 — public discovery: browse published projects, ranked by support.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const params = {
      q: url.searchParams.get('q') ?? undefined,
      category: url.searchParams.get('category') ?? undefined,
      sort: url.searchParams.get('sort') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    };
    // Drop undefined so schema defaults apply.
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    return NextResponse.json({ projects: await listProjects(clean) });
  } catch (e) {
    return errorResponse(e);
  }
}
