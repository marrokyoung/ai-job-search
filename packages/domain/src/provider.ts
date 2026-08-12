export const agentProviderKinds = [
  "claude_code_local",
  "codex_local",
  "anthropic_api",
  "openai_api",
  "fake",
] as const;

export type AgentProviderKind = (typeof agentProviderKinds)[number];

export type AgentProviderAvailability =
  | "available"
  | "unavailable"
  | "needs_auth"
  | "rate_limited";

export type AgentProviderBillingMode =
  | "subscription"
  | "api_metered"
  | "local_free"
  | "unknown";

type ProviderStatusBase = {
  id: string;
  availability: AgentProviderAvailability;
  detail?: string;
};

export type AgentProviderStatus =
  | (ProviderStatusBase & {
      kind: "claude_code_local" | "codex_local";
      billingMode: "subscription" | "api_metered" | "unknown";
    })
  | (ProviderStatusBase & {
      kind: "anthropic_api" | "openai_api";
      billingMode: "api_metered";
    })
  | (ProviderStatusBase & {
      kind: "fake";
      billingMode: "local_free";
    });

export type AgentProviderSelectionPolicy = {
  primaryProviderId: string;
  fallbackProviderIds: readonly string[];
  allowPaidApiFallback: boolean;
};

export type AgentProviderSelection =
  | {
      status: "selected";
      provider: AgentProviderStatus;
      usedFallback: boolean;
      reason: string;
    }
  | {
      status: "paused";
      provider: null;
      usedFallback: false;
      reason: string;
    };

function isPermitted(
  provider: AgentProviderStatus,
  policy: AgentProviderSelectionPolicy,
  isFallback: boolean,
): boolean {
  if (provider.availability !== "available") {
    return false;
  }

  if (provider.billingMode === "unknown") {
    return false;
  }

  if (
    isFallback &&
    (provider.kind === "anthropic_api" ||
      provider.kind === "openai_api" ||
      provider.billingMode === "api_metered") &&
    !policy.allowPaidApiFallback
  ) {
    return false;
  }

  return true;
}

export function selectAgentProvider(
  providers: readonly AgentProviderStatus[],
  policy: AgentProviderSelectionPolicy,
): AgentProviderSelection {
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider] as const),
  );
  const primary = providersById.get(policy.primaryProviderId);

  if (primary && isPermitted(primary, policy, false)) {
    return {
      status: "selected",
      provider: primary,
      usedFallback: false,
      reason: "The configured primary provider is available.",
    };
  }

  for (const fallbackId of policy.fallbackProviderIds) {
    const fallback = providersById.get(fallbackId);
    if (fallback && isPermitted(fallback, policy, true)) {
      return {
        status: "selected",
        provider: fallback,
        usedFallback: true,
        reason: "The primary provider is unavailable and this fallback is explicitly permitted.",
      };
    }
  }

  return {
    status: "paused",
    provider: null,
    usedFallback: false,
    reason:
      "No permitted provider is available. Paid API fallback requires explicit opt-in.",
  };
}
