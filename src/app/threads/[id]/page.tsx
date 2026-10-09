import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getThread } from '@/modules/messaging';
import { NotFoundError } from '@/modules/identity';
import MessageComposer from './MessageComposer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Conversation — HodorHub',
  description: 'A conversation between a charity and a delivery partner, tied to the work.',
};

const dateLabel = (d: Date) =>
  new Date(d).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * US-8.3 — the one rendering of a conversation. Both the project page and the
 * delivery board link here rather than embedding their own copy, which would be
 * two renderings of the same thread drifting apart.
 *
 * An unknown thread and one that is not yours are the same 404.
 */
export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { id } = await params;
  const { before } = await searchParams;
  const session = await getSession();
  if (!session) redirect(`/signin?next=/threads/${id}`);

  let thread;
  try {
    // A junk `?before=` — a mangled shared link, say — falls back to the newest
    // page rather than erroring: the conversation is still what the reader
    // asked for. The API is stricter and answers 400.
    const cursor = before === undefined ? NaN : Number(before);
    thread = await getThread(session.userId, id, {
      before: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined,
    });
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }

  const otherSide =
    thread.viewer.side === 'charity' ? thread.corporationName : thread.charityOrgName;

  return (
    <section className="detail">
      <div className="wrap">
        <Link className="back" href={`/projects/${thread.project.id}`}>
          &larr; {thread.project.title}
        </Link>
        <span className="eyebrow" style={{ display: 'block', marginTop: 18 }}>
          In conversation with
        </span>
        <h1>{otherSide}</h1>
        <p className="about">
          Tied to <strong>{thread.project.title}</strong>. Only {thread.charityOrgName} and{' '}
          {thread.corporationName} can read this.
        </p>

        {thread.hasMore && thread.nextBefore !== null && (
          <p className="detail-line">
            <Link href={`/threads/${id}?before=${thread.nextBefore}`}>
              &uarr; Load earlier messages
            </Link>
          </p>
        )}

        <div className="ravens" style={{ marginTop: 18 }}>
          {thread.messages.length === 0 ? (
            <p className="about">
              No messages yet. Say hello — whoever writes first sets the tone.
            </p>
          ) : (
            thread.messages.map((m) => (
              <div className="raven" key={m.id}>
                <span className="raven-dot" aria-hidden="true" />
                <div>
                  <div className="role">
                    {m.authorOrgName}
                    {m.isMySide ? ' (you)' : ''} &middot;{' '}
                    <span className="detail-line">{m.authorLabel}</span>
                  </div>
                  {m.redacted ? (
                    <p className="about">
                      <em>This message was removed when its author erased their account.</em>
                    </p>
                  ) : (
                    <p className="about" style={{ whiteSpace: 'pre-wrap' }}>
                      {m.body}
                    </p>
                  )}
                  <p className="detail-line">{dateLabel(m.postedAt)}</p>
                </div>
              </div>
            ))
          )}
        </div>

        {thread.viewer.canPost && (
          <MessageComposer
            projectId={thread.project.id}
            corporationOrgId={thread.corporationOrgId}
          />
        )}
      </div>
    </section>
  );
}
