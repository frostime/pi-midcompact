// Runtime mutex over DraftPlan edits. Pure state machine, not persisted: the
// owner is held in memory by index.ts and lost on reload by design. Agent turns
// and user edit UIs cannot mutate the DraftPlan concurrently.

export type PlanningLockOwner = "agent" | "ui";

export interface PlanningLockState {
  owner: PlanningLockOwner | undefined;
}

export function emptyPlanningLock(): PlanningLockState {
  return { owner: undefined };
}

/** Agent path: returns false when a UI holds the lock. */
export function agentCanMutate(state: PlanningLockState): boolean {
  return state.owner !== "ui";
}

/** UI path: returns false when an Agent turn holds the lock. */
export function tryAcquireUi(state: PlanningLockState): boolean {
  if (state.owner === "agent") return false;
  state.owner = "ui";
  return true;
}

/** Acquire the Agent turn lock. Returns false when the UI holds it. */
export function acquireAgent(state: PlanningLockState): boolean {
  if (state.owner === "ui") return false;
  state.owner = "agent";
  return true;
}

/** Release the Agent lock on turn end. No-op if the UI holds it. */
export function releaseAgent(state: PlanningLockState): void {
  if (state.owner === "agent") state.owner = undefined;
}

/** Release the UI lock on close or abnormal disconnect. No-op if the Agent holds it. */
export function releaseUi(state: PlanningLockState): void {
  if (state.owner === "ui") state.owner = undefined;
}
