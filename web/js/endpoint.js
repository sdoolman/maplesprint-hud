// @ts-check
"use strict";

export const ENDPOINT_CONFIG = Object.freeze({
  defaultUrl: "http://127.0.0.1:8080",
  defaultWgPort: 51820,
  statusPath: "/status",
  confPath: "/MapleSprint.conf",
  wsPath: "/ws",
  probeIntervalMs: 5000,
  minReconnectMs: 1500,
  maxReconnectMs: 15000,
});

/**
 * Validates and normalizes an endpoint HTTP(S) base URL and computes its matching WebSocket URL.
 * Rejects non-HTTP(S) schemes (e.g. javascript:, file:) or malformed URLs.
 * @param {string} raw
 * @param {string} [wsPath]
 * @returns {{ ok: true, httpBase: string, wsUrl: string } | { ok: false, error: string }}
 */
export function sanitizeEndpointUrl(raw, wsPath = ENDPOINT_CONFIG.wsPath) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return { ok: false, error: "Endpoint URL is required" };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid endpoint URL syntax" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Endpoint URL must use http:// or https://" };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "Endpoint URL is missing a hostname" };
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  const httpBase = `${parsed.origin}${cleanPath}`;
  const wsProto = parsed.protocol === "https:" ? "wss:" : "ws:";
  const cleanWsPath = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  return {
    ok: true,
    httpBase,
    wsUrl: `${wsProto}//${parsed.host}${cleanPath}${cleanWsPath}`,
  };
}

/**
 * Queries the local relay /status endpoint and returns typed health metadata.
 * @param {string} rawBaseUrl
 */
export async function probeEndpoint(rawBaseUrl) {
  const check = sanitizeEndpointUrl(rawBaseUrl);
  if (!check.ok) {
    return { ok: false, invalid: true, error: check.error, status: null };
  }
  try {
    const res = await fetch(`${check.httpBase}${ENDPOINT_CONFIG.statusPath}`, { cache: "no-store" });
    if (!res.ok) {
      return { ok: false, invalid: false, error: `HTTP ${res.status}`, status: null };
    }
    const status = await res.json();
    return { ok: true, invalid: false, error: null, status };
  } catch (err) {
    return { ok: false, invalid: false, error: err instanceof Error ? err.message : "Unreachable", status: null };
  }
}

function randomWireGuardKeyB64() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  bytes[0] &= 248;
  bytes[31] = (bytes[31] & 127) | 64;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Fetches MapleSprint.conf from the running endpoint relay, or builds a valid WireGuard template matching its WG port.
 * @param {string} rawBaseUrl
 * @param {number} [fallbackWgPort]
 */
export async function fetchWireGuardConf(rawBaseUrl, fallbackWgPort = ENDPOINT_CONFIG.defaultWgPort) {
  const check = sanitizeEndpointUrl(rawBaseUrl);
  if (check.ok) {
    try {
      const res = await fetch(`${check.httpBase}${ENDPOINT_CONFIG.confPath}`);
      if (res.ok) return await res.text();
    } catch {}
  }
  const port = Number.isInteger(fallbackWgPort) && fallbackWgPort > 0 ? fallbackWgPort : ENDPOINT_CONFIG.defaultWgPort;
  const clientPriv = randomWireGuardKeyB64();
  const peerPub = randomWireGuardKeyB64();
  return [
    "[Interface]",
    `PrivateKey = ${clientPriv}`,
    "Address = 10.66.66.2/32",
    "",
    "[Peer]",
    `PublicKey = ${peerPub}`,
    `Endpoint = 127.0.0.1:${port}`,
    "AllowedIPs = 158.115.192.0/19, 35.160.0.0/13, 166.117.0.0/16",
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

/** Manages the resilient WebSocket link to the endpoint relay with sanitized URLs and backoff. */
export class EndpointClient {
  /**
   * @param {{
   *   onOpen: () => void,
   *   onClose: () => void,
   *   onError: (reason: string) => void,
   *   onMessage: (rawData: string) => void,
   * }} handlers
   * @param {typeof ENDPOINT_CONFIG} [config]
   */
  constructor(handlers, config = ENDPOINT_CONFIG) {
    this.handlers = handlers;
    this.config = config;
    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {number | null} */
    this.reconnectTimer = null;
    /** @type {number} */
    this.reconnectDelayMs = config.minReconnectMs;
    this.lastRawUrl = "";
  }

  isOpen() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** @param {string} rawUrl */
  connect(rawUrl) {
    this.lastRawUrl = rawUrl;
    const validated = sanitizeEndpointUrl(rawUrl, this.config.wsPath);
    if (!validated.ok) {
      this.handlers.onError(validated.error);
      return false;
    }

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }

    try {
      this.ws = new WebSocket(validated.wsUrl);
    } catch {
      this.handlers.onError("Failed to open WebSocket connection");
      return false;
    }

    this.ws.onopen = () => {
      this.reconnectDelayMs = this.config.minReconnectMs;
      this.handlers.onOpen();
    };
    this.ws.onerror = () => {
      this.handlers.onError("Connection error");
    };
    this.ws.onclose = () => {
      this.handlers.onClose();
      this.scheduleReconnect();
    };
    this.ws.onmessage = (e) => {
      if (typeof e.data === "string") this.handlers.onMessage(e.data);
    };
    return true;
  }

  scheduleReconnect() {
    if (this.reconnectTimer !== null || !this.lastRawUrl) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.config.maxReconnectMs);
      this.connect(this.lastRawUrl);
    }, this.reconnectDelayMs);
  }
}
