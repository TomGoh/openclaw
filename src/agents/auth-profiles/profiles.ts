import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { normalizeProviderId, normalizeProviderIdForAuth } from "../provider-id.js";
import {
  ensureAuthProfileStore,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

export function dedupeProfileIds(profileIds: string[]): string[] {
  return [...new Set(profileIds)];
}

export async function setAuthProfileOrder(params: {
  agentDir?: string;
  provider: string;
  order?: string[] | null;
}): Promise<AuthProfileStore | null> {
  const providerKey = normalizeProviderId(params.provider);
  const sanitized =
    params.order && Array.isArray(params.order) ? normalizeStringEntries(params.order) : [];
  const deduped = dedupeProfileIds(sanitized);

  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      store.order = store.order ?? {};
      if (deduped.length === 0) {
        if (!store.order[providerKey]) {
          return false;
        }
        delete store.order[providerKey];
        if (Object.keys(store.order).length === 0) {
          store.order = undefined;
        }
        return true;
      }
      store.order[providerKey] = deduped;
      return true;
    },
  });
}

export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): void {
  const credential =
    params.credential.type === "api_key"
      ? {
          ...params.credential,
          ...(typeof params.credential.key === "string"
            ? { key: normalizeSecretInput(params.credential.key) }
            : {}),
        }
      : params.credential.type === "token"
        ? { ...params.credential, token: normalizeSecretInput(params.credential.token) }
        : params.credential;
  const store = ensureAuthProfileStore(params.agentDir);
  store.profiles[params.profileId] = credential;
  saveAuthProfileStore(store, params.agentDir);
}

export function removePlaintextApiKeyProfilesForProvider(params: {
  provider: string;
  keepProfileIds?: string[];
  agentDir?: string;
}): string[] {
  const store = ensureAuthProfileStore(params.agentDir);
  const providerKey = normalizeProviderIdForAuth(params.provider);
  const keepIds = new Set(
    (params.keepProfileIds ?? []).map((value) => value.trim()).filter(Boolean),
  );
  const removed: string[] = [];

  for (const [profileId, credential] of Object.entries(store.profiles)) {
    if (keepIds.has(profileId)) {
      continue;
    }
    if (normalizeProviderIdForAuth(credential.provider) !== providerKey) {
      continue;
    }
    if (credential.type !== "api_key") {
      continue;
    }
    if (typeof credential.key !== "string" || credential.key.trim().length === 0) {
      continue;
    }
    delete store.profiles[profileId];
    removed.push(profileId);
  }

  if (removed.length === 0) {
    return removed;
  }

  const removedSet = new Set(removed);
  if (store.order && typeof store.order === "object") {
    for (const [providerId, order] of Object.entries(store.order)) {
      if (normalizeProviderIdForAuth(providerId) !== providerKey || !Array.isArray(order)) {
        continue;
      }
      const nextOrder = order.filter((profileId) => !removedSet.has(profileId));
      if (nextOrder.length > 0) {
        store.order[providerId] = nextOrder;
      } else {
        delete store.order[providerId];
      }
    }
    if (Object.keys(store.order).length === 0) {
      store.order = undefined;
    }
  }

  if (store.lastGood && typeof store.lastGood === "object") {
    for (const [providerId, profileId] of Object.entries(store.lastGood)) {
      if (
        normalizeProviderIdForAuth(providerId) === providerKey &&
        typeof profileId === "string" &&
        removedSet.has(profileId)
      ) {
        delete store.lastGood[providerId];
      }
    }
    if (Object.keys(store.lastGood).length === 0) {
      store.lastGood = undefined;
    }
  }

  if (store.usageStats && typeof store.usageStats === "object") {
    for (const profileId of removed) {
      delete store.usageStats[profileId];
    }
    if (Object.keys(store.usageStats).length === 0) {
      store.usageStats = undefined;
    }
  }

  saveAuthProfileStore(store, params.agentDir);
  return removed;
}

export async function upsertAuthProfileWithLock(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      store.profiles[params.profileId] = params.credential;
      return true;
    },
  });
}

export function listProfilesForProvider(store: AuthProfileStore, provider: string): string[] {
  const providerKey = normalizeProviderIdForAuth(provider);
  return Object.entries(store.profiles)
    .filter(([, cred]) => normalizeProviderIdForAuth(cred.provider) === providerKey)
    .map(([id]) => id);
}

export async function markAuthProfileGood(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, provider, profileId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile || profile.provider !== provider) {
        return false;
      }
      freshStore.lastGood = { ...freshStore.lastGood, [provider]: profileId };
      return true;
    },
  });
  if (updated) {
    store.lastGood = updated.lastGood;
    return;
  }
  const profile = store.profiles[profileId];
  if (!profile || profile.provider !== provider) {
    return;
  }
  store.lastGood = { ...store.lastGood, [provider]: profileId };
  saveAuthProfileStore(store, agentDir);
}
