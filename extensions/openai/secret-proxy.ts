import { streamSimple } from "@mariozechner/pi-ai";
import {
  applyOpenAIConfig,
  OPENAI_DEFAULT_MODEL,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-models";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { createProviderSecretProxyWrapper } from "openclaw/plugin-sdk/provider-stream";

const SECRET_PROXY_URL_ENV = "OPENCLAW_OPENAI_SECRET_PROXY_URL";
const SECRET_PROXY_KEY_ID_ENV = "OPENCLAW_OPENAI_SECRET_PROXY_KEY_ID";
const SECRET_PROXY_ENDPOINT_URL_ENV = "OPENCLAW_OPENAI_SECRET_PROXY_ENDPOINT_URL";

/** Provider catalog requires baseUrl; real requests use CA + `secretProxyEndpointUrl` in agent params. */
const OPENAI_PUBLIC_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_SECRET_PROXY_MARKER_PREFIX = "openclaw-secret-proxy:";

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isOpenAISecretProxyPlaceholder(apiKey: string): boolean {
  const trimmed = apiKey.trim().toLowerCase();
  return trimmed === `${OPENAI_SECRET_PROXY_MARKER_PREFIX}openai`;
}

function resolveProxyUrl(extraParams?: Record<string, unknown>): string | undefined {
  const fromExtra =
    typeof extraParams?.secretProxyUrl === "string" ? extraParams.secretProxyUrl.trim() : "";
  if (fromExtra) {
    return normalizeBaseUrl(fromExtra);
  }
  const fromEnv =
    process.env[SECRET_PROXY_URL_ENV]?.trim() ||
    process.env.OPENCLAW_MINIMAX_SECRET_PROXY_URL?.trim();
  return fromEnv ? normalizeBaseUrl(fromEnv) : undefined;
}

function resolveEndpointUrl(
  extraParams: Record<string, unknown> | undefined,
  modelBaseUrl?: string,
): string {
  const fromExtra =
    typeof extraParams?.secretProxyEndpointUrl === "string"
      ? extraParams.secretProxyEndpointUrl.trim()
      : "";
  if (fromExtra) {
    return fromExtra;
  }
  const fromEnv = process.env[SECRET_PROXY_ENDPOINT_URL_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return `${normalizeBaseUrl(String(modelBaseUrl ?? "https://api.openai.com/v1"))}/responses`;
}

function resolveKeyId(extraParams?: Record<string, unknown>): number {
  const fromExtra = extraParams?.secretProxyKeyId;
  if (typeof fromExtra === "number" && Number.isFinite(fromExtra)) {
    return Math.max(0, Math.floor(fromExtra));
  }
  if (typeof fromExtra === "string" && fromExtra.trim()) {
    const parsed = Number.parseInt(fromExtra, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  const fromEnv = process.env[SECRET_PROXY_KEY_ID_ENV]?.trim();
  if (!fromEnv) {
    return 0;
  }
  const parsed = Number.parseInt(fromEnv, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function createOpenAISecretProxyWrapper(params: {
  baseStreamFn?: import("@mariozechner/pi-agent-core").StreamFn;
  extraParams?: Record<string, unknown>;
  config?: OpenClawConfig;
  placeholderApiKey: string;
}) {
  const mergedParams = mergeExtraParamsWithSecretProxyFallback(params.extraParams, params.config);
  const secretProxyUrl = resolveProxyUrl(mergedParams);
  if (!secretProxyUrl) {
    return params.baseStreamFn ?? streamSimple;
  }
  return createProviderSecretProxyWrapper({
    baseStreamFn: params.baseStreamFn,
    secretProxyUrl,
    secretProxyKeyId: resolveKeyId(mergedParams),
    resolveEndpointUrl: (model) => resolveEndpointUrl(mergedParams, model.baseUrl),
    apiKeyPlaceholder: params.placeholderApiKey,
    requestMethod: "Post",
  });
}

export function buildOpenAISecretProxyConfigPatch(params: {
  config: OpenClawConfig;
  placeholderApiKey: string;
  secretProxyUrl: string;
  secretProxyKeyId: number;
}): OpenClawConfig {
  const base = applyOpenAIConfig(params.config);
  const providerPartial = (base.models?.providers?.openai ?? {}) as Partial<ModelProviderConfig>;
  const openaiProvider: ModelProviderConfig = {
    ...providerPartial,
    baseUrl:
      typeof providerPartial.baseUrl === "string" && providerPartial.baseUrl.trim().length > 0
        ? providerPartial.baseUrl
        : OPENAI_PUBLIC_API_BASE_URL,
    apiKey: params.placeholderApiKey,
    models: Array.isArray(providerPartial.models) ? providerPartial.models : [],
  };
  const models = {
    ...(base.agents?.defaults?.models ?? {}),
  };
  const proxyParams = {
    secretProxyUrl: params.secretProxyUrl,
    secretProxyKeyId: params.secretProxyKeyId,
    secretProxyEndpointUrl: "https://api.openai.com/v1/responses",
    secretProxy: {
      url: params.secretProxyUrl,
      keyId: params.secretProxyKeyId,
      endpointUrl: "https://api.openai.com/v1/responses",
    },
  };
  const openaiRefs = new Set<string>([
    OPENAI_DEFAULT_MODEL,
    ...Object.keys(models).filter((key) => key.startsWith("openai/")),
  ]);
  for (const modelRef of openaiRefs) {
    const prevEntry = models[modelRef] ?? {};
    const prevParams =
      prevEntry.params && typeof prevEntry.params === "object" && !Array.isArray(prevEntry.params)
        ? prevEntry.params
        : {};
    models[modelRef] = {
      ...prevEntry,
      params: {
        ...prevParams,
        ...proxyParams,
      },
    };
  }
  return {
    ...base,
    models: {
      ...base.models,
      providers: {
        ...base.models?.providers,
        openai: openaiProvider,
      },
    },
    agents: {
      ...base.agents,
      defaults: {
        ...base.agents?.defaults,
        models,
      },
    },
  };
}

/**
 * Clear OpenAI secret-proxy-only fields when switching back to direct API key mode.
 * Uses JSON Merge Patch `null` markers so `mergeConfigPatch` can remove nested keys.
 */
export function stripOpenAISecretProxyFromConfig(cfg: OpenClawConfig): OpenClawConfig {
  let next = cfg;
  const models = next.agents?.defaults?.models;
  if (models && typeof models === "object") {
    const newModels = { ...models };
    let changed = false;
    for (const [key, entry] of Object.entries(newModels)) {
      if (!key.startsWith("openai/")) {
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
        pp.secretProxyKeyId !== undefined ||
        (typeof pp.secretProxy === "object" && pp.secretProxy !== null);
      if (!hasSecretProxy) {
        continue;
      }
      changed = true;
      newModels[key] = {
        ...entry,
        params: {
          ...pp,
          secretProxyUrl: null,
          secretProxyKeyId: null,
          secretProxyEndpointUrl: null,
          secretProxy: null,
        },
      };
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

  const openaiProvider = next.models?.providers?.openai;
  if (
    openaiProvider &&
    typeof openaiProvider.apiKey === "string" &&
    isOpenAISecretProxyPlaceholder(openaiProvider.apiKey)
  ) {
    next = {
      ...next,
      models: {
        ...next.models,
        providers: {
          ...next.models?.providers,
          openai: { ...openaiProvider, apiKey: null as unknown as ModelProviderConfig["apiKey"] },
        },
      },
    };
  }
  return next;
}

export function applyOpenAIApiConfigAsMergePatch(cfg: OpenClawConfig): OpenClawConfig {
  return applyOpenAIConfig(stripOpenAISecretProxyFromConfig(cfg));
}

function extractSecretProxyTripleFromParams(
  raw: Record<string, unknown> | undefined,
): Partial<Record<"secretProxyUrl" | "secretProxyKeyId" | "secretProxyEndpointUrl", unknown>> {
  if (!raw) {
    return {};
  }
  const out: Record<string, unknown> = {};
  if (typeof raw.secretProxyUrl === "string" && raw.secretProxyUrl.trim()) {
    out.secretProxyUrl = raw.secretProxyUrl.trim();
  }
  if (raw.secretProxyKeyId !== undefined) {
    out.secretProxyKeyId = raw.secretProxyKeyId;
  }
  if (typeof raw.secretProxyEndpointUrl === "string" && raw.secretProxyEndpointUrl.trim()) {
    out.secretProxyEndpointUrl = raw.secretProxyEndpointUrl.trim();
  }
  const scoped = raw.secretProxy;
  if (scoped && typeof scoped === "object" && !Array.isArray(scoped)) {
    const scopedRecord = scoped as Record<string, unknown>;
    if (
      out.secretProxyUrl === undefined &&
      typeof scopedRecord.url === "string" &&
      scopedRecord.url.trim()
    ) {
      out.secretProxyUrl = scopedRecord.url.trim();
    }
    if (out.secretProxyKeyId === undefined && scopedRecord.keyId !== undefined) {
      out.secretProxyKeyId = scopedRecord.keyId;
    }
    if (
      out.secretProxyEndpointUrl === undefined &&
      typeof scopedRecord.endpointUrl === "string" &&
      scopedRecord.endpointUrl.trim()
    ) {
      out.secretProxyEndpointUrl = scopedRecord.endpointUrl.trim();
    }
  }
  return out;
}

function resolveSecretProxyFallbackFromConfig(
  config: OpenClawConfig | undefined,
): Record<string, unknown> {
  const models = config?.agents?.defaults?.models;
  if (!models || typeof models !== "object") {
    return {};
  }
  const preferred = models[OPENAI_DEFAULT_MODEL]?.params;
  if (preferred && typeof preferred === "object" && !Array.isArray(preferred)) {
    const triple = extractSecretProxyTripleFromParams(preferred as Record<string, unknown>);
    if (triple.secretProxyUrl) {
      return { ...triple };
    }
  }
  for (const [key, entry] of Object.entries(models)) {
    if (!key.startsWith("openai/")) {
      continue;
    }
    const p = entry?.params;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      continue;
    }
    const triple = extractSecretProxyTripleFromParams(p as Record<string, unknown>);
    if (triple.secretProxyUrl) {
      return { ...triple };
    }
  }
  return {};
}

function mergeExtraParamsWithSecretProxyFallback(
  extraParams: Record<string, unknown> | undefined,
  config: OpenClawConfig | undefined,
): Record<string, unknown> | undefined {
  const fallback = resolveSecretProxyFallbackFromConfig(config);
  if (Object.keys(fallback).length === 0) {
    return extraParams;
  }
  return {
    ...fallback,
    ...(extraParams ?? {}),
  };
}
