export const V1_BACKGROUND_WORK_POLICY = "disabled" as const;

export interface ProviderSessionPolicy {
  readonly backgroundWork: typeof V1_BACKGROUND_WORK_POLICY;
}

export const v1ProviderSessionPolicy: ProviderSessionPolicy = {
  backgroundWork: V1_BACKGROUND_WORK_POLICY,
};

