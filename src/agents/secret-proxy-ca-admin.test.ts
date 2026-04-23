import { describe, expect, it, vi } from "vitest";
import { addWhitelistViaCa } from "./secret-proxy-ca-admin.js";

describe("addWhitelistViaCa", () => {
  it("posts to CA whitelist add endpoint with admin headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe("http://127.0.0.1:19030/admin/whitelist/add");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "X-Admin-Token": "token-123",
        "Content-Type": "application/json",
        "X-OpenClaw-Actor": "openclaw-configure",
        "X-Request-Id": "req-1",
      });
      expect(init?.body).toBe('{"pattern":"https://api.openai.com/"}');
      return {
        ok: true,
        status: 200,
        text: async () => '{"ok":true,"pattern":"https://api.openai.com/","added":true}',
      } as Response;
    });

    const result = await addWhitelistViaCa(
      {
        caBaseUrl: "http://127.0.0.1:19030/",
        adminToken: "token-123",
        pattern: "https://api.openai.com/",
        actor: "openclaw-configure",
        requestId: "req-1",
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toEqual({
      ok: true,
      pattern: "https://api.openai.com/",
      added: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
