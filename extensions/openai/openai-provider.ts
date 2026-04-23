import {
  type ProviderAuthContext,
  type ProviderAuthMethod,
  type ProviderAuthResult,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createProviderApiKeyAuthMethod,
  resolveSecretProxyApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import { addWhitelistViaCa, provisionKeyViaCa } from "openclaw/plugin-sdk/provider-auth";
import {
  applyOpenAIConfig,
  DEFAULT_CONTEXT_TOKENS,
  normalizeModelCompat,
  normalizeProviderId,
  OPENAI_DEFAULT_MODEL,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-models";
import {
  createOpenAIAttributionHeadersWrapper,
  createOpenAIDefaultTransportWrapper,
} from "openclaw/plugin-sdk/provider-stream";
import {
  applyOpenAIApiConfigAsMergePatch,
  buildOpenAISecretProxyConfigPatch,
  createOpenAISecretProxyWrapper,
} from "./secret-proxy.js";
import {
  cloneFirstTemplateModel,
  findCatalogTemplate,
  isOpenAIApiBaseUrl,
  matchesExactOrPrefix,
} from "./shared.js";

const PROVIDER_ID = "openai";
const OPENAI_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_GPT_54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_GPT_54_NANO_MODEL_ID = "gpt-5.4-nano";
const OPENAI_GPT_54_CONTEXT_TOKENS = 1_050_000;
const OPENAI_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.2"] as const;
const OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS = ["gpt-5.2-pro", "gpt-5.2"] as const;
const OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS = ["gpt-5-mini"] as const;
const OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS = ["gpt-5-nano", "gpt-5-mini"] as const;
const OPENAI_XHIGH_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
] as const;
const OPENAI_MODERN_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
] as const;
const OPENAI_DIRECT_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SUPPRESSED_SPARK_PROVIDERS = new Set(["openai", "azure-openai-responses"]);

const CA_ADMIN_TOKEN_ENV = "SECRET_PROXY_CA_ADMIN_TOKEN";

/** Matches `scripts/start-crosvm-tee*.sh` dev default; override via env or at prompt for production. */
const DEFAULT_SECRET_PROXY_CA_ADMIN_TOKEN = "dev-admin-token-change-me-please-0001";
const OPENAI_SECRET_PROXY_WHITELIST_PATTERN = "https://api.openai.com/";

function createOpenAISecretProxyAuthMethod(): ProviderAuthMethod {
  return {
    id: "api-secret-proxy",
    label: "OpenAI via Secret Proxy",
    hint: "Provision API key into TA via CA (same flow as MiniMax TEE / Secret Proxy)",
    kind: "custom",
    wizard: {
      choiceId: "openai-secret-proxy",
      choiceLabel: "OpenAI via Secret Proxy",
      choiceHint: "Key stays in TEE; OpenClaw stores proxy metadata only",
      groupId: "openai",
      groupLabel: "OpenAI",
      groupHint: "Codex OAuth + API key",
    },
    run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
      const envProxy =
        process.env.OPENCLAW_OPENAI_SECRET_PROXY_URL?.trim() ||
        process.env.OPENCLAW_MINIMAX_SECRET_PROXY_URL?.trim();
      const caBaseRaw = await ctx.prompter.text({
        message: "Secret proxy CA base URL (where secret_proxy_ca serve listens)",
        initialValue: envProxy ?? "http://127.0.0.1:19030",
        validate: (value) => {
          const v = value.trim();
          if (!v) {
            return "URL required";
          }
          try {
            new URL(v);
          } catch {
            return "Invalid URL";
          }
          return undefined;
        },
      });
      const caBaseUrl = caBaseRaw.trim();

      const envToken =
        process.env.SECRET_PROXY_CA_ADMIN_TOKEN?.trim() ||
        process.env.OPENCLAW_SECRET_PROXY_CA_ADMIN_TOKEN?.trim();
      const adminToken = await ctx.prompter.text({
        message: `Admin token (must match ${CA_ADMIN_TOKEN_ENV} on the CA host)`,
        initialValue: envToken ?? DEFAULT_SECRET_PROXY_CA_ADMIN_TOKEN,
        validate: (value) => (!value.trim() ? "Token required" : undefined),
      });

      const slotStr = await ctx.prompter.text({
        message: "TEE key slot index",
        initialValue: process.env.OPENCLAW_OPENAI_SECRET_PROXY_KEY_ID ?? "0",
        validate: (value) => {
          const n = Number.parseInt(value.trim(), 10);
          if (!Number.isFinite(n) || n < 0) {
            return "Enter a non-negative integer";
          }
          return undefined;
        },
      });
      const slot = Number.parseInt(slotStr.trim(), 10);
      const auditRequestId = `openai-configure-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

      const apiKey = await ctx.prompter.text({
        message: "OpenAI API key (sk-proj- or sk-...)",
        validate: (value) => (!value.trim() ? "API key required" : undefined),
      });

      await provisionKeyViaCa({
        caBaseUrl,
        adminToken: adminToken.trim(),
        slot,
        key: apiKey.trim(),
        provider: "openai",
        actor: "openclaw-configure",
        requestId: auditRequestId,
      });
      await addWhitelistViaCa({
        caBaseUrl,
        adminToken: adminToken.trim(),
        pattern: OPENAI_SECRET_PROXY_WHITELIST_PATTERN,
        actor: "openclaw-configure",
        requestId: auditRequestId,
      });

      const secretProxyUrl = caBaseUrl.replace(/\/+$/, "");
      const placeholderKey = resolveSecretProxyApiKeyMarker(PROVIDER_ID);
      return {
        profiles: [
          {
            profileId: "openai:secret-proxy",
            credential: {
              type: "api_key",
              provider: PROVIDER_ID,
              key: placeholderKey,
            },
          },
        ],
        configPatch: buildOpenAISecretProxyConfigPatch({
          config: ctx.config,
          placeholderApiKey: placeholderKey,
          secretProxyUrl,
          secretProxyKeyId: slot,
        }),
        defaultModel: OPENAI_DEFAULT_MODEL,
        notes: [
          "The API key was provisioned into the TEE via the CA; OpenClaw only stores a placeholder locally.",
          `Ensured TA whitelist includes ${OPENAI_SECRET_PROXY_WHITELIST_PATTERN}`,
          `Configured secret proxy metadata: slot=${slot}, url=${secretProxyUrl}`,
          `Keep secret_proxy_ca serve running; set ${CA_ADMIN_TOKEN_ENV} on the CA host to protect admin routes.`,
          "For non-interactive runs set OPENCLAW_OPENAI_SECRET_PROXY_URL and OPENCLAW_OPENAI_SECRET_PROXY_KEY_ID (or reuse OPENCLAW_MINIMAX_SECRET_PROXY_URL when sharing one CA).",
        ],
      };
    },
    runNonInteractive: async () => null,
  };
}

function normalizeOpenAITransport(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const useResponsesTransport =
    model.api === "openai-completions" && (!model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl));

  if (!useResponsesTransport) {
    return model;
  }

  return {
    ...model,
    api: "openai-responses",
  };
}

function resolveOpenAIGpt54ForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  let templateIds: readonly string[];
  let patch: Partial<ProviderRuntimeModel>;
  if (lower === OPENAI_GPT_54_MODEL_ID) {
    templateIds = OPENAI_GPT_54_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_GPT_54_PRO_MODEL_ID) {
    templateIds = OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_GPT_54_MINI_MODEL_ID) {
    templateIds = OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
    };
  } else if (lower === OPENAI_GPT_54_NANO_MODEL_ID) {
    templateIds = OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
    };
  } else {
    return undefined;
  }

  return (
    cloneFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId: trimmedModelId,
      templateIds,
      ctx,
      patch,
    }) ??
    normalizeModelCompat({
      id: trimmedModelId,
      name: trimmedModelId,
      ...patch,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: patch.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      maxTokens: patch.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    } as ProviderRuntimeModel)
  );
}

export function buildOpenAIProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "OpenAI",
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID,
        methodId: "api-key",
        label: "OpenAI API key",
        hint: "Direct OpenAI API key",
        optionKey: "openaiApiKey",
        flagName: "--openai-api-key",
        envVar: "OPENAI_API_KEY",
        promptMessage: "Enter OpenAI API key",
        defaultModel: OPENAI_DEFAULT_MODEL,
        expectedProviders: ["openai"],
        applyConfig: (cfg) => applyOpenAIApiConfigAsMergePatch(cfg),
        wizard: {
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API key",
          groupId: "openai",
          groupLabel: "OpenAI",
          groupHint: "Codex OAuth + API key",
        },
      }),
      createOpenAISecretProxyAuthMethod(),
    ],
    resolveDynamicModel: (ctx) => resolveOpenAIGpt54ForwardCompatModel(ctx),
    normalizeResolvedModel: (ctx) => {
      if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
        return undefined;
      }
      return normalizeOpenAITransport(ctx.model);
    },
    capabilities: {
      providerFamily: "openai",
    },
    wrapStreamFn: (ctx) =>
      createOpenAISecretProxyWrapper({
        baseStreamFn: createOpenAIAttributionHeadersWrapper(
          createOpenAIDefaultTransportWrapper(ctx.streamFn),
        ),
        extraParams: ctx.extraParams,
        config: ctx.config,
        placeholderApiKey: resolveSecretProxyApiKeyMarker(PROVIDER_ID),
      }),
    supportsXHighThinking: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_XHIGH_MODEL_IDS),
    isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_MODERN_MODEL_IDS),
    buildMissingAuthMessage: (ctx) => {
      if (ctx.provider !== PROVIDER_ID || ctx.listProfileIds("openai-codex").length === 0) {
        return undefined;
      }
      return 'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.';
    },
    suppressBuiltInModel: (ctx) => {
      if (
        !SUPPRESSED_SPARK_PROVIDERS.has(normalizeProviderId(ctx.provider)) ||
        ctx.modelId.toLowerCase() !== OPENAI_DIRECT_SPARK_MODEL_ID
      ) {
        return undefined;
      }
      return {
        suppress: true,
        errorMessage: `Unknown model: ${ctx.provider}/${OPENAI_DIRECT_SPARK_MODEL_ID}. ${OPENAI_DIRECT_SPARK_MODEL_ID} is only supported via openai-codex OAuth. Use openai-codex/${OPENAI_DIRECT_SPARK_MODEL_ID}.`,
      };
    },
    augmentModelCatalog: (ctx) => {
      const openAiGpt54Template = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54ProTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54MiniTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54NanoTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS,
      });
      return [
        openAiGpt54Template
          ? {
              ...openAiGpt54Template,
              id: OPENAI_GPT_54_MODEL_ID,
              name: OPENAI_GPT_54_MODEL_ID,
            }
          : undefined,
        openAiGpt54ProTemplate
          ? {
              ...openAiGpt54ProTemplate,
              id: OPENAI_GPT_54_PRO_MODEL_ID,
              name: OPENAI_GPT_54_PRO_MODEL_ID,
            }
          : undefined,
        openAiGpt54MiniTemplate
          ? {
              ...openAiGpt54MiniTemplate,
              id: OPENAI_GPT_54_MINI_MODEL_ID,
              name: OPENAI_GPT_54_MINI_MODEL_ID,
            }
          : undefined,
        openAiGpt54NanoTemplate
          ? {
              ...openAiGpt54NanoTemplate,
              id: OPENAI_GPT_54_NANO_MODEL_ID,
              name: OPENAI_GPT_54_NANO_MODEL_ID,
            }
          : undefined,
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
  };
}
