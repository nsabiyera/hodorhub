import Link from 'next/link';
import { listConversationsForProject, type ConversationSummary } from '@/modules/messaging';
import StartConversation from './StartConversation';

const SIGNAL_LABEL: Record<string, string> = {
  interest: 'Interested',
  pledge: 'Pledged',
  resource_gift: 'Resource gift',
  compute_pledge: 'Funded agent delivery',
};

/**
 * US-8.3 — the conversations panel on a project.
 *
 * The charity owner sees one row per corporation that has a relationship with
 * the project; a CSR manager sees only their own. Everyone else gets nothing
 * rendered at all, because `listConversationsForProject` returns [] rather than
 * throwing — so this component is safe to drop on a page every visitor loads.
 */
export default async function Conversations({
  projectId,
  viewerId,
}: {
  projectId: string;
  viewerId: string | null;
}) {
  if (!viewerId) return null;
  const conversations = await listConversationsForProject(viewerId, projectId);
  if (conversations.length === 0) return null;

  return (
    <div className="panel" style={{ marginTop: 20 }}>
      <h3>Conversations</h3>
      <p className="detail-line">
        One conversation per delivery partner, tied to this project — the same thread before, during
        and after delivery.
      </p>
      {conversations.map((c: ConversationSummary) => (
        <div className="gift-row" key={c.corporationOrgId}>
          <div className="gift-main">
            <div className="role">{c.corporationName}</div>
            <p className="detail-line">
              {c.signals.map((s) => SIGNAL_LABEL[s] ?? s).join(' · ')}
              {c.lastMessageAt
                ? ` · last message ${new Date(c.lastMessageAt).toLocaleDateString('en-GB')}`
                : ' · no messages yet'}
            </p>
          </div>
          <div className="gift-actions">
            {c.threadId ? (
              <Link href={`/threads/${c.threadId}`}>Open conversation</Link>
            ) : (
              <StartConversation projectId={projectId} corporationOrgId={c.corporationOrgId} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
