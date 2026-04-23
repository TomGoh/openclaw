import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAuthMethod } from "./types.js";

const upsertAuthProfileMock = vi.hoisted(() => vi.fn());
const removePlaintextApiKeyProfilesForProviderMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/auth-profiles.js", () => ({
  upsertAuthProfile: upsertAuthProfileMock,
  removePlaintextApiKeyProfilesForProvider: removePlaintextApiKeyProfilesForProviderMock,
}));

import { runProviderPluginAuthMethod } from "./provider-auth-choice.js";

describe("runProviderPluginAuthMethod TEE plaintext cleanup", () => {
  beforeEach(() => {
    upsertAuthProfileMock.mockReset();
    removePlaintextApiKeyProfilesForProviderMock.mockReset();
  });

  it("cleans minimax plaintext profiles when TEE placeholder profile is returned", async () => {
    const method: ProviderAuthMethod = {
      id: "api-tee-global",
      label: "MiniMax via TEE / Secret Proxy",
      kind: "custom",
      run: async () => ({
        profiles: [
          {
            profileId: "minimax:tee-global",
            credential: {
              type: "api_key",
              provider: "minimax",
              key: "openclaw-minimax-secret-proxy",
            },
          },
        ],
      }),
    };

    await runProviderPluginAuthMethod({
      config: {},
      runtime: {} as never,
      prompter: { note: vi.fn(async () => {}) } as never,
      method,
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/workspace",
    });

    expect(upsertAuthProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "minimax:tee-global", agentDir: "/tmp/openclaw-agent" }),
    );
    expect(removePlaintextApiKeyProfilesForProviderMock).toHaveBeenCalledWith({
      provider: "minimax",
      keepProfileIds: ["minimax:tee-global"],
      agentDir: "/tmp/openclaw-agent",
    });
  });

  it("does not clean plaintext profiles for non-TEE auth results", async () => {
    const method: ProviderAuthMethod = {
      id: "api-global",
      label: "MiniMax API key",
      kind: "api_key",
      run: async () => ({
        profiles: [
          {
            profileId: "minimax:global",
            credential: {
              type: "api_key",
              provider: "minimax",
              key: "sk-real-minimax",
            },
          },
        ],
      }),
    };

    await runProviderPluginAuthMethod({
      config: {},
      runtime: {} as never,
      prompter: { note: vi.fn(async () => {}) } as never,
      method,
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/workspace",
    });

    expect(upsertAuthProfileMock).toHaveBeenCalled();
    expect(removePlaintextApiKeyProfilesForProviderMock).not.toHaveBeenCalled();
  });

  it("cleans plaintext profiles for any provider secret-proxy placeholder", async () => {
    const method: ProviderAuthMethod = {
      id: "api-secret-proxy",
      label: "OpenAI via Secret Proxy",
      kind: "custom",
      run: async () => ({
        profiles: [
          {
            profileId: "openai:secret-proxy",
            credential: {
              type: "api_key",
              provider: "openai",
              key: "openclaw-secret-proxy:openai",
            },
          },
        ],
      }),
    };

    await runProviderPluginAuthMethod({
      config: {},
      runtime: {} as never,
      prompter: { note: vi.fn(async () => {}) } as never,
      method,
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/workspace",
    });

    expect(removePlaintextApiKeyProfilesForProviderMock).toHaveBeenCalledWith({
      provider: "openai",
      keepProfileIds: ["openai:secret-proxy"],
      agentDir: "/tmp/openclaw-agent",
    });
  });
});
