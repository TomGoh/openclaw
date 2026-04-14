/**
 * HTTP client for secret_proxy_ca admin API (Plan B: provision keys via serve process).
 */

export type ProvisionKeyViaCaParams = {
  caBaseUrl: string;
  adminToken: string;
  slot: number;
  key: string;
  provider: "minimax";
  actor?: string;
  requestId?: string;
};

export type ProvisionKeyViaCaResult = {
  ok: boolean;
  slot: number;
  verified?: boolean;
  slots?: number[];
  slotEntries?: Array<{ slot: number; provider: string }>;
  verificationWarning?: string;
};

function normalizeCaBase(caBaseUrl: string): string {
  return caBaseUrl.trim().replace(/\/+$/, "");
}

function buildAdminHeaders(params: {
  adminToken: string;
  actor?: string;
  requestId?: string;
  includeJsonContentType?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = { "X-Admin-Token": params.adminToken };
  if (params.includeJsonContentType) {
    headers["Content-Type"] = "application/json";
  }
  if (params.actor?.trim()) {
    headers["X-OpenClaw-Actor"] = params.actor.trim();
  }
  if (params.requestId?.trim()) {
    headers["X-Request-Id"] = params.requestId.trim();
  }
  return headers;
}

/**
 * POST /admin/keys/provision — writes the key into the TA slot via the CA's TEEC session.
 */
export async function provisionKeyViaCa(
  params: ProvisionKeyViaCaParams,
  fetchFn: typeof fetch = fetch,
): Promise<ProvisionKeyViaCaResult> {
  const base = normalizeCaBase(params.caBaseUrl);
  const url = `${base}/admin/keys/provision`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: buildAdminHeaders({
      adminToken: params.adminToken,
      actor: params.actor,
      requestId: params.requestId,
      includeJsonContentType: true,
    }),
    body: JSON.stringify({
      slot: params.slot,
      key: params.key,
      provider: params.provider,
    }),
  });
  const text = await res.text();
  let parsed: {
    ok?: boolean;
    slot?: number;
    verified?: boolean;
    slots?: number[];
    slot_entries?: Array<{ slot: number; provider: string }>;
    verification_warning?: string;
    error?: unknown;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`CA provision failed (${res.status}): ${text}`);
  }
  if (!res.ok) {
    const errMsg = typeof parsed.error === "string" ? parsed.error : text || `HTTP ${res.status}`;
    throw new Error(`CA provision failed (${res.status}): ${errMsg}`);
  }
  if (!parsed.ok) {
    const errMsg = typeof parsed.error === "string" ? parsed.error : "provision rejected";
    throw new Error(errMsg);
  }
  return {
    ok: true,
    slot: parsed.slot ?? params.slot,
    verified: parsed.verified,
    slots: parsed.slots,
    slotEntries: parsed.slot_entries,
    verificationWarning: parsed.verification_warning,
  };
}

export type ListSlotsViaCaParams = {
  caBaseUrl: string;
  adminToken: string;
  actor?: string;
  requestId?: string;
};

/**
 * GET /admin/keys/slots — lists occupied key slots (optional helper).
 */
export async function listSlotsViaCa(
  params: ListSlotsViaCaParams,
  fetchFn: typeof fetch = fetch,
): Promise<number[]> {
  const base = normalizeCaBase(params.caBaseUrl);
  const url = `${base}/admin/keys/slots`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: buildAdminHeaders({
      adminToken: params.adminToken,
      actor: params.actor,
      requestId: params.requestId,
    }),
  });
  const text = await res.text();
  let parsed: {
    ok?: boolean;
    slots?: number[];
    slot_entries?: Array<{ slot: number; provider: string }>;
    meta_warning?: string;
    error?: unknown;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`CA list slots failed (${res.status}): ${text}`);
  }
  if (!res.ok) {
    const errMsg = typeof parsed.error === "string" ? parsed.error : text || `HTTP ${res.status}`;
    throw new Error(`CA list slots failed (${res.status}): ${errMsg}`);
  }
  if (!parsed.ok || !Array.isArray(parsed.slots)) {
    const errMsg = typeof parsed.error === "string" ? parsed.error : "invalid response";
    throw new Error(errMsg);
  }
  return parsed.slots;
}

export type RemoveKeyViaCaParams = {
  caBaseUrl: string;
  adminToken: string;
  slot: number;
  actor?: string;
  requestId?: string;
};

/**
 * POST /admin/keys/remove — removes one key slot via CA's TEEC session.
 */
export async function removeKeyViaCa(
  params: RemoveKeyViaCaParams,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; slot: number; slots?: number[]; verificationWarning?: string }> {
  const base = normalizeCaBase(params.caBaseUrl);
  const url = `${base}/admin/keys/remove`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: buildAdminHeaders({
      adminToken: params.adminToken,
      actor: params.actor,
      requestId: params.requestId,
      includeJsonContentType: true,
    }),
    body: JSON.stringify({
      slot: params.slot,
    }),
  });
  const text = await res.text();
  let parsed: {
    ok?: boolean;
    slot?: number;
    slots?: number[];
    verification_warning?: string;
    error?: unknown;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`CA remove failed (${res.status}): ${text}`);
  }
  if (!res.ok) {
    const errMsg = typeof parsed.error === "string" ? parsed.error : text || `HTTP ${res.status}`;
    throw new Error(`CA remove failed (${res.status}): ${errMsg}`);
  }
  if (!parsed.ok) {
    const errMsg = typeof parsed.error === "string" ? parsed.error : "remove rejected";
    throw new Error(errMsg);
  }
  return {
    ok: true,
    slot: parsed.slot ?? params.slot,
    slots: parsed.slots,
    verificationWarning: parsed.verification_warning,
  };
}

export type CaHealthResponse = {
  ok: boolean;
  service?: string;
  teec_session?: string;
  ta?: {
    reachable: boolean;
    probe?: string;
    slots?: number[];
    slot_entries?: Array<{ slot: number; provider: string }>;
    meta_warning?: string;
    error_layer?: string;
    message?: string;
  };
};

/**
 * GET /health — TEEC session + TA list probe (no admin token).
 */
export async function fetchCaHealth(
  caBaseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<CaHealthResponse> {
  const base = normalizeCaBase(caBaseUrl);
  const url = `${base}/health`;
  const res = await fetchFn(url, { method: "GET" });
  const text = await res.text();
  let parsed: CaHealthResponse;
  try {
    parsed = JSON.parse(text) as CaHealthResponse;
  } catch {
    throw new Error(`CA health failed (${res.status}): ${text}`);
  }
  if (!res.ok) {
    throw new Error(`CA health HTTP ${res.status}: ${text}`);
  }
  return parsed;
}
