import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getMyProfile, VOLUNTEER_SKILLS, SENIORITY_LEVELS } from '@/modules/identity';
import ProfileForm from './ProfileForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your profile — HodorHub',
  description: 'Your display name, skills and the hours you can offer.',
};

/**
 * US-1.5 — the volunteer's own profile. Never a gate: everything a role allows
 * already works with nothing filled in, and this page is reachable but optional.
 */
export default async function ProfilePage() {
  const session = await getSession();
  if (!session) redirect('/signin?next=/profile');
  const profile = await getMyProfile(session.userId);

  return (
    <section className="detail">
      <div className="wrap">
        <a className="back" href="/">
          &larr; All projects
        </a>
        <span className="eyebrow" style={{ display: 'block', marginTop: 18 }}>
          Your profile
        </span>
        <h1>{profile.label}</h1>
        <p className="about">
          Your name is what other people see when you are named — on a project conversation, and to
          your colleagues on a delivery board. Everything here is optional.
        </p>
        <ProfileForm
          profile={profile}
          skills={VOLUNTEER_SKILLS.map((s) => ({ code: s.code, label: s.label }))}
          seniorityLevels={SENIORITY_LEVELS.map((s) => ({ code: s.code, label: s.label }))}
        />
      </div>
    </section>
  );
}
