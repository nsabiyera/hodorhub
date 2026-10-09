/** Public interface of the Notifications bounded context. */
export { dispatchEvent, listForUser, type EmailIntent } from './service';
export { relayOutbox } from './relay';

/** US-8.2 — per-user notification preferences. */
export {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_CODES,
  kindForType,
  resolveChannels,
  getPreferences,
  setPreference,
  preferenceUpdateSchema,
  PreferenceLockedError,
  type NotificationKind,
  type PreferenceUpdateInput,
} from './preferences';

export { NOTIFICATION_COPY, type NotificationCopy, type NotificationPayload } from './copy';
