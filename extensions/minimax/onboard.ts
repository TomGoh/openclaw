import { MINIMAX_DEFAULT_MODEL_ID } from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  type ModelProviderConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildMinimaxApiModelDefinition,
  MINIMAX_API_BASE_URL,
  MINIMAX_CN_API_BASE_URL,
} from "./model-definitions.js";
import { MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER } from "./secret-proxy-wrapper.js";

type MinimaxApiProviderConfigParams = {
  providerId: string;
  modelId: string;
  baseUrl: string;
};

function applyMinimaxApiProviderConfigWithBaseUrl(
  cfg: OpenClawConfig,
  params: MinimaxApiProviderConfigParams,
): OpenClawConfig {
  const providers = { ...cfg.models?.providers } as Record<string, ModelProviderConfig>;
  const existingProvider = providers[params.providerId];
  const existingModels = existingProvider?.models ?? [];
  const apiModel = buildMinimaxApiModelDefinition(params.modelId);
  const hasApiModel = existingModels.some((model) => model.id === params.modelId);
  const mergedModels = hasApiModel ? existingModels : [...existingModels, apiModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {
    baseUrl: params.baseUrl,
    models: [],
  };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim() === "minimax" ? "" : resolvedApiKey;
  providers[params.providerId] = {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: "anthropic-messages",
    authHeader: true,
    ...(normalizedApiKey?.trim() ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : [apiModel],
  };

  const models = { ...cfg.agents?.defaults?.models };
  const modelRef = `${params.providerId}/${params.modelId}`;
  models[modelRef] = {
    ...models[modelRef],
    alias: "Minimax",
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, { agentModels: models, providers });
}

function applyMinimaxApiConfigWithBaseUrl(
  cfg: OpenClawConfig,
  params: MinimaxApiProviderConfigParams,
): OpenClawConfig {
  const next = applyMinimaxApiProviderConfigWithBaseUrl(cfg, params);
  return applyAgentDefaultModelPrimary(next, `${params.providerId}/${params.modelId}`);
}

export function applyMinimaxApiProviderConfig(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_API_BASE_URL,
  });
}

export function applyMinimaxApiConfig(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return applyMinimaxApiConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_API_BASE_URL,
  });
}

export function applyMinimaxApiProviderConfigCn(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_CN_API_BASE_URL,
  });
}

export function applyMinimaxApiConfigCn(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return applyMinimaxApiConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_CN_API_BASE_URL,
  });
}

/**
 * After {@link applyMinimaxApiConfig} / {@link applyMinimaxApiConfigCn}, force placeholder
 * `apiKey` and agent `params.secretProxy*` for TEE / secret proxy (Plan B).
 */
export function buildMinimaxTeeSecretProxyConfigPatch(
  cfg: OpenClawConfig,
  params: {
    region: "global" | "cn";
    secretProxyUrl: string;
    secretProxyKeyId: number;
  },
): OpenClawConfig {
  const modelId = MINIMAX_DEFAULT_MODEL_ID;
  const baseCfg =
    params.region === "cn"
      ? applyMinimaxApiConfigCn(cfg, modelId)
      : applyMinimaxApiConfig(cfg, modelId);
  const baseUrl = params.region === "cn" ? MINIMAX_CN_API_BASE_URL : MINIMAX_API_BASE_URL;
  const secretProxyEndpointUrl = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;

  const providerId = "minimax";
  const modelRef = `${providerId}/${modelId}`;

  const providers = {
    ...(baseCfg.models?.providers ?? {}),
  } as Record<string, ModelProviderConfig>;
  const prevProvider = providers[providerId] ?? {};
  providers[providerId] = {
    ...prevProvider,
    apiKey: MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER,
  };

  const models = { ...(baseCfg.agents?.defaults?.models ?? {}) };
  const proxyParams = {
    secretProxyUrl: params.secretProxyUrl,
    secretProxyKeyId: params.secretProxyKeyId,
    secretProxyEndpointUrl,
  };
  const minimaxRefs = new Set<string>([
    modelRef,
    ...Object.keys(models).filter((key) => key.startsWith("minimax/")),
  ]);
  for (const refKey of minimaxRefs) {
    const prevEntry = models[refKey] ?? {};
    const prevParams =
      typeof prevEntry.params === "object" &&
      prevEntry.params !== null &&
      !Array.isArray(prevEntry.params)
        ? (prevEntry.params as Record<string, unknown>)
        : {};
    models[refKey] = {
      ...prevEntry,
      params: {
        ...prevParams,
        ...proxyParams,
      },
    };
  }

  return applyOnboardAuthAgentModelsAndProviders(baseCfg, {
    agentModels: models,
    providers,
  });
}
