import { describe, expect, it } from "vitest";
import { mergeConfigPatch } from "./provider-auth-choice-helpers.js";

describe("mergeConfigPatch", () => {
  it("treats null as delete for nested keys (auth configPatch clears stale params)", () => {
    const base = {
      agents: {
        defaults: {
          models: {
            "minimax/MiniMax-M2.7": {
              alias: "MiniMax",
              params: {
                secretProxyUrl: "http://127.0.0.1:18790",
                secretProxyKeyId: 0,
                secretProxyEndpointUrl: "https://api.minimax.io/anthropic/v1/messages",
                custom: "keep",
              },
            },
          },
        },
      },
    };
    const patch = {
      agents: {
        defaults: {
          models: {
            "minimax/MiniMax-M2.7": {
              alias: "Minimax",
              params: {
                secretProxyUrl: null,
                secretProxyKeyId: null,
                secretProxyEndpointUrl: null,
                custom: "keep",
              },
            },
          },
        },
      },
    };
    const merged = mergeConfigPatch(base, patch);
    const params = merged.agents?.defaults?.models?.["minimax/MiniMax-M2.7"]?.params as
      | Record<string, unknown>
      | undefined;
    expect(params?.secretProxyUrl).toBeUndefined();
    expect(params?.secretProxyKeyId).toBeUndefined();
    expect(params?.secretProxyEndpointUrl).toBeUndefined();
    expect(params?.custom).toBe("keep");
  });

  it("merges object patches when base key is missing (params added from patch)", () => {
    const base = {
      agents: { defaults: { models: { "minimax/M": { alias: "x" } } } },
    };
    const patch = {
      agents: { defaults: { models: { "minimax/M": { params: { secretProxyUrl: null } } } } },
    };
    const merged = mergeConfigPatch(base, patch);
    expect(merged.agents?.defaults?.models?.["minimax/M"]).toEqual({ alias: "x", params: {} });
  });
});
