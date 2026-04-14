import { MINIMAX_DEFAULT_MODEL_ID } from "openclaw/plugin-sdk/provider-models";
import { describe, expect, it } from "vitest";
import { buildMinimaxTeeSecretProxyConfigPatch } from "./onboard.js";
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
});
