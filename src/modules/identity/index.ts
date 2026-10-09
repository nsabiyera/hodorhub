/**
 * Public interface of the Identity & Org bounded context. Other modules import
 * from here, never from ./service internals or the DB tables directly.
 */
export {
  registerCharity,
  registerCorporation,
  listPendingVerifications,
  approveVerification,
  rejectVerification,
  assertOrganisationVerified,
  authenticate,
  createPlatformAdmin,
  findMembership,
  findOrgMemberByRole,
  getUserOrg,
  inviteMember,
  countMembers,
  listMembers,
  removeMember,
  getOrganisationRefs,
  getUserRefs,
  isPlatformAdmin,
  registerCharitySchema,
  registerCorporationSchema,
  type RegisterCharityInput,
  type RegisterCorporationInput,
  type RegistrationResult,
} from './service';

export {
  requestEmailVerification,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
} from './tokens';

export * from './errors';

/** US-1.5 — volunteer profiles, display names and the skills registry. */
export {
  profileSchema,
  displayNameSchema,
  getMyProfile,
  saveMyProfile,
  deleteMyProfile,
  setDisplayName,
  listMembershipProfiles,
  getMembershipAvailability,
  deleteMembershipProfilesForUser,
  type ProfileInput,
  type MyProfileView,
  type MembershipProfileEntry,
} from './profile';

export {
  VOLUNTEER_SKILLS,
  VOLUNTEER_SKILL_CODES,
  SENIORITY_LEVELS,
  SENIORITY_CODES,
  getSkill,
  getSeniority,
  skillsForCategory,
  categoriesForSkills,
  type VolunteerSkill,
  type VolunteerSkillCode,
  type SeniorityCode,
  type SkillCategory,
} from './skills';
