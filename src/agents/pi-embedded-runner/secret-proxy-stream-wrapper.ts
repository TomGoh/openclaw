import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

type SecretProxyMethod = "Get" | "Post" | "Put" | "Delete" | "Patch";

type SecretProxyRequest = {
  key_id: number;
  endpoint_url: string;
  method: SecretProxyMethod;
  headers: Record<string, string>;
  body: number[];
};

function toHeaderMap(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      mapped[key] = value;
    }
  }
  return mapped;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveKeyId(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return 0;
}

export function createProviderSecretProxyWrapper(params: {
  baseStreamFn?: StreamFn;
  secretProxyUrl?: string;
  secretProxyKeyId?: unknown;
  endpointUrl?: string;
  resolveEndpointUrl?: (model: { baseUrl?: string | undefined }) => string;
  requestMethod?: SecretProxyMethod;
  apiKeyPlaceholder: string;
}): StreamFn {
  const underlying = params.baseStreamFn ?? streamSimple;
  const secretProxyUrl = params.secretProxyUrl?.trim();
  if (!secretProxyUrl) {
    return underlying;
  }
  const normalizedProxyUrl = normalizeBaseUrl(secretProxyUrl);
  const keyId = resolveKeyId(params.secretProxyKeyId);
  const requestMethod = params.requestMethod ?? "Post";

  return (model, context, options) => {
    const endpointUrl =
      params.resolveEndpointUrl?.({
        baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      }) ??
      params.endpointUrl?.trim() ??
      `${normalizeBaseUrl(String(model.baseUrl ?? ""))}/v1/messages`;
    const originalOnPayload = options?.onPayload;
    const proxyModel = { ...model, baseUrl: normalizedProxyUrl };
    const proxyOptions = {
      ...options,
      apiKey: params.apiKeyPlaceholder,
      onPayload: (payload: unknown) => {
        const onPayloadResult = originalOnPayload?.(payload, model);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return onPayloadResult;
        }
        const proxyRequest: SecretProxyRequest = {
          key_id: keyId,
          endpoint_url: endpointUrl,
          method: requestMethod,
          headers: {
            ...toHeaderMap(model.headers),
            ...toHeaderMap(options?.headers),
          },
          body: Array.from(new TextEncoder().encode(JSON.stringify(payload))),
        };
        Object.assign(payload as Record<string, unknown>, proxyRequest);
        return onPayloadResult;
      },
    } as const;

    return underlying(proxyModel as never, context as never, proxyOptions as never);
  };
}
