import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";

export function resolveProviderMatch(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  const raw = rawProvider?.trim();
  if (!raw) {
    return null;
  }
  const normalized = normalizeProviderId(raw);
  return (
    providers.find((provider) => normalizeProviderId(provider.id) === normalized) ??
    providers.find(
      (provider) =>
        provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false,
    ) ??
    null
  );
}

export function pickAuthMethod(
  provider: ProviderPlugin,
  rawMethod?: string,
): ProviderAuthMethod | null {
  const raw = rawMethod?.trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.toLowerCase();
  return (
    provider.auth.find((method) => method.id.toLowerCase() === normalized) ??
    provider.auth.find((method) => method.label.toLowerCase() === normalized) ??
    null
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Deep-merge `patch` into `base`. Plain objects merge recursively; **`null` in `patch` removes
 * the corresponding key** (JSON Merge Patch style) so auth `configPatch` can clear nested fields
 * such as `agents.defaults.models["minimax/…"].params.secretProxyUrl` when switching auth modes.
 */
export function mergeConfigPatch<T>(base: T, patch: unknown): T {
  if (patch === undefined) {
    return base;
  }
  if (!isPlainRecord(patch)) {
    return patch as T;
  }

  const baseRecord: Record<string, unknown> = isPlainRecord(base)
    ? { ...(base as Record<string, unknown>) }
    : {};
  const next: Record<string, unknown> = { ...baseRecord };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
      continue;
    }
    const existing = next[key];
    if (isPlainRecord(value)) {
      if (isPlainRecord(existing)) {
        next[key] = mergeConfigPatch(existing, value);
      } else {
        next[key] = mergeConfigPatch({}, value);
      }
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

export function applyDefaultModel(cfg: OpenClawConfig, model: string): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[model] = models[model] ?? {};

  const existingModel = cfg.agents?.defaults?.model;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
            ? { fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks }
            : undefined),
          primary: model,
        },
      },
    },
  };
}
