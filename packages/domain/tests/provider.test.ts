import { describe, expect, test } from "bun:test";
import { selectAgentProvider } from "../src/provider.ts";

describe("agent provider selection", () => {
  const providers = [
    {
      id: "claude-subscription",
      kind: "claude_code_local",
      availability: "rate_limited",
      billingMode: "subscription",
    },
    {
      id: "codex-subscription",
      kind: "codex_local",
      availability: "available",
      billingMode: "subscription",
    },
    {
      id: "anthropic-paid",
      kind: "anthropic_api",
      availability: "available",
      billingMode: "api_metered",
    },
  ] as const;

  test("uses an available subscription fallback before a paid API", () => {
    const selection = selectAgentProvider(providers, {
      primaryProviderId: "claude-subscription",
      fallbackProviderIds: ["codex-subscription", "anthropic-paid"],
      allowPaidApiFallback: false,
    });

    expect(selection.status).toBe("selected");
    if (selection.status === "selected") {
      expect(selection.provider.id).toBe("codex-subscription");
      expect(selection.usedFallback).toBe(true);
    }
  });

  test("pauses rather than silently using a metered API", () => {
    const selection = selectAgentProvider(providers, {
      primaryProviderId: "claude-subscription",
      fallbackProviderIds: ["anthropic-paid"],
      allowPaidApiFallback: false,
    });

    expect(selection.status).toBe("paused");
  });

  test("uses a metered fallback only after explicit opt-in", () => {
    const selection = selectAgentProvider(providers, {
      primaryProviderId: "claude-subscription",
      fallbackProviderIds: ["anthropic-paid"],
      allowPaidApiFallback: true,
    });

    expect(selection.status).toBe("selected");
    if (selection.status === "selected") {
      expect(selection.provider.id).toBe("anthropic-paid");
      expect(selection.provider.billingMode).toBe("api_metered");
    }
  });

  test("does not replace an available primary metered provider chosen by the user", () => {
    const selection = selectAgentProvider(providers, {
      primaryProviderId: "anthropic-paid",
      fallbackProviderIds: [],
      allowPaidApiFallback: false,
    });

    expect(selection.status).toBe("selected");
    if (selection.status === "selected") {
      expect(selection.provider.id).toBe("anthropic-paid");
      expect(selection.usedFallback).toBe(false);
    }
  });

  test("never automatically selects a provider with unknown billing", () => {
    const selection = selectAgentProvider(
      [
        {
          id: "unknown-local-auth",
          kind: "claude_code_local",
          availability: "available",
          billingMode: "unknown",
        },
      ],
      {
        primaryProviderId: "unknown-local-auth",
        fallbackProviderIds: [],
        allowPaidApiFallback: false,
      },
    );

    expect(selection.status).toBe("paused");
  });
});
