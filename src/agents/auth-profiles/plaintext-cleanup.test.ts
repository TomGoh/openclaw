import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removePlaintextApiKeyProfilesForProvider, upsertAuthProfile } from "./profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";

const tempDirs: string[] = [];

function makeTempAgentDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-cleanup-"));
  tempDirs.push(root);
  return root;
}

describe("removePlaintextApiKeyProfilesForProvider", () => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes only plaintext api_key profiles for target provider", () => {
    const agentDir = makeTempAgentDir();
    upsertAuthProfile({
      profileId: "minimax:global",
      credential: { type: "api_key", provider: "minimax", key: "sk-real-minimax" },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "minimax:tee-global",
      credential: { type: "api_key", provider: "minimax", key: "openclaw-minimax-secret-proxy" },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "minimax:oauth",
      credential: {
        type: "oauth",
        provider: "minimax",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "openai:default",
      credential: { type: "api_key", provider: "openai", key: "sk-real-openai" },
      agentDir,
    });

    const removed = removePlaintextApiKeyProfilesForProvider({
      provider: "minimax",
      keepProfileIds: ["minimax:tee-global"],
      agentDir,
    });
    expect(removed).toEqual(["minimax:global"]);

    const store = ensureAuthProfileStore(agentDir);
    expect(store.profiles["minimax:global"]).toBeUndefined();
    expect(store.profiles["minimax:tee-global"]).toBeDefined();
    expect(store.profiles["minimax:oauth"]).toBeDefined();
    expect(store.profiles["openai:default"]).toBeDefined();
  });

  it("removes deleted profile ids from order/lastGood/usageStats", () => {
    const agentDir = makeTempAgentDir();
    upsertAuthProfile({
      profileId: "minimax:global",
      credential: { type: "api_key", provider: "minimax", key: "sk-real-minimax" },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "minimax:tee-global",
      credential: { type: "api_key", provider: "minimax", key: "openclaw-minimax-secret-proxy" },
      agentDir,
    });

    const store = ensureAuthProfileStore(agentDir);
    store.order = {
      minimax: ["minimax:global", "minimax:tee-global"],
    };
    store.lastGood = {
      minimax: "minimax:global",
    };
    store.usageStats = {
      "minimax:global": { lastUsed: Date.now() - 1_000 },
      "minimax:tee-global": { lastUsed: Date.now() },
    };
    saveAuthProfileStore(store, agentDir);

    removePlaintextApiKeyProfilesForProvider({
      provider: "minimax",
      keepProfileIds: ["minimax:tee-global"],
      agentDir,
    });

    const refreshed = ensureAuthProfileStore(agentDir);
    expect(refreshed.order?.minimax).toEqual(["minimax:tee-global"]);
    expect(refreshed.lastGood?.minimax).toBeUndefined();
    expect(refreshed.usageStats?.["minimax:global"]).toBeUndefined();
    expect(refreshed.usageStats?.["minimax:tee-global"]).toBeDefined();
  });
});
