// 将原本直接发给模型服务的请求，改写成发给"secret proxy" 服务。
// 这样可以把敏感信息（比如密钥）放在代理端处理，客户端只传 key_id 和请求内容字段，不直接暴露真实密钥.
// 本文件不是重新实现整套推理流程，而是包一层 wrapper，在发请求前，把请求体改写成 secret proxy 期望的格式。

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai"; // 真正发 HTTP 请求的函数
import { MINIMAX_DEFAULT_MODEL_ID } from "openclaw/plugin-sdk/provider-models";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { createProviderSecretProxyWrapper } from "openclaw/plugin-sdk/provider-stream";

/** 启用 secret proxy 时传给 pi-ai / Anthropic SDK 的 apiKey，避免真实 MiniMax 密钥出现在发往 CA 的 HTTP（如 X-Api-Key）中；由 TA 按 key_id 注入真密钥。 */
export const MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER = "openclaw-minimax-secret-proxy";

// 代理地址，代理使用的密钥ID，真实目标 endpoint URL。
const SECRET_PROXY_URL_ENV = "OPENCLAW_MINIMAX_SECRET_PROXY_URL";
const SECRET_PROXY_KEY_ID_ENV = "OPENCLAW_MINIMAX_SECRET_PROXY_KEY_ID";
const SECRET_PROXY_ENDPOINT_URL_ENV = "OPENCLAW_MINIMAX_SECRET_PROXY_ENDPOINT_URL";

// 去掉末尾'/' ，避免后续拼接路径时出现 "//v1/messages" 之类的问题
function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

// 从环境变量或 extraParams 中获取 secret proxy URL
function resolveSecretProxyUrl(extraParams?: Record<string, unknown>): string | undefined {
  const fromExtraParams =
    typeof extraParams?.secretProxyUrl === "string" ? extraParams.secretProxyUrl.trim() : "";
  if (fromExtraParams) {
    // 如果 extraParams 中指定了 secret proxy URL，则使用 extraParams 中的 URL
    return normalizeBaseUrl(fromExtraParams);
  }
  // 如果环境变量中指定了 secret proxy URL，则使用环境变量中的 URL
  const fromEnv = process.env[SECRET_PROXY_URL_ENV]?.trim();
  // 如果环境变量中没有指定 secret proxy URL，则返回 undefined（意味着不启用代理，后面会走原始 underlying）
  return fromEnv ? normalizeBaseUrl(fromEnv) : undefined;
}

function resolveSecretProxyKeyId(extraParams?: Record<string, unknown>): number {
  const rawFromExtraParams = extraParams?.secretProxyKeyId;
  if (typeof rawFromExtraParams === "number" && Number.isFinite(rawFromExtraParams)) {
    return Math.max(0, Math.floor(rawFromExtraParams));
  }
  if (typeof rawFromExtraParams === "string" && rawFromExtraParams.trim()) {
    const parsed = Number.parseInt(rawFromExtraParams, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  const rawFromEnv = process.env[SECRET_PROXY_KEY_ID_ENV]?.trim();
  if (rawFromEnv) {
    const parsed = Number.parseInt(rawFromEnv, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return 0;
}

function resolveEndpointUrl(modelBaseUrl: unknown, extraParams?: Record<string, unknown>): string {
  const fromExtraParams =
    typeof extraParams?.secretProxyEndpointUrl === "string"
      ? extraParams.secretProxyEndpointUrl.trim()
      : "";
  if (fromExtraParams) {
    return fromExtraParams;
  }
  const fromEnv = process.env[SECRET_PROXY_ENDPOINT_URL_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const baseUrl = typeof modelBaseUrl === "string" ? modelBaseUrl.trim() : "";
  const normalizedBase = normalizeBaseUrl(baseUrl);
  return `${normalizedBase}/v1/messages`;
}

/** TEE onboarding only attaches secretProxy* to the default model ref; copy from there for other minimax/* models. */
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
  return out;
}

function resolveSecretProxyFallbackFromConfig(
  config: OpenClawConfig | undefined,
): Record<string, unknown> {
  const models = config?.agents?.defaults?.models;
  if (!models || typeof models !== "object") {
    return {};
  }
  const preferred = models[`minimax/${MINIMAX_DEFAULT_MODEL_ID}`]?.params;
  if (preferred && typeof preferred === "object" && !Array.isArray(preferred)) {
    const triple = extractSecretProxyTripleFromParams(preferred as Record<string, unknown>);
    if (triple.secretProxyUrl) {
      return { ...triple };
    }
  }
  for (const [key, entry] of Object.entries(models)) {
    if (!key.startsWith("minimax/")) {
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

export function createMinimaxSecretProxyWrapper(params: {
  baseStreamFn?: StreamFn;
  extraParams?: Record<string, unknown>;
  config?: OpenClawConfig;
}): StreamFn {
  const mergedParams = mergeExtraParamsWithSecretProxyFallback(params.extraParams, params.config);
  const underlying = params.baseStreamFn ?? streamSimple;
  const secretProxyUrl = resolveSecretProxyUrl(mergedParams);
  if (!secretProxyUrl) {
    return underlying;
  }

  return createProviderSecretProxyWrapper({
    baseStreamFn: underlying,
    secretProxyUrl,
    secretProxyKeyId: resolveSecretProxyKeyId(mergedParams),
    resolveEndpointUrl: (model) => resolveEndpointUrl(model.baseUrl, mergedParams),
    requestMethod: "Post",
    apiKeyPlaceholder: MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER,
  });
}
