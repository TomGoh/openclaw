import type { StreamFn } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMinimaxSecretProxyWrapper,
  MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER,
} from "./secret-proxy-wrapper.js";

describe("minimax secret proxy wrapper", () => {
  beforeEach(() => {
    delete process.env.OPENCLAW_MINIMAX_SECRET_PROXY_URL;
    delete process.env.OPENCLAW_MINIMAX_SECRET_PROXY_KEY_ID;
    delete process.env.OPENCLAW_MINIMAX_SECRET_PROXY_ENDPOINT_URL;
  });

  it("keeps original stream function when secret proxy is disabled", () => {
    const baseStreamFn = vi.fn() as unknown as StreamFn;
    const wrapped = createMinimaxSecretProxyWrapper({ baseStreamFn });
    expect(wrapped).toBe(baseStreamFn);
  });

  it("rewrites payload to TA proxy request format", () => {
    process.env.OPENCLAW_MINIMAX_SECRET_PROXY_URL = "http://127.0.0.1:18790";
    process.env.OPENCLAW_MINIMAX_SECRET_PROXY_KEY_ID = "7";

    const capture: {
      model?: Record<string, unknown>;
      payload?: Record<string, unknown>;
      optionsApiKey?: string;
    } = {};
    const baseStreamFn: StreamFn = (model, _context, options) => {
      capture.model = model as unknown as Record<string, unknown>;
      capture.optionsApiKey = options?.apiKey as string | undefined;
      const payload = {
        model: "MiniMax-M2.7",
        messages: [{ role: "user", content: "hello" }],
      } as Record<string, unknown>;
      options?.onPayload?.(payload, model);
      capture.payload = payload;
      return {} as never;
    };

    const wrapped = createMinimaxSecretProxyWrapper({ baseStreamFn });
    wrapped(
      {
        provider: "minimax",
        id: "MiniMax-M2.7",
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
        headers: { "X-Model": "m2.7" },
      } as never,
      {} as never,
      {
        apiKey: "sk-real-key-should-not-reach-proxy-http",
        headers: { Authorization: "Bearer sk-test" },
      } as never,
    );

    expect(capture.optionsApiKey).toBe(MINIMAX_SECRET_PROXY_API_KEY_PLACEHOLDER);
    expect(capture.model?.baseUrl).toBe("http://127.0.0.1:18790");
    expect(capture.payload?.key_id).toBe(7);
    expect(capture.payload?.endpoint_url).toBe("https://api.minimax.io/anthropic/v1/messages");
    expect(capture.payload?.method).toBe("Post");
    expect(capture.payload?.headers).toEqual({
      "X-Model": "m2.7",
      Authorization: "Bearer sk-test",
    });
    const encodedBody = capture.payload?.body as number[];
    expect(Array.isArray(encodedBody)).toBe(true);
    const decoded = Buffer.from(encodedBody).toString("utf8");
    expect(JSON.parse(decoded)).toEqual({
      model: "MiniMax-M2.7",
      messages: [{ role: "user", content: "hello" }],
    });
  });
});
