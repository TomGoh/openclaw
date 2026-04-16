import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";
import { normalizeProviders } from "./models-config.providers.js";

describe("minimax provider catalog", () => {
  it("does not advertise the removed lightning model for api-key or oauth providers", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "minimax:default": {
              type: "api_key",
              provider: "minimax",
              key: "sk-minimax-test", // pragma: allowlist secret
            },
            "minimax-portal:default": {
              type: "oauth",
              provider: "minimax-portal",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir });
    expect(providers?.minimax?.models?.map((model) => model.id)).toEqual([
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
    ]);
    expect(providers?.["minimax-portal"]?.models?.map((model) => model.id)).toEqual([
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
    ]);
  });

  it("skips MiniMax TEE placeholder profile so a real api_key profile is used after switching off TEE", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "minimax:tee-global": {
              type: "api_key",
              provider: "minimax",
              key: "openclaw-minimax-secret-proxy",
            },
            "minimax:global": {
              type: "api_key",
              provider: "minimax",
              key: "sk-from-global-profile", // pragma: allowlist secret
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const minimaxModel = {
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      reasoning: true,
      input: ["text"] as Array<"text" | "image">,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
      contextWindow: 200_000,
      maxTokens: 8192,
    };

    const next = normalizeProviders({
      agentDir,
      env: {},
      providers: {
        minimax: {
          baseUrl: "https://api.minimax.io/anthropic",
          api: "anthropic-messages",
          authHeader: true,
          models: [minimaxModel],
        },
      },
    });

    expect(next?.minimax?.apiKey).toBe("sk-from-global-profile");
  });
});
