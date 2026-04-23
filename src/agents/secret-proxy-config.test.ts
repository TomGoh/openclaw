import { describe, expect, it } from "vitest";
import {
  extractProviderSecretProxyTripleFromModelParams,
  hasProviderSecretProxyEnabled,
} from "./secret-proxy-config.js";

describe("secret-proxy config helpers", () => {
  it("extracts from legacy and namespaced params", () => {
    expect(
      extractProviderSecretProxyTripleFromModelParams({
        secretProxyUrl: "http://127.0.0.1:19030",
        secretProxyKeyId: 1,
      }),
    ).toEqual({
      secretProxyUrl: "http://127.0.0.1:19030",
      secretProxyKeyId: 1,
    });
    expect(
      extractProviderSecretProxyTripleFromModelParams({
        secretProxy: { url: "http://127.0.0.1:29030", keyId: 4, endpointUrl: "https://x" },
      }),
    ).toEqual({
      secretProxyUrl: "http://127.0.0.1:29030",
      secretProxyKeyId: 4,
      secretProxyEndpointUrl: "https://x",
    });
  });

  it("detects provider secret-proxy from env and config", () => {
    expect(
      hasProviderSecretProxyEnabled({
        config: {},
        providerId: "openai",
        envVarNames: ["OPENCLAW_OPENAI_SECRET_PROXY_URL"],
        env: { OPENCLAW_OPENAI_SECRET_PROXY_URL: "http://127.0.0.1:29030" } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
    expect(
      hasProviderSecretProxyEnabled({
        config: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.4": {
                  params: { secretProxy: { url: "http://127.0.0.1:29030" } },
                },
              },
            },
          },
        },
        providerId: "openai",
      }),
    ).toBe(true);
  });
});
