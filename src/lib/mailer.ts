import { isProd } from '@/config/env';

/**
 * Transactional email behind a swappable interface (ADR 0001). Dev/test logs the
 * message (MailHog catches SMTP if wired); a real SMTP/provider implementation
 * plugs in for production without changing callers.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export const mailer: Mailer = {
  async send(msg) {
    if (!isProd) {
      console.warn(`[mail] → ${msg.to} :: ${msg.subject}\n${msg.text}`);
      return;
    }
    // TODO(prod): SMTP/provider send using SMTP_* env (tracked in TECH_DEBT).
  },
};
