/**
 * Public interface of the Reporting bounded context (Epic 7).
 *
 * Read-only and table-less: it composes the owning modules' public reads so
 * that "hours", "support" and "delivered" keep exactly one definition each.
 */
export { getProjectImpact, getCorporateImpact } from './service';
export type { ProjectImpact, CorporateImpact } from './service';
