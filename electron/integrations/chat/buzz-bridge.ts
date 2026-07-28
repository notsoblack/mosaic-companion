/**
 * ChatBuzzBridge — Nostr relay bridge for Buzz agent dispatch
 *
 * Connects to a private Nostr relay, authenticates agents, and dispatches
 * them to Buzz channels via signed Nostr events.
 */

import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createHash, randomBytes } from "crypto";

// ── Crypto helpers ─────────────────────────────────────────────────
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function sha256(message: string): string {
  return createHash("sha256").update(message).digest("hex");
}

// Lazy-loaded secp256k1
let schnorrModule: any = null;
async function loadSchnorr() {
  if (schnorrModule) return schnorrModule;
  try {
    // Prefer @noble/curves (works out-of-the-box, no hash injection needed)
    const curves = await import("@noble/curves/secp256k1");
    schnorrModule = curves;
  } catch {
    // Fallback to @noble/secp256k1 with manual hash injection
    try {
      const noble = await import("@noble/secp256k1");
      const { sha256 } = await import("@noble/hashes/sha256");
      const { hmac } = await import("@noble/hashes/hmac");
      const hmacSha256 = (key: Uint8Array, message: Uint8Array) => {
        return hmac(sha256, key, message);
      };
      (noble.hashes as any).sha256 = sha256;
      (noble.hashes as any).hmacSha256 = hmacSha256;
      schnorrModule = noble;
    } catch {
      try {
        const pkg = await import("secp256k1");
        schnorrModule = pkg;
      } catch {
        schnorrModule = null;
      }
    }
  }
  return schnorrModule;
}

// Ensure schnorr is loaded at module init (best-effort)
loadSchnorr().catch(() => {});

// ── Configuration paths ────────────────────────────────────────────
const BRIDGE_DIR = path.join(os.homedir(), ".config", "mosaic-companion", "buzz-bridge");
const BRIDGE_CONFIG = path.join(BRIDGE_DIR, "buzz-bridge-config.json");
const BRIDGE_KEY_FILE = path.join(BRIDGE_DIR, "bridge-nostr-key.json");
const REAL_IDENTITY_FILE = path.join(os.homedir(), ".config", "mosaic-companion", "buzz-bridge", "bridge-nostr-key.json");

const DEFAULT_RELAY_URL = "wss://hpec-stargate.communities.buzz.xyz";

// ── Types ──────────────────────────────────────────────────────────
export interface BridgeConfig {
  enabled: boolean;
  relayUrl: string;
  roomMapping: Record<string, string>;
}

export interface BuzzStatus {
  enabled: boolean;
  connected: boolean;
  npub?: string;
  relayUrl: string;
  lastError?: string;
}

// ── BuzzRelayClient ────────────────────────────────────────────────
class BuzzRelayClient extends EventEmitter {
  private ws?: any;
  public isReadyFlag = false;
  public lastError?: string;
  private pendingAuth?: {
    resolve: (v: boolean) => void;
    reject: (e: Error) => void;
    timeout: NodeJS.Timeout;
  };

  constructor(
    private relayUrl: string,
    private pubkey: string,
    private privkey: Uint8Array,
  ) {
    super();
  }

  isReady(): boolean {
    return this.isReadyFlag && this.ws?.readyState === 1;
  }

  async connect(): Promise<void> {
    if (this.isReady()) return;

    return new Promise((resolve, reject) => {
      const WebSocket = require("ws");
      try {
        this.ws = new WebSocket(this.relayUrl);
      } catch (e: any) {
        reject(new Error(`WebSocket creation failed: ${e.message}`));
        return;
      }

      const authTimeout = setTimeout(() => {
        this._cleanupPendingAuth();
        reject(new Error("Auth timeout — relay did not respond with AUTH:OK"));
      }, 15000);

      this.pendingAuth = {
        resolve: (ok: boolean) => {
          clearTimeout(authTimeout);
          if (ok) resolve();
          else reject(new Error("Auth rejected"));
        },
        reject: (e: Error) => {
          clearTimeout(authTimeout);
          reject(e);
        },
        timeout: authTimeout,
      };

      this.ws!.on("open", () => {
        // NIP-42: wait for relay to send ["AUTH", challenge] before responding
        console.log("[ChatBuzzBridge] WebSocket open — awaiting NIP-42 challenge...");
      });

      this.ws!.on("message", (data: any) => {
        const msg = data.toString();
        this._handleMessage(msg);
      });

      this.ws!.on("close", (code: number, reason: Buffer) => {
        this.isReadyFlag = false;
        const reasonStr = reason?.toString() || "";
        if (this.pendingAuth) {
          this.pendingAuth.reject(new Error(`Connection closed: ${code} ${reasonStr}`));
          this.pendingAuth = undefined;
        }
        this.emit("close", code, reasonStr);
      });

      this.ws!.on("error", (err: Error) => {
        this.lastError = err.message;
        if (this.pendingAuth) {
          this.pendingAuth.reject(err);
          this.pendingAuth = undefined;
        }
        this.emit("error", err);
      });
    });
  }

  private _sendAuth() {
    const event = {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["relay", this.relayUrl]],
      content: "",
      pubkey: this.pubkey,
    };
    this._signAndSend("AUTH", event);
  }

  private _handleMessage(msg: string) {
    console.log("[ChatBuzzBridge] RAW relay msg:", msg.slice(0, 200));
    try {
      const parsed = JSON.parse(msg);
      if (!Array.isArray(parsed)) return;
      const [cmd, payload] = parsed;

      // NIP-42 challenge: relay sends ["AUTH", "challenge_string"]
      if (cmd === "AUTH" && typeof payload === "string" && payload !== "OK" && !payload.startsWith("restricted:")) {
        console.log("[ChatBuzzBridge] Got NIP-42 challenge:", payload.slice(0, 16) + "...");
        const event = {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", this.relayUrl],
            ["challenge", payload],
          ],
          content: "",
          pubkey: this.pubkey,
        };
        this._signAndSend("AUTH", event);
        return;
      }

      if (cmd === "AUTH" && payload === "OK") {
        this.isReadyFlag = true;
        this.lastError = undefined;
        if (this.pendingAuth) {
          this.pendingAuth.resolve(true);
          this.pendingAuth = undefined;
        }
        this.emit("ready");
      } else if (cmd === "AUTH" && typeof payload === "string" && payload.startsWith("restricted:")) {
        this.isReadyFlag = false;
        this.lastError = payload;
        if (this.pendingAuth) {
          this.pendingAuth.reject(new Error(`Auth failed: ${payload}`));
          this.pendingAuth = undefined;
        }
        this.emit("auth-failed", payload);
      } else if (cmd === "OK") {
        this.emit("event-ok", payload);
      } else if (cmd === "NOTICE") {
        this.emit("notice", payload);
      }
    } catch {
      // Ignore non-JSON messages
    }
  }

  private async _signAndSend(prefix: string, eventTemplate: any) {
    const schnorr = await loadSchnorr();
    if (!schnorr) {
      throw new Error("No schnorr module available");
    }
    const eventJson = JSON.stringify([
      0,
      eventTemplate.pubkey,
      eventTemplate.created_at,
      eventTemplate.kind,
      eventTemplate.tags,
      eventTemplate.content,
    ]);
    const id = sha256(eventJson);
    let sig: string;
    // Prefer @noble/curves API
    if (schnorr.schnorr?.sign) {
      const sigBytes = schnorr.schnorr.sign(hexToBytes(id), this.privkey);
      sig = bytesToHex(sigBytes instanceof Uint8Array ? sigBytes : new Uint8Array(sigBytes));
    } else if (schnorr.sign) {
      const sigBytes = await schnorr.sign(hexToBytes(id), this.privkey);
      sig = bytesToHex(sigBytes instanceof Uint8Array ? sigBytes : new Uint8Array(sigBytes));
    } else {
      throw new Error("Schnorr module missing sign function");
    }
    const signedEvent = { ...eventTemplate, id, sig };
    this.ws?.send(JSON.stringify([prefix, signedEvent]));
  }

  async publishEvent(kind: number, tags: string[][], content: string): Promise<void> {
    if (!this.isReady()) {
      throw new Error("Relay not ready — cannot publish event");
    }
    const event = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
      pubkey: this.pubkey,
    };
    await this._signAndSend("EVENT", event);
  }

  disconnect() {
    this._cleanupPendingAuth();
    this.isReadyFlag = false;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = undefined;
    }
  }

  private _cleanupPendingAuth() {
    if (this.pendingAuth) {
      clearTimeout(this.pendingAuth.timeout);
      this.pendingAuth = undefined;
    }
  }
}

// ── ChatBuzzBridge ─────────────────────────────────────────────────
export class ChatBuzzBridge {
  private relay?: BuzzRelayClient;
  private config: BridgeConfig;
  private _initPromise?: Promise<void>;
  private connecting = false;
  private keypair?: { pubkey: string; privkey: Uint8Array };

  constructor() {
    this.config = this._loadConfig();
  }

  private _loadConfig(): BridgeConfig {
    try {
      if (fs.existsSync(BRIDGE_CONFIG)) {
        const raw = fs.readFileSync(BRIDGE_CONFIG, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          enabled: parsed.enabled ?? false,
          relayUrl: parsed.relayUrl || DEFAULT_RELAY_URL,
          roomMapping: parsed.roomMapping || {},
        };
      }
    } catch (e) {
      console.error("[ChatBuzzBridge] Failed to load config:", e);
    }
    return { enabled: false, relayUrl: DEFAULT_RELAY_URL, roomMapping: {} };
  }

  private _saveConfig() {
    try {
      if (!fs.existsSync(BRIDGE_DIR)) fs.mkdirSync(BRIDGE_DIR, { recursive: true });
      fs.writeFileSync(BRIDGE_CONFIG, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.error("[ChatBuzzBridge] Failed to save config:", e);
    }
  }

  private _generateRandomKey(): Uint8Array {
    return new Uint8Array(randomBytes(32));
  }

  private _decodeNsec(nsec: string): string | null {
    try {
      const { bech32 } = require("bech32");
      const decoded = bech32.decode(nsec);
      const data = bech32.fromWords(decoded.words);
      return bytesToHex(Uint8Array.from(data));
    } catch {
      return null;
    }
  }

  private async _derivePubkey(priv: Uint8Array): Promise<string> {
    const schnorr = await loadSchnorr();
    try {
      // @noble/curves — getPublicKey returns 32-byte x-only directly
      if (schnorr?.schnorr?.getPublicKey) {
        const pub = schnorr.schnorr.getPublicKey(priv);
        const hex = bytesToHex(pub instanceof Uint8Array ? pub : new Uint8Array(pub));
        return hex.length === 64 ? hex : hex.slice(2); // safety: only slice if compressed
      }
      // @noble/secp256k1 — getPublicKey returns 33-byte compressed
      if (schnorr?.getPublicKey) {
        const pub = schnorr.getPublicKey(priv, true);
        const hex = bytesToHex(pub instanceof Uint8Array ? pub : new Uint8Array(pub));
        return hex.slice(2); // strip 02/03 prefix → x-only
      }
    } catch (e) {
      console.error("[ChatBuzzBridge] Failed to derive pubkey:", e);
    }
    return bytesToHex(priv); // fallback
  }

  private async loadOrCreateKey(): Promise<{ pubkey: string; privkey: Uint8Array }> {
    if (this.keypair) return this.keypair;

    // 1. Try real identity from mosaic-companion buzz-bridge
    try {
      if (fs.existsSync(REAL_IDENTITY_FILE)) {
        const raw = fs.readFileSync(REAL_IDENTITY_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.nsec || parsed.privkey) {
          const privHex = parsed.nsec?.startsWith("nsec1")
            ? this._decodeNsec(parsed.nsec)
            : parsed.privkey;
          if (privHex) {
            const priv = hexToBytes(privHex);
            const pubkey = await this._derivePubkey(priv);
            console.log("[ChatBuzzBridge] Using real identity key:", pubkey.slice(0, 16) + "...");
            this.keypair = { pubkey, privkey: priv };
            return this.keypair;
          }
        }
      }
    } catch (e) {
      console.error("[ChatBuzzBridge] Failed to load real identity:", e);
    }

    // 2. Try bridge key file
    try {
      if (fs.existsSync(BRIDGE_KEY_FILE)) {
        const raw = fs.readFileSync(BRIDGE_KEY_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.privkey) {
          const priv = hexToBytes(parsed.privkey);
          const pubkey = await this._derivePubkey(priv);
          this.keypair = { pubkey, privkey: priv };
          return this.keypair;
        }
      }
    } catch (e) {
      console.error("[ChatBuzzBridge] Failed to load bridge key:", e);
    }

    // 3. Generate new key
    const priv = this._generateRandomKey();
    const pubkey = await this._derivePubkey(priv);
    const keyData = { pubkey, privkey: bytesToHex(priv), created: new Date().toISOString() };
    try {
      if (!fs.existsSync(BRIDGE_DIR)) fs.mkdirSync(BRIDGE_DIR, { recursive: true });
      fs.writeFileSync(BRIDGE_KEY_FILE, JSON.stringify(keyData, null, 2));
      fs.chmodSync(BRIDGE_KEY_FILE, 0o600);
    } catch (e) {
      console.error("[ChatBuzzBridge] Failed to save key:", e);
    }
    this.keypair = { pubkey, privkey: priv };
    return this.keypair;
  }

  async init(): Promise<void> {
    if (this.relay?.isReady()) {
      console.log("[ChatBuzzBridge] Already connected, skipping init");
      return;
    }
    if (this._initPromise) {
      console.log("[ChatBuzzBridge] Init already in-flight, awaiting…");
      return this._initPromise;
    }
    this._initPromise = this._doInit();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = undefined;
    }
  }

  private async _doInit(): Promise<void> {
    if (!this.config.enabled) {
      console.log("[ChatBuzzBridge] Bridge disabled, skipping init");
      return;
    }
    if (this.connecting) {
      console.log("[ChatBuzzBridge] Connection already in progress");
      return;
    }
    if (this.relay && !this.relay.isReady()) {
      console.log("[ChatBuzzBridge] Disconnecting stale relay before reconnect");
      this.relay.disconnect();
      this.relay = undefined;
    }

    this.connecting = true;
    try {
      const key = await this.loadOrCreateKey();
      this.relay = new BuzzRelayClient(this.config.relayUrl, key.pubkey, key.privkey);
      await this.relay.connect();
      console.log(`[ChatBuzzBridge] Connected to ${this.config.relayUrl} as ${key.pubkey.slice(0, 16)}…`);
    } catch (e: any) {
      console.error(`[ChatBuzzBridge] Connect failed: ${e.message}`);
      this.relay = undefined;
      throw e;
    } finally {
      this.connecting = false;
    }
  }

  async importKey(nsecOrHex: string): Promise<{ success: boolean; npub?: string; error?: string }> {
    try {
      let privHex: string | null = null;
      if (nsecOrHex.startsWith("nsec1")) {
        privHex = this._decodeNsec(nsecOrHex);
      } else if (/^[0-9a-fA-F]{64}$/.test(nsecOrHex)) {
        privHex = nsecOrHex.toLowerCase();
      }
      if (!privHex) {
        return { success: false, error: "Invalid key format — expected nsec1… or 64-char hex" };
      }

      const priv = hexToBytes(privHex);
      const pubkey = await this._derivePubkey(priv);

      const keyData = {
        pubkey,
        privkey: privHex,
        imported: true,
        importedAt: new Date().toISOString(),
        role: "bridge",
      };
      if (!fs.existsSync(BRIDGE_DIR)) fs.mkdirSync(BRIDGE_DIR, { recursive: true });
      fs.writeFileSync(BRIDGE_KEY_FILE, JSON.stringify(keyData, null, 2));
      fs.chmodSync(BRIDGE_KEY_FILE, 0o600);

      // Reset init promise and reconnect with new identity
      this._initPromise = undefined;
      if (this.relay) {
        this.relay.disconnect();
        this.relay = undefined;
      }
      this.keypair = undefined; // force reload with new key
      await this.init();

      return { success: true, npub: pubkey };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async dispatchAgentJob(agentId: string, task: string, channelTag: string): Promise<{ success: boolean; jobId?: string; error?: string }> {
    if (!this.relay?.isReady()) {
      throw new Error("Relay not ready — cannot dispatch. Check connection status.");
    }

    const agentKey = await this._getAgentKey(agentId);
    if (!agentKey) {
      throw new Error(`Agent key not found for ${agentId}. Ensure agent has a Nostr keypair.`);
    }

    try {
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const content = JSON.stringify({
        type: "agent-deploy",
        agentId,
        task,
        channelTag,
        jobId,
        timestamp: Date.now(),
      });

      await this.relay.publishEvent(30078, [["h", channelTag]], content);
      console.log(`[ChatBuzzBridge] Dispatched job ${jobId} for agent ${agentId} to #${channelTag}`);
      return { success: true, jobId };
    } catch (e: any) {
      console.error("[ChatBuzzBridge] Dispatch failed:", e);
      throw new Error(`Failed to publish dispatch event: ${e.message}`);
    }
  }

  private async _getAgentKey(agentId: string): Promise<{ pubkey: string; privkey: Uint8Array } | null> {
    const bridgeKey = await this.loadOrCreateKey();
    const seed = sha256(bytesToHex(bridgeKey.privkey) + agentId);
    const priv = hexToBytes(seed);
    const pubkey = await this._derivePubkey(priv);
    return { pubkey, privkey: priv };
  }

  enable(enabled: boolean): BuzzStatus {
    this.config.enabled = enabled;
    this._saveConfig();
    if (enabled) {
      this.init().catch(e => console.error("[ChatBuzzBridge] Auto-init failed:", e));
    } else {
      if (this.relay) {
        this.relay.disconnect();
        this.relay = undefined;
      }
    }
    return this.status();
  }

  setRelay(url: string): BuzzStatus {
    this.config.relayUrl = url;
    this._saveConfig();
    if (this.relay) {
      this.relay.disconnect();
      this.relay = undefined;
    }
    if (this.config.enabled) {
      this.init().catch(e => console.error("[ChatBuzzBridge] Reconnect failed:", e));
    }
    return this.status();
  }

  status(): BuzzStatus {
    return {
      enabled: this.config.enabled,
      connected: this.relay?.isReady() ?? false,
      npub: this.keypair?.pubkey ?? (this.relay ? undefined : undefined),
      relayUrl: this.config.relayUrl,
      lastError: this.relay?.lastError,
    };
  }

  getConfig(): BridgeConfig {
    return { ...this.config };
  }

  disconnect() {
    if (this.relay) {
      this.relay.disconnect();
      this.relay = undefined;
    }
  }
}

// ── Module-level singleton ─────────────────────────────────────────
let buzzBridge: ChatBuzzBridge | null = null;
let chatInitCalled = false;

export function initChat(): ChatBuzzBridge {
  if (chatInitCalled) {
    console.log("[ChatInit] Already initialized, skipping duplicate initChat()");
    return buzzBridge!;
  }
  chatInitCalled = true;
  if (!buzzBridge) {
    buzzBridge = new ChatBuzzBridge();
  }
  return buzzBridge;
}

export function getBuzzBridge(): ChatBuzzBridge | null {
  return buzzBridge;
}
