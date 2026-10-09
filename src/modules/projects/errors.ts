import { DomainError } from '@/modules/identity/errors';

/** Projects-specific domain errors. Reuse NotFoundError / NotVerifiedError /
 * ForbiddenError / InvalidStateError from the Identity module's public errors. */

export class InvalidProjectTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`Cannot move a project from ${from} to ${to}.`, 'invalid_transition');
  }
}

export class ProjectValidationError extends DomainError {
  constructor(readonly fields: string[]) {
    super(`Project is missing required fields: ${fields.join(', ')}.`, 'project_validation');
  }
}

export class NoResourceNeedsError extends DomainError {
  constructor() {
    super('A published project must have at least one resource need.', 'no_resource_needs');
  }
}
