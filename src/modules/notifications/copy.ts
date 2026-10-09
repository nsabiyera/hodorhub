/**
 * Human-facing copy for every notification type (US-8.1), in one place.
 *
 * This used to live in the `/notifications` page. US-8.2 gave it a second
 * consumer — the email channel needs a subject and a body for the same event —
 * and two copies of twenty strings is exactly the drift US-11.12 removed
 * elsewhere. The page and the mailer now read the same map.
 */
export type NotificationPayload = Record<string, unknown>;

const reasonOf = (p: NotificationPayload, fallback: string) =>
  typeof p.reason === 'string' && p.reason ? p.reason : fallback;

const titleOf = (p: NotificationPayload, fallback: string) =>
  typeof p.title === 'string' && p.title ? `"${p.title}"` : fallback;

export interface NotificationCopy {
  title: string;
  body: (p: NotificationPayload) => string;
}

export const NOTIFICATION_COPY = {
  'organisation.verified': {
    title: 'Your organisation was verified',
    body: () => 'You can now publish projects and start gathering support.',
  },
  'organisation.rejected': {
    title: 'Verification was declined',
    body: (p) => reasonOf(p, 'Please review your details and try again.'),
  },
  'interest.expressed': {
    title: 'A company expressed interest',
    body: () => 'A corporation is considering delivering one of your projects.',
  },
  'pledge.proposed': {
    title: 'A company pledged support',
    body: () => 'Review the pledge and accept or decline it.',
  },
  'pledge.accepted': {
    title: 'Your pledge was accepted',
    body: () => 'Delivery can begin — allocate your volunteers.',
  },
  'pledge.declined': {
    title: 'Your pledge was declined',
    body: (p) => reasonOf(p, 'The charity has declined this pledge.'),
  },
  'hours.approved': {
    title: 'Your hours were approved',
    body: () => 'Your donated time now counts toward the project.',
  },
  'hours.rejected': {
    title: 'Your hours were declined',
    body: (p) => reasonOf(p, 'Please review the entry and resubmit.'),
  },
  'member.invited': {
    title: 'You were invited to a workspace',
    body: () => 'You have been added to an organisation on HodorHub.',
  },
  'resource_gift.offered': {
    title: 'A company offered a resource gift',
    body: () => 'A corporation has offered to donate a digital resource to one of your projects.',
  },
  'resource_gift.accepted': {
    title: 'Your resource gift was accepted',
    body: () => 'The charity accepted your in-kind resource gift.',
  },
  'resource_gift.declined': {
    title: 'Your resource gift was declined',
    body: (p) => reasonOf(p, 'The charity has declined this resource gift.'),
  },
  'resource_gift.provided': {
    title: 'A resource gift was marked provided',
    body: () => 'A donor marked a resource gift as provided — confirm when you receive it.',
  },
  'resource_gift.received': {
    title: 'Your resource gift was confirmed received',
    body: () => 'The charity confirmed it received your in-kind resource gift.',
  },
  'delivery_task.assigned': {
    title: 'A task was assigned to you',
    body: (p) => `${titleOf(p, 'A task')} is yours on the delivery board.`,
  },
  'delivery_milestone.achieved': {
    title: 'The charity confirmed a milestone',
    body: (p) => `${titleOf(p, 'A milestone')} is signed off as achieved.`,
  },
  'agent_run.paused': {
    title: 'An agent-delivery run was paused',
    body: (p) => reasonOf(p, 'A platform admin paused the run. It will not advance until resumed.'),
  },
  'agent_run.resumed': {
    title: 'An agent-delivery run was resumed',
    body: () => 'The run will advance again from where it stopped.',
  },
  'agent_run.halted': {
    title: 'An agent-delivery run was halted',
    body: (p) => reasonOf(p, 'A platform admin halted the run. Unspent budget is released.'),
  },
  'agent_run.promoted': {
    title: 'The delivered app is live in production',
    body: () => 'The charity approved the promotion and the app is now live.',
  },
  'message.posted': {
    title: 'A new message on a project',
    // Deliberately NOT a preview of the message. Notification and outbox
    // payloads are jsonb stores with their own lifetimes, and this body is fed
    // straight into email — a third channel that "visible to both
    // organisations and nobody else" (US-8.3) does not cover. The project title
    // is already public. Dead permissive code is how the leak gets added later
    // by someone "finishing" it, so the preview branch is gone, not dormant.
    body: (p) => `${titleOf(p, 'A project')} has a new message. Open the conversation to read it.`,
  },
} satisfies Record<string, NotificationCopy>;

/**
 * Every notification type the platform can produce. `satisfies` above keeps the
 * map's own shape checked while letting this stay a union of the actual keys,
 * so `create()` cannot be handed a type nobody has written copy for and the
 * kind registry cannot claim one. Drift becomes a compile error, not a slug
 * rendered raw on the page.
 */
export type NotificationType = keyof typeof NOTIFICATION_COPY;
