/** Linear state types for Done and Canceled; the steward never works on a ticket in either. */
export const CLOSED_STATE_TYPES: readonly string[] = ["completed", "canceled"];

export const closedReason = (identifier: string, state: { name: string; type: string }): string | null =>
  CLOSED_STATE_TYPES.includes(state.type) ? `${identifier} is ${state.name}; Ticket Steward does not work on Done or Canceled tickets` : null;
