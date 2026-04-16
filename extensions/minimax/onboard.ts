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

const MINIMAX_SECRET_PROXY_PARAM_KEYS = [
  "secretProxyUrl",
  "secretProxyKeyId",
  "secretProxyEndpointUrl",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Drop `null` and empty plain objects after using `null` merge markers (see `stripMinimaxSecretProxyFromConfig`). */
function omitNullEntriesDeep(input: unknown): unknown {
  if (input === null) {
    return undefined;
  }
  if (Array.isArray(input)) {
    return input.map((item) => omitNullEntriesDeep(item));
  }
  if (!isPlainRecord(input)) {
    return input;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null) {
      continue;
    }
    const cleaned = omitNullEntriesDeep(v);
    if (cleaned === undefined) {
      continue;
    }
    if (isPlainRecord(cleaned) && Object.keys(cleaned).length === 0) {
      continue;
    }
    out[k] = cleaned;
  }
  return out;
}

/**
 * Clear TEE / secret-proxy-only fields from agent model entries and drop the placeholder
 * `models.providers.minimax.apiKey`. Uses **`null` markers** for nested keys so
 * `mergeConfigPatch` (used when applying auth `configPatch`) can remove existing values instead
 * of merging them forever. Public helpers such as {@link applyMinimaxApiConfig} run
 * `omitNullEntriesDeep` on the result; wizard flows use {@link applyMinimaxApiConfigAsMergePatch}
 * so `null` markers survive until `mergeConfigPatch` runs.
 */
export function stripMinimaxSecretProxyFromConfig(cfg: OpenClawConfig): OpenClawConfig {
  let next = cfg;

  const models = next.agents?.defaults?.models;
  if (models && typeof models === "object") {
    const newModels = { ...models };
    let changed = false;
    for (const [key, entry] of Object.entries(newModels)) {
      if (!key.startsWith("minimax/")) {
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const prevParams = entry.params;
      if (!prevParams || typeof prevParams !== "object" || Array.isArray(prevParams)) {
        continue;
      }
      const pp = prevParams as Record<string, unknown>;
      const hasSecretProxy =
        (typeof pp.secretProxyUrl === "string" && pp.secretProxyUrl.trim() !== "") ||
        (typeof pp.secretProxyEndpointUrl === "string" &&
          pp.secretProxyEndpointUrl.trim() !== "") ||
        (pp.secretProxyKeyId !== undefined &&
          pp.secretProxyKeyId !== null &&
          (typeof pp.secretProxyKeyId === "number" || typeof pp.secretProxyKeyId === "string"));
      if (!hasSecretProxy) {
        continue;
      }
      changed = true;
      const newParams = {
        ...pp,
        secretProxyUrl: null,
        secretProxyKeyId: null,
        secretProxyEndpointUrl: null,
      };
      newModels[key] = { ...entry, params: newParams };
    }
    if (changed) {
      next = {
        ...next,
        agents: {
          ...next.agents,
          defaults: {
            ...next.agents?.defaults,
            models: newModels,
          },
        },
      };
    }
  }

  const minimaxProv = next.models?.providers?.minimax;
  if (minimaxProv && minimaxProv.apiKey === MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER) {
    next = {
      ...next,
      models: {
        ...next.models,
        providers: {
          ...next.models?.providers,
          minimax: { ...minimaxProv, apiKey: null } as unknown as ModelProviderConfig,
        },
      },
    };
  }

  return next;
}

function applyMinimaxApiProviderConfigWithBaseUrl(
  cfg: OpenClawConfig,
  params: MinimaxApiProviderConfigParams,
): OpenClawConfig {
  const stripped = stripMinimaxSecretProxyFromConfig(cfg);
  const providers = { ...stripped.models?.providers } as Record<string, ModelProviderConfig>;
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
  let normalizedApiKey = resolvedApiKey?.trim() === "minimax" ? "" : resolvedApiKey;
  if (normalizedApiKey?.trim() === MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER) {
    normalizedApiKey = undefined;
  }
  providers[params.providerId] = {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: "anthropic-messages",
    authHeader: true,
    ...(normalizedApiKey?.trim()
      ? { apiKey: normalizedApiKey }
      : existingApiKey === null
        ? { apiKey: null as unknown as ModelProviderConfig["apiKey"] }
        : {}),
    models: mergedModels.length > 0 ? mergedModels : [apiModel],
  };

  const models = { ...stripped.agents?.defaults?.models };
  const modelRef = `${params.providerId}/${params.modelId}`;
  models[modelRef] = {
    ...models[modelRef],
    alias: "Minimax",
  };

  return applyOnboardAuthAgentModelsAndProviders(stripped, { agentModels: models, providers });
}

function applyMinimaxApiConfigWithBaseUrl(
  cfg: OpenClawConfig,
  params: MinimaxApiProviderConfigParams,
): OpenClawConfig {
  const next = applyMinimaxApiProviderConfigWithBaseUrl(cfg, params);
  return applyAgentDefaultModelPrimary(next, `${params.providerId}/${params.modelId}`);
}

/**
 * Same as {@link applyMinimaxApiProviderConfig} but keeps JSON Merge Patch `null` markers so
 * {@link mergeConfigPatch} can delete nested keys (wizard `configPatch`). Prefer
 * {@link applyMinimaxApiProviderConfig} when not merging into an existing file-backed config.
 */
export function applyMinimaxApiProviderConfigAsMergePatch(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_API_BASE_URL,
  });
}

export function applyMinimaxApiProviderConfig(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return omitNullEntriesDeep(
    applyMinimaxApiProviderConfigAsMergePatch(cfg, modelId),
  ) as OpenClawConfig;
}

/**
 * Same as {@link applyMinimaxApiConfig} but preserves merge `null` markers for {@link mergeConfigPatch}.
 */
export function applyMinimaxApiConfigAsMergePatch(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return applyMinimaxApiConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_API_BASE_URL,
  });
}

export function applyMinimaxApiConfig(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return omitNullEntriesDeep(applyMinimaxApiConfigAsMergePatch(cfg, modelId)) as OpenClawConfig;
}

/**
 * Same as {@link applyMinimaxApiProviderConfigCn} but preserves merge `null` markers.
 */
export function applyMinimaxApiProviderConfigCnAsMergePatch(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_CN_API_BASE_URL,
  });
}

export function applyMinimaxApiProviderConfigCn(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return omitNullEntriesDeep(
    applyMinimaxApiProviderConfigCnAsMergePatch(cfg, modelId),
  ) as OpenClawConfig;
}

/**
 * Same as {@link applyMinimaxApiConfigCn} but preserves merge `null` markers.
 */
export function applyMinimaxApiConfigCnAsMergePatch(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return applyMinimaxApiConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_CN_API_BASE_URL,
  });
}

export function applyMinimaxApiConfigCn(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.7",
): OpenClawConfig {
  return omitNullEntriesDeep(applyMinimaxApiConfigCnAsMergePatch(cfg, modelId)) as OpenClawConfig;
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
