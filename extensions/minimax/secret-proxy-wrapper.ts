// 将原本直接发给模型服务的请求，改写成发给"secret proxy" 服务。
// 这样可以把敏感信息（比如密钥）放在代理端处理，客户端只传 key_id 和请求内容字段，不直接暴露真实密钥.
// 本文件不是重新实现整套推理流程，而是包一层 wrapper，在发请求前，把请求体改写成 secret proxy 期望的格式。

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  completeSimple,
  createAssistantMessageEventStream,
  streamSimple,
} from "@mariozechner/pi-ai"; // 真正发 HTTP 请求的函数

/** 启用 secret proxy 时传给 pi-ai / Anthropic SDK 的 apiKey，避免真实 MiniMax 密钥出现在发往 CA 的 HTTP（如 X-Api-Key）中；由 TA 按 key_id 注入真密钥。 */
export const MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER = "openclaw-minimax-secret-proxy";

// 代理地址，代理使用的密钥ID，真实目标 endpoint URL。
const SECRET_PROXY_URL_ENV = "OPENCLAW_MINIMAX_SECRET_PROXY_URL";
const SECRET_PROXY_KEY_ID_ENV = "OPENCLAW_MINIMAX_SECRET_PROXY_KEY_ID";
const SECRET_PROXY_ENDPOINT_URL_ENV = "OPENCLAW_MINIMAX_SECRET_PROXY_ENDPOINT_URL";

type SecretProxyMethod = "Get" | "Post" | "Put" | "Delete" | "Patch";

// SecretProxyRequest 发给代理的 JSON 协议
type SecretProxyRequest = {
  key_id: number;
  endpoint_url: string;
  method: SecretProxyMethod;
  headers: Record<string, string>;
  body: number[];
};

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

function toHeaderMap(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      continue;
    }
    mapped[key] = value;
  }
  return mapped;
}

export function createMinimaxSecretProxyWrapper(params: {
  baseStreamFn?: StreamFn;
  extraParams?: Record<string, unknown>;
}): StreamFn {
  const underlying = params.baseStreamFn ?? streamSimple;
  const secretProxyUrl = resolveSecretProxyUrl(params.extraParams);
  if (!secretProxyUrl) {
    return underlying;
  }

  return (model, context, options) => {
    const originModelBaseUrl = model.baseUrl;
    const endpointUrl = resolveEndpointUrl(originModelBaseUrl, params.extraParams);
    const keyId = resolveSecretProxyKeyId(params.extraParams);
    const originalOnPayload = options?.onPayload;

    const proxyModel = { ...model, baseUrl: secretProxyUrl };
    const proxyOptions = {
      ...options,
      apiKey: MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER,
      onPayload: (payload: unknown) => {
        const onPayloadResult = originalOnPayload?.(payload, model);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return onPayloadResult;
        }
        // TA protocol is non-streaming (buffers full response), so force non-streaming requests.
        if ("stream" in payload && (payload as Record<string, unknown>).stream === true) {
          (payload as Record<string, unknown>).stream = false;
        }
        const payloadJson = JSON.stringify(payload);
        const proxyRequest: SecretProxyRequest = {
          key_id: keyId,
          endpoint_url: endpointUrl,
          method: "Post",
          headers: {
            ...toHeaderMap(model.headers),
            ...toHeaderMap(options?.headers),
          },
          body: Array.from(new TextEncoder().encode(payloadJson)),
        };
        Object.assign(payload as Record<string, unknown>, proxyRequest);
        return onPayloadResult;
      },
    } as const;

    // `StreamFn` must return an AssistantMessageEventStream. The default `streamSimple`
    // expects SSE-style chunked responses; secret proxy backends commonly return a
    // buffered body. Use `completeSimple` and adapt it to an event stream.
    const eventStream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const message = await completeSimple(
          proxyModel as never,
          context as never,
          proxyOptions as never,
        );
        eventStream.push({ type: "start", partial: message });
        const reason =
          message.stopReason === "stop" ||
          message.stopReason === "length" ||
          message.stopReason === "toolUse"
            ? message.stopReason
            : "stop";
        eventStream.push({ type: "done", reason, message });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const now = Date.now();
        const usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const errorAssistantMessage = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "" }],
          api: (proxyModel as Record<string, unknown>).api as never,
          provider: (proxyModel as Record<string, unknown>).provider as never,
          model: (proxyModel as Record<string, unknown>).id as never,
          usage,
          stopReason: "error" as const,
          errorMessage,
          timestamp: now,
        };
        eventStream.push({ type: "start", partial: errorAssistantMessage });
        eventStream.push({ type: "error", reason: "error", error: errorAssistantMessage });
      }
    })();
    return eventStream;
  };
}
