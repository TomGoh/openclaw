/**
 * Re-export secret_proxy_ca admin client for the MiniMax extension bundle.
 * Implementation lives in core so other provider plugins can share the same CA API.
 */
export type {
  CaHealthResponse,
  ListSlotsViaCaParams,
  ProvisionKeyViaCaParams,
  ProvisionKeyViaCaResult,
  RemoveKeyViaCaParams,
} from "openclaw/plugin-sdk/provider-auth";
export {
  fetchCaHealth,
  listSlotsViaCa,
  provisionKeyViaCa,
  removeKeyViaCa,
} from "openclaw/plugin-sdk/provider-auth";
