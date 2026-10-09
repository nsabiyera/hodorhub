import { getSession } from '@/lib/auth';
import {
  listForUser,
  getPreferences,
  NOTIFICATION_COPY,
  type NotificationCopy,
  type NotificationPayload,
} from '@/modules/notifications';
import { isProd } from '@/config/env';
import PreferenceToggles from './PreferenceToggles';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string }>;
}) {
  const sp = await searchParams;
  const session = await getSession();
  // Dev-only preview: ?as=<userId> renders that user's ravens locally; ignored in production.
  const viewerId = !isProd && sp.as ? sp.as : (session?.userId ?? null);

  return (
    <section className="detail">
      <div className="wrap">
        <a className="back" href="/">
          &larr; All projects
        </a>
        <span className="eyebrow" style={{ display: 'block', marginTop: 18 }}>
          Sent by raven
        </span>
        <h1>Your messages</h1>

        {!viewerId ? (
          <p className="about" style={{ marginTop: 18 }}>
            <a className="raven-signin" href="/signin?next=/notifications">
              Sign in
            </a>{' '}
            to read the ravens sent to you.
          </p>
        ) : (
          <>
            <Ravens viewerId={viewerId} />
            {/* Always the signed-in user's own settings, never the dev ?as= preview's:
                the PUT can only ever change your own, so showing someone else's here
                would offer a control that silently writes to a different account. */}
            {session?.userId && <Preferences viewerId={session.userId} />}
          </>
        )}
      </div>
    </section>
  );
}

async function Ravens({ viewerId }: { viewerId: string }) {
  const items = await listForUser(viewerId);
  if (items.length === 0) {
    return (
      <p className="about" style={{ marginTop: 18 }}>
        No messages yet. As people back your projects, word will arrive here.
      </p>
    );
  }
  return (
    <div className="ravens">
      {items.map((n) => {
        // A stored row can hold a type the code has since retired, so this
        // lookup stays by-string and may miss; the union is enforced where
        // notifications are *created*, not where old ones are read back.
        const copy = (NOTIFICATION_COPY as Record<string, NotificationCopy | undefined>)[n.type];
        const payload = (n.payload ?? {}) as NotificationPayload;
        return (
          <div className="raven" key={n.id}>
            <span className="raven-dot" aria-hidden="true" />
            <div>
              <div className="raven-title">{copy?.title ?? n.type}</div>
              <div className="raven-body">{copy ? copy.body(payload) : ''}</div>
              <div className="raven-time">
                {new Date(n.createdAt).toLocaleString('en-GB', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// US-8.2 — the same settings the domain enforces when a notification is created.
async function Preferences({ viewerId }: { viewerId: string }) {
  return <PreferenceToggles initial={await getPreferences(viewerId)} />;
}
