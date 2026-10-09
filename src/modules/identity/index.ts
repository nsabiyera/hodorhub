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
