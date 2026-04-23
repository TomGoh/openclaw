import { MINIMAX_DEFAULT_MODEL_ID } from "openclaw/plugin-sdk/provider-models";
import { describe, expect, it } from "vitest";
import { mergeConfigPatch } from "../../src/plugins/provider-auth-choice-helpers.js";
import {
  applyMinimaxApiConfig,
  applyMinimaxApiConfigAsMergePatch,
  buildMinimaxTeeSecretProxyConfigPatch,
  stripMinimaxSecretProxyFromConfig,
} from "./onboard.js";
import { MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER } from "./secret-proxy-wrapper.js";

describe("buildMinimaxTeeSecretProxyConfigPatch", () => {
  it("sets placeholder apiKey and secretProxy params (no real sk- in config)", () => {
    const next = buildMinimaxTeeSecretProxyConfigPatch(
      {},
      {
        region: "global",
        secretProxyUrl: "http://127.0.0.1:18790",
        secretProxyKeyId: 3,
      },
    );
    expect(next.models?.providers?.minimax?.apiKey).toBe(MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER);
    const modelRef = `minimax/${MINIMAX_DEFAULT_MODEL_ID}`;
    const params = next.agents?.defaults?.models?.[modelRef]?.params as
      | Record<string, unknown>
      | undefined;
    expect(params?.secretProxyUrl).toBe("http://127.0.0.1:18790");
    expect(params?.secretProxyKeyId).toBe(3);
    expect(String(params?.secretProxyEndpointUrl)).toMatch(/\/v1\/messages$/);
    expect(params?.secretProxy).toEqual({
      url: "http://127.0.0.1:18790",
      keyId: 3,
      endpointUrl: expect.stringMatching(/\/v1\/messages$/),
    });
    const dumped = JSON.stringify(next);
    expect(dumped).not.toMatch(/sk-api-/);
  });

  it("applies secretProxy params to every minimax/* agent model ref", () => {
    const next = buildMinimaxTeeSecretProxyConfigPatch(
      {
        agents: {
          defaults: {
            models: {
              "minimax/MiniMax-M2.5": { alias: "m25" },
            },
          },
        },
      },
      {
        region: "cn",
        secretProxyUrl: "http://127.0.0.1:18790",
        secretProxyKeyId: 2,
      },
    );
    const p25 = next.agents?.defaults?.models?.["minimax/MiniMax-M2.5"]?.params as
      | Record<string, unknown>
      | undefined;
    const p27 = next.agents?.defaults?.models?.[`minimax/${MINIMAX_DEFAULT_MODEL_ID}`]?.params as
      | Record<string, unknown>
      | undefined;
    expect(p25?.secretProxyUrl).toBe("http://127.0.0.1:18790");
    expect(p25?.secretProxyKeyId).toBe(2);
    expect(p27?.secretProxyUrl).toBe("http://127.0.0.1:18790");
    expect(p27?.secretProxyKeyId).toBe(2);
  });

  it("updates existing TEE secretProxy params on repeated configure runs", () => {
    const first = buildMinimaxTeeSecretProxyConfigPatch(
      {},
      {
        region: "global",
        secretProxyUrl: "http://127.0.0.1:18790",
        secretProxyKeyId: 1,
      },
    );
    const second = buildMinimaxTeeSecretProxyConfigPatch(first, {
      region: "global",
      secretProxyUrl: "http://127.0.0.1:19999",
      secretProxyKeyId: 7,
    });
    const params = second.agents?.defaults?.models?.[`minimax/${MINIMAX_DEFAULT_MODEL_ID}`]
      ?.params as Record<string, unknown> | undefined;
    expect(params?.secretProxyUrl).toBe("http://127.0.0.1:19999");
    expect(params?.secretProxyKeyId).toBe(7);
  });

  it("configure-like flow: mergeConfigPatch across repeated TEE runs keeps latest secretProxyKeyId", () => {
    const firstPatch = buildMinimaxTeeSecretProxyConfigPatch(
      {},
      {
        region: "global",
        secretProxyUrl: "http://127.0.0.1:18790",
        secretProxyKeyId: 1,
      },
    );
    const firstSaved = mergeConfigPatch({}, firstPatch);

    const secondPatch = buildMinimaxTeeSecretProxyConfigPatch(firstSaved, {
      region: "global",
      secretProxyUrl: "http://127.0.0.1:28888",
      secretProxyKeyId: 9,
    });
    const secondSaved = mergeConfigPatch(firstSaved, secondPatch) as {
      agents?: {
        defaults?: { models?: Record<string, { params?: Record<string, unknown> }> };
      };
    };

    const params = secondSaved.agents?.defaults?.models?.[`minimax/${MINIMAX_DEFAULT_MODEL_ID}`]
      ?.params as Record<string, unknown> | undefined;
    expect(params?.secretProxyUrl).toBe("http://127.0.0.1:28888");
    expect(params?.secretProxyKeyId).toBe(9);
  });
});

describe("stripMinimaxSecretProxyFromConfig / direct API after TEE", () => {
  it("removes secretProxy* from all minimax/* models and placeholder provider apiKey", () => {
    const tee = buildMinimaxTeeSecretProxyConfigPatch(
      {},
      {
        region: "global",
        secretProxyUrl: "http://127.0.0.1:18790",
        secretProxyKeyId: 0,
      },
    );
    const direct = applyMinimaxApiConfig(tee, MINIMAX_DEFAULT_MODEL_ID);
    expect(direct.models?.providers?.minimax?.apiKey).toBeUndefined();
    const ref = `minimax/${MINIMAX_DEFAULT_MODEL_ID}`;
    const params = direct.agents?.defaults?.models?.[ref]?.params as
      | Record<string, unknown>
      | undefined;
    expect(params?.secretProxyUrl).toBeUndefined();
    expect(params?.secretProxyKeyId).toBeUndefined();
    expect(params?.secretProxyEndpointUrl).toBeUndefined();
    expect(params?.secretProxy).toBeUndefined();
  });

  it("preserves non-secret params on minimax/* when stripping", () => {
    const withCustom = buildMinimaxTeeSecretProxyConfigPatch(
      {
        agents: {
          defaults: {
            models: {
              "minimax/MiniMax-M2.5": {
                alias: "m25",
                params: { custom: "keep-me" },
              },
            },
          },
        },
      },
      {
        region: "global",
        secretProxyUrl: "http://127.0.0.1:18790",
        secretProxyKeyId: 1,
      },
    );
    const direct = applyMinimaxApiConfig(withCustom, MINIMAX_DEFAULT_MODEL_ID);
    const p25 = direct.agents?.defaults?.models?.["minimax/MiniMax-M2.5"]?.params as
      | Record<string, unknown>
      | undefined;
    expect(p25?.custom).toBe("keep-me");
    expect(p25?.secretProxyUrl).toBeUndefined();
  });

  it("stripMinimaxSecretProxyFromConfig is idempotent on clean config", () => {
    expect(stripMinimaxSecretProxyFromConfig({})).toEqual({});
  });

  it("wizard merge: mergeConfigPatch + merge-patch applier removes secretProxy* from file-backed config", () => {
    const tee = buildMinimaxTeeSecretProxyConfigPatch(
      {},
      {
        region: "global",
        secretProxyUrl: "http://127.0.0.1:18790",
        secretProxyKeyId: 2,
      },
    );
    const patch = applyMinimaxApiConfigAsMergePatch(tee, MINIMAX_DEFAULT_MODEL_ID);
    const merged = mergeConfigPatch(tee, patch);
    const ref = `minimax/${MINIMAX_DEFAULT_MODEL_ID}`;
    const params = merged.agents?.defaults?.models?.[ref]?.params as
      | Record<string, unknown>
      | undefined;
    expect(params?.secretProxyUrl).toBeUndefined();
    expect(params?.secretProxyKeyId).toBeUndefined();
    expect(params?.secretProxyEndpointUrl).toBeUndefined();
    expect(params?.secretProxy).toBeUndefined();
    expect(merged.models?.providers?.minimax?.apiKey).toBeUndefined();
  });
});
