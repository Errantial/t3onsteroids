export const V1_BACKGROUND_WORK_POLICY = "disabled" as const;

/**
 * The v1 fence marker. `disabled` means "no native work concurrent with a turn", and it is also
 * what identifies a session as provider-owned, so its value never changes for a caller that does
 * not know about follow-ups.
 */
export type BackgroundWorkPolicy = typeof V1_BACKGROUND_WORK_POLICY;

/**
 * v2: work started by a turn may outlive it, and its result is reported back to the same thread.
 * Requested only from a controller that advertises `provider-background-work-v2`.
 */
export type FollowUpPolicy = "report";

export interface ProviderSessionPolicy {
  readonly backgroundWork: BackgroundWorkPolicy;
  readonly followUps?: FollowUpPolicy;
}

export const v1ProviderSessionPolicy: ProviderSessionPolicy = {
  backgroundWork: V1_BACKGROUND_WORK_POLICY,
};

export const followUpProviderSessionPolicy: ProviderSessionPolicy = {
  backgroundWork: V1_BACKGROUND_WORK_POLICY,
  followUps: "report",
};
