// Dev seed — idempotent. Creates known test accounts (platform admin, a
// verified charity owner, a verified corporation CSR manager) for driving the
// running app locally, then prints them. Re-running skips accounts that already
// exist. Run: `npm run db:seed` (targets DATABASE_URL from .env.local).
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users, organisations, memberships } from '@/db/schema';
import {
  createPlatformAdmin,
  registerCharity,
  registerCorporation,
  approveVerification,
} from '@/modules/identity';

const PASSWORD = 'Password123!';
const ADMIN_EMAIL = 'admin@hodorhub.test';
const CHARITY_EMAIL = 'charity@hodorhub.test';
const CORP_EMAIL = 'corp@hodorhub.test';

const byEmail = (email: string) => db.query.users.findFirst({ where: eq(users.email, email) });

async function ensureAdmin(): Promise<string> {
  const existing = await byEmail(ADMIN_EMAIL);
  if (existing) return existing.id;
  return createPlatformAdmin(ADMIN_EMAIL, PASSWORD);
}

async function ensureCharity(adminId: string): Promise<void> {
  if (await byEmail(CHARITY_EMAIL)) return;
  const c = await registerCharity({
    email: CHARITY_EMAIL,
    password: PASSWORD,
    charityName: 'Helping Hands',
    regNumber: 'CH-DEMO-1',
  });
  await approveVerification(c.verificationRequestId, adminId);
}

async function ensureCorp(adminId: string): Promise<void> {
  if (await byEmail(CORP_EMAIL)) return;
  const co = await registerCorporation({
    email: CORP_EMAIL,
    password: PASSWORD,
    companyName: 'Globex',
    emailDomain: 'hodorhub.test',
  });
  await approveVerification(co.verificationRequestId, adminId);
}

async function describe(email: string) {
  const u = await byEmail(email);
  if (!u) return { email, password: PASSWORD, role: '(missing)', org: '—', 'org status': '—' };
  let role = u.isPlatformAdmin ? 'platform_admin' : '—';
  let org = '—';
  let status = '—';
  const m = await db.query.memberships.findFirst({ where: eq(memberships.userId, u.id) });
  if (m) {
    role = m.role;
    const o = await db.query.organisations.findFirst({
      where: eq(organisations.id, m.organisationId),
    });
    if (o) {
      org = o.name;
      status = o.status;
    }
  }
  return { email, password: PASSWORD, role, org, 'org status': status };
}

async function main() {
  const adminId = await ensureAdmin();
  await ensureCharity(adminId);
  await ensureCorp(adminId);

  const rows = [];
  for (const email of [ADMIN_EMAIL, CHARITY_EMAIL, CORP_EMAIL]) {
    rows.push(await describe(email));
  }
  console.log('\nHodorHub seed test accounts (sign in at http://localhost:3000/signin):');
  console.table(rows);
  process.exit(0);
}

main().catch((e) => {
  console.error('SEED_ERROR', e);
  process.exit(1);
});
