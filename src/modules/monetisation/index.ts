/**
 * Public interface of the Monetisation bounded context (Epic 10).
 *
 * The gate is always `hasEntitlement(org, feature)` — never a plan-code
 * comparison at a call site (US-10.1). Charities and supporters are entitled to
 * everything, decided at the root of that function (US-10.3).
 */
export {
  hasEntitlement,
  assertEntitlement,
  getPlanForOrg,
  getEntitlementSummary,
  getSeatUsage,
  assertSeatAvailable,
} from './service';
export { PlanUpgradeRequiredError, SeatLimitReachedError } from './errors';
export {
  PLANS,
  FEATURES,
  DEFAULT_PLAN_CODE,
  getPlan,
  lowestPlanWith,
  nextPlanWithMoreSeats,
} from './plans';
export type { Plan, PlanCode, Feature } from './plans';
export {
  startSubscription,
  activateSubscription,
  cancelSubscription,
  listInvoices,
  subscribeSchema,
} from './billing';
export type { SubscribeInput } from './billing';
