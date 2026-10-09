/** Raised when a step's reservation would breach the run's funded ceiling. */
export class BudgetExceededError extends Error {
  constructor(message = 'Insufficient remaining budget for the next step.') {
    super(message);
    this.name = 'BudgetExceededError';
  }
}
