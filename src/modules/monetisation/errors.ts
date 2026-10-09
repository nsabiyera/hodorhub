import { DomainError } from '@/modules/identity';
import { lowestPlanWith, type Feature } from './plans';

/**
 * US-10.5 — the feature exists and you may use it; your plan does not include
 * it. Distinct from ForbiddenError on purpose: this is not a permission
 * problem, and telling a CSR manager "forbidden" when the answer is "upgrade"
 * is both wrong and useless. Maps to 402 Payment Required.
 *
 * Carries the plan that first includes the feature, so a client can render a
 * concrete prompt rather than a generic paywall.
 */
export class PlanUpgradeRequiredError extends DomainError {
  readonly feature: Feature;
  readonly requiredPlanCode: string | null;
  readonly requiredPlanName: string | null;

  constructor(feature: Feature) {
    const plan = lowestPlanWith(feature);
    super(
      plan
        ? `This feature is available on the ${plan.name} plan.`
        : 'This feature is not available on any current plan.',
      'upgrade_required',
    );
    this.feature = feature;
    this.requiredPlanCode = plan?.code ?? null;
    this.requiredPlanName = plan?.name ?? null;
  }
}

/**
 * US-10.7 — every seat on the plan is taken. Like PlanUpgradeRequiredError this
 * is a billing answer (402), not a permission one: the CSR manager is allowed
 * to invite people, they have simply run out of seats.
 */
export class SeatLimitReachedError extends DomainError {
  readonly seatLimit: number;
  readonly nextPlanCode: string | null;
  readonly nextPlanName: string | null;

  constructor(seatLimit: number, next: { code: string; name: string } | null) {
    super(
      next
        ? `All ${seatLimit} seats on your plan are in use. The ${next.name} plan has more.`
        : `All ${seatLimit} seats on your plan are in use.`,
      'seat_limit_reached',
    );
    this.seatLimit = seatLimit;
    this.nextPlanCode = next?.code ?? null;
    this.nextPlanName = next?.name ?? null;
  }
}
