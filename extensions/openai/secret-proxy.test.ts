import { OPENAI_DEFAULT_MODEL } from "openclaw/plugin-sdk/provider-models";
import { describe, expect, it } from "vitest";
import {
  applyOpenAIApiConfigAsMergePatch,
  buildOpenAISecretProxyConfigPatch,
  createOpenAISecretProxyWrapper,
} from "./secret-proxy.js";

describe("buildOpenAISecretProxyConfigPatch", () => {
  it("stores placeholder key and secret-proxy params on default openai model", () => {
    const next = buildOpenAISecretProxyConfigPatch({
      config: {},
      placeholderApiKey: "openclaw-secret-proxy:openai",
      secretProxyUrl: "http://127.0.0.1:29030",
      secretProxyKeyId: 7,
    });
    expect(next.models?.providers?.openai?.apiKey).toBe("openclaw-secret-proxy:openai");
    expect(next.models?.providers?.openai?.baseUrl).toBe("https://api.openai.com/v1");
    const params = next.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]?.params as
      | Record<string, unknown>
      | undefined;
    expect(params?.secretProxyUrl).toBe("http://127.0.0.1:29030");
    expect(params?.secretProxyKeyId).toBe(7);
    expect(params?.secretProxyEndpointUrl).toBe("https://api.openai.com/v1/responses");
    expect(params?.secretProxy).toEqual({
      url: "http://127.0.0.1:29030",
      keyId: 7,
      endpointUrl: "https://api.openai.com/v1/responses",
    });
  });

  it("applies secret-proxy params to all openai/* model refs", () => {
    const next = buildOpenAISecretProxyConfigPatch({
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5-mini": { alias: "mini" },
              "openai/gpt-5.4": { alias: "main" },
              "minimax/MiniMax-M2.7": { alias: "other" },
            },
          },
        },
      },
      placeholderApiKey: "openclaw-secret-proxy:openai",
      secretProxyUrl: "http://127.0.0.1:19030",
      secretProxyKeyId: 9,
    });
    const p54 = next.agents?.defaults?.models?.["openai/gpt-5.4"]?.params as
      | Record<string, unknown>
      | undefined;
    const p5mini = next.agents?.defaults?.models?.["openai/gpt-5-mini"]?.params as
      | Record<string, unknown>
      | undefined;
    const pMinimax = next.agents?.defaults?.models?.["minimax/MiniMax-M2.7"]?.params as
      | Record<string, unknown>
      | undefined;
    expect(p54?.secretProxyUrl).toBe("http://127.0.0.1:19030");
    expect(p5mini?.secretProxyUrl).toBe("http://127.0.0.1:19030");
    expect(pMinimax?.secretProxyUrl).toBeUndefined();
  });

  it("clears secret-proxy params and placeholder when switching back to api key mode", () => {
    const tee = buildOpenAISecretProxyConfigPatch({
      config: {},
      placeholderApiKey: "openclaw-secret-proxy:openai",
      secretProxyUrl: "http://127.0.0.1:19030",
      secretProxyKeyId: 2,
    });
    const directPatch = applyOpenAIApiConfigAsMergePatch(tee);
    const params = directPatch.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]?.params as
      | Record<string, unknown>
      | undefined;
    expect(params?.secretProxyUrl).toBeNull();
    expect(params?.secretProxyKeyId).toBeNull();
    expect(params?.secretProxyEndpointUrl).toBeNull();
    expect(params?.secretProxy).toBeNull();
    expect(directPatch.models?.providers?.openai?.apiKey).toBeNull();
  });

  it("handles full transition: direct -> secret-proxy -> direct", () => {
    const directInitial = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            apiKey: "sk-openai-direct-key",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          models: {
            [OPENAI_DEFAULT_MODEL]: {},
          },
        },
      },
    };

    const tee = buildOpenAISecretProxyConfigPatch({
      config: directInitial as never,
      placeholderApiKey: "openclaw-secret-proxy:openai",
      secretProxyUrl: "http://127.0.0.1:19030",
      secretProxyKeyId: 222,
    });
    const teeParams = tee.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]?.params as
      | Record<string, unknown>
      | undefined;
    expect(tee.models?.providers?.openai?.apiKey).toBe("openclaw-secret-proxy:openai");
    expect(teeParams?.secretProxyUrl).toBe("http://127.0.0.1:19030");
    expect(teeParams?.secretProxyKeyId).toBe(222);

    // Simulate final merged config after user switches back to direct mode
    // and enters a real key again.
    const directPatch = applyOpenAIApiConfigAsMergePatch(tee);
    const directFinal = {
      ...directPatch,
      models: {
        ...directPatch.models,
        providers: {
          ...directPatch.models?.providers,
          openai: {
            ...(directPatch.models?.providers?.openai ?? {}),
            apiKey: "sk-openai-direct-key",
          },
        },
      },
    };

    const finalParams = directFinal.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]?.params as
      | Record<string, unknown>
      | undefined;
    expect(finalParams?.secretProxyUrl ?? undefined).toBeUndefined();
    expect(finalParams?.secretProxyKeyId ?? undefined).toBeUndefined();
    expect(finalParams?.secretProxyEndpointUrl ?? undefined).toBeUndefined();
    expect(finalParams?.secretProxy ?? undefined).toBeUndefined();
    expect(directFinal.models?.providers?.openai?.apiKey).toBe("sk-openai-direct-key");
  });

  it("uses config fallback when wrapper extraParams lacks secretProxyUrl", () => {
    const baseStreamFn = (() => ({ text: "ok" })) as never;
    const wrapped = createOpenAISecretProxyWrapper({
      baseStreamFn,
      config: {
        agents: {
          defaults: {
            models: {
              [OPENAI_DEFAULT_MODEL]: {
                params: {
                  secretProxyUrl: "http://127.0.0.1:19030",
                  secretProxyKeyId: 1,
                },
              },
            },
          },
        },
      },
      placeholderApiKey: "openclaw-secret-proxy:openai",
    });
    expect(wrapped).not.toBe(baseStreamFn);
  });
});
