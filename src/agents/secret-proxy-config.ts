import type { OpenClawConfig } from "../config/config.js";

export type ProviderSecretProxyTriple = {
  secretProxyUrl: string;
  secretProxyKeyId?: unknown;
  secretProxyEndpointUrl?: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// 将原始数据转换为 ProviderSecretProxyTriple 类型，
// 同时支持 旧版本（secretProxyUrl、secretProxyKeyId、secretProxyEndpointUrl）和 新版本（secretProxy.url、secretProxy.keyId、secretProxy.endpointUrl）两种格式
function coerceSecretProxyTriple(
  raw: Record<string, unknown>,
): ProviderSecretProxyTriple | undefined {
  const legacyUrl =
    typeof raw.secretProxyUrl === "string" && raw.secretProxyUrl.trim()
      ? raw.secretProxyUrl.trim()
      : undefined;
  const scoped = isPlainRecord(raw.secretProxy) ? raw.secretProxy : undefined;
  const scopedUrl =
    scoped && typeof scoped.url === "string" && scoped.url.trim() ? scoped.url.trim() : undefined;
  const secretProxyUrl = legacyUrl ?? scopedUrl;
  if (!secretProxyUrl) {
    return undefined;
  }

  const legacyKeyId = raw.secretProxyKeyId;
  const scopedKeyId = scoped?.keyId;
  const legacyEndpoint =
    typeof raw.secretProxyEndpointUrl === "string" && raw.secretProxyEndpointUrl.trim()
      ? raw.secretProxyEndpointUrl.trim()
      : undefined;
  const scopedEndpoint =
    scoped && typeof scoped.endpointUrl === "string" && scoped.endpointUrl.trim()
      ? scoped.endpointUrl.trim()
      : undefined;
  return {
    secretProxyUrl,
    ...(legacyKeyId !== undefined || scopedKeyId !== undefined
      ? { secretProxyKeyId: legacyKeyId ?? scopedKeyId }
      : {}),
    ...(legacyEndpoint || scopedEndpoint
      ? { secretProxyEndpointUrl: legacyEndpoint ?? scopedEndpoint }
      : {}),
  };
}

export function extractProviderSecretProxyTripleFromModelParams(
  raw: unknown,
): ProviderSecretProxyTriple | undefined {
  if (!isPlainRecord(raw)) {
    return undefined;
  }
  return coerceSecretProxyTriple(raw);
}

// 检查是否启用 secret proxy，通过环境变量或模型参数中的 secretProxy* 字段
export function hasProviderSecretProxyEnabled(params: {
  config: OpenClawConfig | undefined;
  providerId: string;
  envVarNames?: string[];
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = params.env ?? process.env;
  for (const envVarName of params.envVarNames ?? []) {
    const value = env[envVarName]?.trim();
    if (value) {
      return true;
    }
  }
  const models = params.config?.agents?.defaults?.models;
  if (!models || typeof models !== "object") {
    return false;
  }
  for (const [key, entry] of Object.entries(models)) {
    if (!key.startsWith(`${params.providerId}/`)) {
      continue;
    }
    const triple = extractProviderSecretProxyTripleFromModelParams(entry?.params);
    if (triple?.secretProxyUrl) {
      return true;
    }
  }
  return false;
}
