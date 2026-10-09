/**
 * Typed domain errors for the Identity & Org module. Route handlers map these
 * to HTTP status codes; nothing else leaks raw DB errors to callers.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class EmailInUseError extends DomainError {
  constructor() {
    super('That email is already registered.', 'email_in_use');
  }
}

export class InvalidWorkEmailError extends DomainError {
  constructor(domain: string) {
    super(`Your email must be on the company domain @${domain}.`, 'invalid_work_email');
  }
}

export class NotFoundError extends DomainError {
  constructor(what = 'Resource') {
    super(`${what} not found.`, 'not_found');
  }
}

export class InvalidStateError extends DomainError {
  constructor(message: string) {
    super(message, 'invalid_state');
  }
}

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('Invalid email or password.', 'invalid_credentials');
  }
}

export class NotVerifiedError extends DomainError {
  constructor() {
    super('This organisation is not verified yet.', 'not_verified');
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to do this.') {
    super(message, 'forbidden');
  }
}
