import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { users, membershipProfiles, memberships } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  inviteMember,
} from './service';
import { getUserRefs, listMembers, removeMember, getUserOrg } from './service';
import {
  getMyProfile,
  saveMyProfile,
  deleteMyProfile,
  setDisplayName,
  listMembershipProfiles,
  getMembershipAvailability,
  personLabel,
  type ProfileInput,
} from './profile';
import { eraseUser } from '@/modules/privacy';
import { ForbiddenError, NotFoundError } from './errors';

async function corp(tag: string) {
  const admin = await createPlatformAdmin(`admin-${tag}@hh.com`, 'admin-password-1', testDb);
  const c = await registerCorporation(
    {
      email: `carlos-${tag}@acme-${tag}.com`,
      password: 'another-strong-pw',
      companyName: `Acme ${tag}`,
      emailDomain: `acme-${tag}.com`,
    },
    testDb,
  );
  await approveVerification(c.verificationRequestId, admin, testDb);
  return { admin, ...c };
}

const FILLED: ProfileInput = {
  weeklyHours: 5,
  skills: ['backend-development', 'accessibility'],
  seniority: 'experienced',
  note: 'Tuesdays are best.',
};

describe('Profiles — defaults and saving (US-1.5)', () => {
  it('a user who has filled nothing in has NO stated availability, not zero', async () => {
    const c = await corp('a');
    const view = await getMyProfile(c.userId, testDb);
    expect(view.membership).toMatchObject({ hasProfile: false, weeklyHours: null, skills: [] });
    // The distinction is the whole point: null is "nobody said", 0 is "offered
    // none". Nothing may render or sum the first as the second.
    expect(view.membership!.weeklyHours).not.toBe(0);
    expect(await testDb.query.membershipProfiles.findMany()).toHaveLength(0);
  });

  it('saves, and 0 hours is a real, distinct answer', async () => {
    const c = await corp('zero');
    await saveMyProfile(c.userId, { ...FILLED, weeklyHours: 0 }, testDb);
    const view = await getMyProfile(c.userId, testDb);
    expect(view.membership).toMatchObject({ hasProfile: true, weeklyHours: 0 });
    expect(view.membership!.skills.map((s) => s.code).sort()).toEqual([
      'accessibility',
      'backend-development',
    ]);
  });

  it('replaces the skill set on save rather than accumulating it', async () => {
    const c = await corp('replace');
    await saveMyProfile(c.userId, FILLED, testDb);
    await saveMyProfile(c.userId, { ...FILLED, skills: ['carpentry'] }, testDb);
    const view = await getMyProfile(c.userId, testDb);
    expect(view.membership!.skills.map((s) => s.code)).toEqual(['carpentry']);
    // One profile row, not two — the upsert keys on the membership.
    expect(await testDb.query.membershipProfiles.findMany()).toHaveLength(1);
  });

  it('rejects a skill that is not in the registry', async () => {
    const c = await corp('bad');
    await expect(
      saveMyProfile(c.userId, { ...FILLED, skills: ['telepathy'] as never }, testDb),
    ).rejects.toThrow();
  });

  it('deleting returns to no stated availability and takes the skills with it', async () => {
    const c = await corp('del');
    await saveMyProfile(c.userId, FILLED, testDb);
    await deleteMyProfile(c.userId, testDb);
    const view = await getMyProfile(c.userId, testDb);
    expect(view.membership).toMatchObject({ hasProfile: false, weeklyHours: null });
    // The join rows go via ON DELETE CASCADE, not a second hand-written sweep.
    expect(await testDb.query.membershipProfileSkills.findMany()).toHaveLength(0);
  });
});

describe('Profiles — one employer, one week (US-1.5)', () => {
  it('keeps two employers’ profiles entirely separate', async () => {
    const one = await corp('one');
    const two = await corp('two');
    // The same human, invited into a second organisation.
    const { userId } = await inviteMember(
      two.userId,
      two.organisationId,
      `carlos-one@acme-one.com`,
      'volunteer',
      testDb,
    );
    expect(userId).toBe(one.userId);

    await saveMyProfile(one.userId, FILLED, testDb);

    // Exactly ONE employer holds the profile — never both. Which one is the
    // documented arbitrary-but-stable choice (there is no org switcher yet), so
    // the test discovers it rather than assuming: assuming is what made this
    // pass alone and fail in the full suite, back when the resolution was an
    // unordered findFirst that returned a different membership per run.
    const forOne = await getMembershipAvailability(one.organisationId, [one.userId], testDb);
    const forTwo = await getMembershipAvailability(two.organisationId, [one.userId], testDb);
    const holders = [forOne, forTwo].filter((r) => r.length > 0);
    expect(holders).toHaveLength(1);
    expect(holders[0]![0]).toMatchObject({ weeklyHours: 5 });
    // And the other employer sees nothing at all: hours are one employer's
    // week to be offered, and nothing is copied between tenants.
    expect([forOne, forTwo].filter((r) => r.length === 0)).toHaveLength(1);
  });

  it('resolves the SAME membership every time, and the same one as getUserOrg', async () => {
    // Not cosmetic: an unordered findFirst let a two-organisation user save
    // availability against a different employer on consecutive saves, and see
    // one employer on /profile and another on /team.
    const one = await corp('stable1');
    const two = await corp('stable2');
    await inviteMember(
      two.userId,
      two.organisationId,
      'carlos-stable1@acme-stable1.com',
      'volunteer',
      testDb,
    );
    // Asserted STRUCTURALLY as well as behaviourally. Repeating the call and
    // checking the answer is stable proves nothing: Postgres returns a
    // consistent row for a small table anyway, so that version passed happily
    // against the unordered code it was written to catch.
    const resolvers: [string, string][] = [
      ['src/modules/identity/service.ts', 'getUserOrg'],
      ['src/modules/identity/profile.ts', 'myMembership'],
    ];
    for (const [file, fn] of resolvers) {
      const src = readFileSync(file, 'utf8');
      const body = src.slice(src.indexOf(`function ${fn}`));
      const call = body.slice(0, body.indexOf('});') + 3);
      expect(call).toContain('memberships.userId');
      expect(call).toMatch(/orderBy:\s*\[asc\(memberships\.id\)\]/);
    }

    // And the two resolvers agree, so /profile and /team cannot disagree about
    // which employer you are looking at.
    const view = await getMyProfile(one.userId, testDb);
    const org = await getUserOrg(one.userId, testDb);
    expect(view.membership!.organisationId).toBe(org!.organisationId);
  });

  it('releasing the seat takes that organisation’s profile, and only that one', async () => {
    const c = await corp('seat');
    const member = await inviteMember(
      c.userId,
      c.organisationId,
      'dana@acme-seat.com',
      'volunteer',
      testDb,
    );
    await saveMyProfile(member.userId, FILLED, testDb);
    expect(await testDb.query.membershipProfiles.findMany()).toHaveLength(1);

    await removeMember(c.userId, c.organisationId, member.userId, testDb);

    // Gone by ON DELETE CASCADE from memberships — a database rule, not a line
    // in removeMember that a refactor could drop.
    expect(await testDb.query.membershipProfiles.findMany()).toHaveLength(0);
    // The person and their name survive; only the employer's copy went.
    expect(await testDb.query.users.findFirst({ where: eq(users.id, member.userId) })).toBeTruthy();
  });
});

describe('Display names (US-1.5)', () => {
  it('replaces the email wherever a person is named, and falls back with no backfill', async () => {
    const c = await corp('name');
    const before = await getUserRefs([c.userId], testDb);
    expect(before[0]).toMatchObject({ label: 'carlos-name@acme-name.com', displayName: null });

    await setDisplayName(c.userId, 'Carlos Mendes', testDb);
    const after = await getUserRefs([c.userId], testDb);
    expect(after[0]).toMatchObject({ label: 'Carlos Mendes', erased: false });

    // Clearing it goes back to the email rather than to an empty label.
    await setDisplayName(c.userId, null, testDb);
    expect((await getUserRefs([c.userId], testDb))[0]!.label).toBe('carlos-name@acme-name.com');
  });

  it('an erased person reads "Former member", by two independent mechanisms', async () => {
    const c = await corp('erased');
    await setDisplayName(c.userId, 'Gone Person', testDb);
    await eraseUser(c.userId, testDb);

    const refs = await getUserRefs([c.userId], testDb);
    // Never the erased-…@erased.invalid placeholder, which is what the AC names.
    expect(refs[0]!.label).toBe('Former member');
    expect(refs[0]!.label).not.toContain('erased-');
    expect(refs[0]!.displayName).toBeNull();

    // Mechanism 1 on its own: even with a name still present, deletedAt wins.
    expect(personLabel({ email: 'x@y.z', displayName: 'Still Here', deletedAt: new Date() })).toBe(
      'Former member',
    );
    // Mechanism 2 on its own: erasure nulled the name, so even without the
    // deletedAt check there is no real name left to leak.
    expect(personLabel({ email: 'x@y.z', displayName: null, deletedAt: null })).toBe('x@y.z');
  });

  it('erasure deletes every organisation’s profile, not just the first', async () => {
    const one = await corp('e1');
    const two = await corp('e2');
    await inviteMember(
      two.userId,
      two.organisationId,
      'carlos-e1@acme-e1.com',
      'volunteer',
      testDb,
    );
    await saveMyProfile(one.userId, FILLED, testDb);
    // Give the second membership a profile directly (getMyProfile resolves only
    // the first membership — the documented multi-org limit).
    const both = await testDb.query.memberships.findMany({
      where: eq(memberships.userId, one.userId),
    });
    expect(both).toHaveLength(2);
    for (const m of both) {
      await testDb
        .insert(membershipProfiles)
        .values({ membershipId: m.id, weeklyHours: 3 })
        .onConflictDoNothing();
    }
    expect(await testDb.query.membershipProfiles.findMany()).toHaveLength(2);

    await eraseUser(one.userId, testDb);
    expect(await testDb.query.membershipProfiles.findMany()).toHaveLength(0);
  });
});

describe('Profiles — who may read them (US-1.5)', () => {
  it('is readable by an administrator of the same organisation, and nobody else', async () => {
    const c = await corp('read');
    const volunteer = await inviteMember(
      c.userId,
      c.organisationId,
      'dana@acme-read.com',
      'volunteer',
      testDb,
    );
    await saveMyProfile(volunteer.userId, FILLED, testDb);

    // The CSR manager can.
    const roster = await listMembershipProfiles(c.userId, c.organisationId, testDb);
    expect(roster.find((r) => r.userId === volunteer.userId)).toMatchObject({
      weeklyHours: 5,
      hasProfile: true,
    });
    // A member who has filled nothing in is still listed, as "nobody said".
    expect(roster.find((r) => r.userId === c.userId)).toMatchObject({
      hasProfile: false,
      weeklyHours: null,
    });

    // A colleague may not — no story needs one volunteer browsing another's week.
    await expect(
      listMembershipProfiles(volunteer.userId, c.organisationId, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // An outsider gets 404, not 403: whether an org has a roster is not theirs.
    const outsider = await registerCharity(
      {
        email: 'petra@other.org',
        password: 'a-strong-password',
        charityName: 'Other',
        regNumber: 'CH-OTHER',
      },
      testDb,
    );
    await expect(
      listMembershipProfiles(outsider.userId, c.organisationId, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Including a platform admin, who holds no membership anywhere.
    await expect(listMembershipProfiles(c.admin, c.organisationId, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('the roster keeps the email for the admin who invited by it', async () => {
    const c = await corp('email');
    await setDisplayName(c.userId, 'Carlos Mendes', testDb);
    const [me] = await listMembers(c.userId, c.organisationId, testDb);
    expect(me).toMatchObject({ label: 'Carlos Mendes', email: 'carlos-email@acme-email.com' });
  });
});

describe('Display-name validation (US-1.5)', () => {
  // Built from char codes rather than written as escapes: a display name is
  // unmoderated UGC shown to a counterparty charity through US-8.3's
  // authorLabel, and this validation is the only guard on it — so the test
  // must not depend on an escape surviving a formatter or a copy-paste.
  const ZERO_WIDTH = String.fromCharCode(0x200b);
  const NEWLINE = String.fromCharCode(0x0a);
  const BIDI_OVERRIDE = String.fromCharCode(0x202e);

  it('rejects characters that let a name misrepresent itself across an org boundary', async () => {
    const c = await corp('valid');
    for (const bad of [
      `Zero${ZERO_WIDTH}Width`,
      `Two${NEWLINE}Lines`,
      `Bidi${BIDI_OVERRIDE}override`,
    ]) {
      await expect(setDisplayName(c.userId, bad, testDb)).rejects.toThrow();
    }
    // Ordinary names, including punctuation and non-Latin scripts, are fine —
    // otherwise the guard would be quietly excluding most of the world.
    for (const good of ['Dana Okafor', "Dana O'Kafor", 'Jean-Luc Picard', '大野 誠']) {
      await expect(setDisplayName(c.userId, good, testDb)).resolves.toMatchObject({ label: good });
    }
  });

  it('refuses a whitespace-only name rather than storing an invisible one', async () => {
    const c = await corp('blank');
    await expect(setDisplayName(c.userId, '   ', testDb)).rejects.toThrow();
    // Clearing is explicit, and distinct from "I typed spaces".
    await expect(setDisplayName(c.userId, null, testDb)).resolves.toMatchObject({
      label: 'carlos-blank@acme-blank.com',
    });
  });
});
