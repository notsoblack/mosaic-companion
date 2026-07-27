#!/usr/bin/env node
/**
 * Buzz MCP Server — Nostr Relay Bridge for Mosaic Companion
 *
 * Exposes Buzz workspace operations via Model Context Protocol (stdio).
 * Connects to a Buzz Nostr relay, authenticates via NIP-42, and provides
 * tools for publishing events, subscribing to channels, querying history,
 * and dispatching agent jobs.
 *
 * Security model:
 *   - Nostr keys are isolated from wallet keys (Dr. Robert policy)
 *   - Private key is auto-generated or loaded from BUZZ_KEY_PATH
 *   - Never interacts with wallet:sign or wallet:write
 *   - Key storage is separate from all wallet/1AM/Midnight storage paths
 *
 * Protocol: MCP 2024-11-05 (stdio / JSON-RPC 2.0)
 * Nostr: NIP-01 wire format, NIP-42 auth
 *
 * Dependencies: Node.js built-ins + @noble/curves + @noble/hashes
 * (These are already available in the project's node_modules via
 *  transitive dependencies from the Midnight wallet SDK.)
 */

const { createHash, randomBytes } = require("crypto");
const WebSocket = require("ws");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─────────────────────────────────────────────────────────────────────────────
// Resolve @noble packages from project node_modules
// ─────────────────────────────────────────────────────────────────────────────

function requireNoble(name) {
  // In dev: project root is a few levels up from this file
  const candidates = [
    path.join(__dirname, "..", "..", "..", "..", "node_modules", name),
    path.join(__dirname, "..", "..", "..", "node_modules", name),
    path.join(__dirname, "..", "..", "node_modules", name),
    path.join(__dirname, "..", "node_modules", name),
    path.join(process.cwd(), "node_modules", name),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        return require(c);
      } catch {}
    }
  }
  // Final fallback: let Node resolve normally (works when cwd is project root)
  return require(name);
}

let schnorrModule, sha256Lib, utils;
try {
  const secp = requireNoble("@noble/curves/secp256k1");
  schnorrModule = secp.schnorr;
  sha256Lib = requireNoble("@noble/hashes/sha256").sha256;
  utils = requireNoble("@noble/hashes/utils");
} catch (e) {
  console.error("[buzz-mcp] Failed to load @noble/curves or @noble/hashes.", e.message);
  console.error("  Ensure the MCP server runs from the project directory where node_modules exists.");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const BUZZ_RELAY_URL = process.env.BUZZ_RELAY_URL || "wss://hpec-stargate.communities.buzz.xyz";
const BUZZ_KEY_PATH =
  process.env.BUZZ_KEY_PATH ||
  path.join(os.homedir(), ".config", "mosaic-companion", "buzz-nostr-key.json");
const BUZZ_CHANNEL_ID = process.env.BUZZ_CHANNEL_ID || "";

// ─────────────────────────────────────────────────────────────────────────────
// Nostr Crypto
// ─────────────────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sha256Hex(data) {
  const hash = createHash("sha256");
  hash.update(data);
  return hash.digest("hex");
}

function serializeEvent(evt) {
  return JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
}

function getEventHash(evt) {
  return sha256Hex(serializeEvent(evt));
}

function signEvent(evt, privKeyHex) {
  const privKey = hexToBytes(privKeyHex);
  const eventHash = getEventHash(evt);
  const sig = schnorrModule.sign(eventHash, privKey);
  return {
    ...evt,
    id: eventHash,
    sig: bytesToHex(sig),
  };
}

function getPublicKey(privKeyHex) {
  return bytesToHex(schnorrModule.getPublicKey(hexToBytes(privKeyHex)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Key Management
// ─────────────────────────────────────────────────────────────────────────────

function ensureKey() {
  // Prefer real identity key from buzz-bridge
  const realKeyPath = path.join(os.homedir(), ".config", "mosaic-companion", "buzz-bridge", "bridge-nostr-key.json");
  try {
    if (fs.existsSync(realKeyPath)) {
      const data = JSON.parse(fs.readFileSync(realKeyPath, "utf8"));
      if (data.nsec && /^[0-9a-f]{64}$/i.test(data.nsec)) {
        const npub = getPublicKey(data.nsec);
        console.error(`[buzz-mcp] Using real identity key: ${npub.slice(0, 16)}...`);
        return { privKey: data.nsec, npub };
      }
    }
  } catch (e) {}

  try {
    if (fs.existsSync(BUZZ_KEY_PATH)) {
      const data = JSON.parse(fs.readFileSync(BUZZ_KEY_PATH, "utf8"));
      if (data.nsec && /^[0-9a-f]{64}$/i.test(data.nsec)) {
        return { privKey: data.nsec, npub: getPublicKey(data.nsec) };
      }
    }
  } catch (e) {
    /* ignore corrupt key file */
  }

  // Generate new key
  const privKey = bytesToHex(randomBytes(32));
  const npub = getPublicKey(privKey);
  const dir = path.dirname(BUZZ_KEY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(
    BUZZ_KEY_PATH,
    JSON.stringify({ nsec: privKey, npub, createdAt: Date.now() }, null, 2),
    { mode: 0o600 }
  );
  console.error(`[buzz-mcp] Generated new Nostr key: ${npub.slice(0, 16)}... at ${BUZZ_KEY_PATH}`);
  return { privKey, npub };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relay Connection
// ─────────────────────────────────────────────────────────────────────────────

class BuzzRelay {
  constructor(url, privKey, npub) {
    this.url = url;
    this.privKey = privKey;
    this.npub = npub;
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.subCounter = 0;
    this.subs = new Map(); // subId -> { filters, onEvent, onEose }
    this.pendingAuth = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        return reject(e);
      }

      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout (10s)"));
      }, 10000);

      this.ws.on("open", () => {
        this.connected = true;
        clearTimeout(timeout);
        // Wait for AUTH challenge before resolving
        this.pendingAuth = { resolve, reject };
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch {}
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.authenticated = false;
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  _handleMessage(msg) {
    if (!Array.isArray(msg)) return;
    const [type, ...rest] = msg;

    if (type === "AUTH" && rest[0]) {
      // NIP-42 challenge
      const challenge = rest[0];
      const authEvent = {
        pubkey: this.npub,
        created_at: Math.floor(Date.now() / 1000),
        kind: 22242,
        tags: [
          ["relay", this.url],
          ["challenge", challenge],
        ],
        content: "",
      };
      const signed = signEvent(authEvent, this.privKey);
      this.send(["AUTH", signed]);
      return;
    }

    if (type === "OK" && rest[0] && rest[1] === true) {
      this.authenticated = true;
      if (this.pendingAuth) {
        this.pendingAuth.resolve(true);
        this.pendingAuth = null;
      }
      return;
    }

    if (type === "OK" && rest[1] === false && this.pendingAuth) {
      this.pendingAuth.reject(new Error(`Auth failed: ${rest[2] || "unknown"}`));
      this.pendingAuth = null;
      return;
    }

    if (type === "EVENT" && rest[1]) {
      const subId = rest[0];
      const event = rest[1];
      const sub = this.subs.get(subId);
      if (sub && sub.onEvent) sub.onEvent(event);
      return;
    }

    if (type === "EOSE" && rest[0]) {
      const subId = rest[0];
      const sub = this.subs.get(subId);
      if (sub && sub.onEose) {
        sub.onEose();
        // Clean up subscription after EOSE for query-type subs
        if (sub.autoClose) {
          this.send(["CLOSE", subId]);
          this.subs.delete(subId);
        }
      }
      return;
    }

    if (type === "NOTICE" && rest[0]) {
      console.error(`[buzz-mcp] Relay notice: ${rest[0]}`);
    }
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  publishEvent(kind, content, tags = []) {
    if (!this.authenticated) {
      return Promise.reject(new Error("Not authenticated to relay"));
    }
    const event = {
      pubkey: this.npub,
      created_at: Math.floor(Date.now() / 1000),
      kind,
      tags,
      content: typeof content === "string" ? content : JSON.stringify(content),
    };
    const signed = signEvent(event, this.privKey);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Publish timeout (10s)")), 10000);
      const checkOk = (msg) => {
        if (Array.isArray(msg) && msg[0] === "OK" && msg[1] === signed.id) {
          clearTimeout(timeout);
          this.ws.off("message", checkOkWrapper);
          resolve({ eventId: signed.id, accepted: msg[2] === true });
        }
      };
      const checkOkWrapper = (data) => {
        try {
          const m = JSON.parse(data.toString());
          checkOk(m);
        } catch {}
      };
      this.ws.on("message", checkOkWrapper);
      this.send(["EVENT", signed]);
    });
  }

  queryEvents(filters, timeoutMs = 8000) {
    if (!this.authenticated) {
      return Promise.reject(new Error("Not authenticated to relay"));
    }
    const subId = `q-${++this.subCounter}`;
    const events = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.send(["CLOSE", subId]);
        this.subs.delete(subId);
        resolve(events);
      }, timeoutMs);

      this.subs.set(subId, {
        onEvent: (evt) => events.push(evt),
        onEose: () => {
          clearTimeout(timer);
          this.send(["CLOSE", subId]);
          this.subs.delete(subId);
          resolve(events);
        },
        autoClose: true,
      });

      this.send(["REQ", subId, ...filters]);
    });
  }

  disconnect() {
    this.authenticated = false;
    this.connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Protocol
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "buzz_publish_event",
    description:
      "Publish a signed Nostr event to the Buzz relay. Returns the event ID and acceptance status.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "integer", description: "Nostr event kind (e.g., 9 for message, 40050 for custom telemetry)" },
        content: { type: "string", description: "Event content (string or JSON-stringified object)" },
        tags: {
          type: "array",
          description: "Nostr tags array, e.g., [['e', '<channel-id>'], ['p', '<pubkey>']]",
          items: { type: "array", items: { type: "string" } },
        },
      },
      required: ["kind", "content"],
    },
  },
  {
    name: "buzz_send_message",
    description:
      "Send a chat message to a Buzz channel. Creates a kind 9 (stream message) event.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "Buzz channel UUID" },
        text: { type: "string", description: "Message text" },
        replyTo: { type: "string", description: "Optional: event ID to reply to" },
      },
      required: ["channelId", "text"],
    },
  },
  {
    name: "buzz_query_history",
    description:
      "Query historical events from the Buzz relay by filter. Returns up to 500 events.",
    inputSchema: {
      type: "object",
      properties: {
        kinds: { type: "array", items: { type: "integer" }, description: "Event kinds to query" },
        channelId: { type: "string", description: "Filter by channel UUID (added as #e tag filter)" },
        since: { type: "integer", description: "Unix timestamp — events after this time" },
        until: { type: "integer", description: "Unix timestamp — events before this time" },
        authors: { type: "array", items: { type: "string" }, description: "Pubkey(s) of authors" },
        limit: { type: "integer", description: "Max results (default 50, max 500)", default: 50 },
      },
      required: ["kinds"],
    },
  },
  {
    name: "buzz_agent_dispatch",
    description:
      "Dispatch a job request to a Buzz agent. Creates a kind 43001 (job request) event.",
    inputSchema: {
      type: "object",
      properties: {
        agentNpub: { type: "string", description: "Target agent's public key (npub)" },
        task: { type: "string", description: "Task description or instruction" },
        channelId: { type: "string", description: "Channel to post results to" },
        context: { type: "string", description: "Optional JSON context for the task" },
      },
      required: ["agentNpub", "task", "channelId"],
    },
  },
  {
    name: "buzz_get_presence",
    description:
      "Get online presence status for a pubkey from the relay. Uses ephemeral presence events (kind 20001).",
    inputSchema: {
      type: "object",
      properties: {
        npub: { type: "string", description: "Public key to check presence for" },
      },
      required: ["npub"],
    },
  },
  {
    name: "buzz_create_channel",
    description:
      "Request creation of a new Buzz channel by posting a channel creation event (kind 40001).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Channel name" },
        description: { type: "string", description: "Channel description" },
        visibility: { type: "string", enum: ["public", "private", "invite-only"], default: "public" },
      },
      required: ["name"],
    },
  },
];

const RESOURCES = [
  {
    uri: "buzz://relay-status",
    name: "Buzz Relay Status",
    description: "Current connection and authentication status of the Buzz relay",
    mimeType: "application/json",
  },
  {
    uri: "buzz://my-npub",
    name: "My Nostr Public Key",
    description: "The npub (public key) this agent uses on the Buzz relay",
    mimeType: "text/plain",
  },
];

const PROMPTS = [
  {
    name: "buzz_agent_orchestration",
    description: "Prompt for coordinating multiple agents in a Buzz workspace",
    arguments: [
      { name: "channelId", description: "Target channel UUID", required: true },
      { name: "goal", description: "What the agent swarm should accomplish", required: true },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Server State
// ─────────────────────────────────────────────────────────────────────────────

let relay = null;
const { privKey, npub } = ensureKey();

async function ensureRelay() {
  if (relay && relay.connected && relay.authenticated) return relay;
  if (relay) relay.disconnect();
  relay = new BuzzRelay(BUZZ_RELAY_URL, privKey, npub);
  await relay.connect();
  return relay;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {
    case "buzz_publish_event": {
      const r = await ensureRelay();
      const result = await r.publishEvent(args.kind, args.content, args.tags || []);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "buzz_send_message": {
      const r = await ensureRelay();
      // NIP-29 group tag: channels use "h" tags, not "e" tags
      const tags = [
        ["h", args.channelId],
        ["buzz-client", "buzz-mcp-server"],
      ];
      if (args.replyTo) tags.push(["e", args.replyTo, "reply"]);
      const result = await r.publishEvent(9, args.text, tags);
      return {
        content: [
          {
            type: "text",
            text: `Message sent. Event ID: ${result.eventId}, Accepted: ${result.accepted}`,
          },
        ],
      };
    }

    case "buzz_query_history": {
      const r = await ensureRelay();
      const filter = {
        kinds: args.kinds,
        limit: Math.min(args.limit || 50, 500),
      };
      if (args.channelId) filter["#e"] = [args.channelId];
      if (args.since) filter.since = args.since;
      if (args.until) filter.until = args.until;
      if (args.authors) filter.authors = args.authors;
      const events = await r.queryEvents([filter]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: events.length, events }, null, 2),
          },
        ],
      };
    }

    case "buzz_agent_dispatch": {
      const r = await ensureRelay();
      const content = JSON.stringify({
        task: args.task,
        context: args.context || {},
        channelId: args.channelId,
      });
      const tags = [
        ["p", args.agentNpub],
        ["h", args.channelId],
      ];
      const result = await r.publishEvent(43001, content, tags);
      return {
        content: [
          {
            type: "text",
            text: `Job dispatched to ${args.agentNpub.slice(0, 16)}... Event ID: ${result.eventId}`,
          },
        ],
      };
    }

    case "buzz_get_presence": {
      const r = await ensureRelay();
      const filter = {
        kinds: [20001],
        authors: [args.npub],
        limit: 1,
      };
      const events = await r.queryEvents([filter], 5000);
      if (events.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ online: false, lastSeen: null }) }],
        };
      }
      const evt = events[0];
      const lastSeen = evt.created_at;
      const online = Date.now() / 1000 - lastSeen < 120; // 2 min grace
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ online, lastSeen, status: evt.content }, null, 2),
          },
        ],
      };
    }

    case "buzz_create_channel": {
      const r = await ensureRelay();
      const content = JSON.stringify({
        name: args.name,
        description: args.description || "",
        visibility: args.visibility || "public",
      });
      const result = await r.publishEvent(40001, content, []);
      return {
        content: [
          {
            type: "text",
            text: `Channel creation event published. Event ID: ${result.eventId}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleResource(uri) {
  if (uri === "buzz://relay-status") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              url: BUZZ_RELAY_URL,
              connected: relay?.connected || false,
              authenticated: relay?.authenticated || false,
              npub,
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  if (uri === "buzz://my-npub") {
    return {
      contents: [{ uri, mimeType: "text/plain", text: npub }],
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Handler
// ─────────────────────────────────────────────────────────────────────────────

async function handlePrompt(name, args) {
  if (name === "buzz_agent_orchestration") {
    return {
      description: "Buzz agent orchestration prompt",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `You are coordinating a swarm of AI agents in a Buzz workspace. ` +
              `Channel: ${args.channelId}. Goal: ${args.goal}. ` +
              `Use buzz_send_message to communicate with the team. ` +
              `Use buzz_agent_dispatch to assign specific tasks to individual agents. ` +
              `Every action is cryptographically signed and auditable.`,
          },
        },
      ],
    };
  }
  throw new Error(`Unknown prompt: ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// stdio JSON-RPC Loop
// ─────────────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

function sendJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handleRequest(req) {
  const { id, method, params } = req;
  try {
    switch (method) {
      case "initialize": {
        sendJson({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
              resources: { subscribe: false },
              prompts: {},
            },
            serverInfo: {
              name: "buzz-mcp-server",
              version: "1.0.0",
            },
          },
        });
        break;
      }

      case "notifications/initialized":
        // No response needed
        break;

      case "tools/list": {
        sendJson({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        break;
      }

      case "tools/call": {
        const result = await handleTool(params.name, params.arguments || {});
        sendJson({ jsonrpc: "2.0", id, result });
        break;
      }

      case "resources/list": {
        sendJson({ jsonrpc: "2.0", id, result: { resources: RESOURCES } });
        break;
      }

      case "resources/read": {
        const result = await handleResource(params.uri);
        sendJson({ jsonrpc: "2.0", id, result });
        break;
      }

      case "prompts/list": {
        sendJson({ jsonrpc: "2.0", id, result: { prompts: PROMPTS } });
        break;
      }

      case "prompts/get": {
        const result = await handlePrompt(params.name, params.arguments || {});
        sendJson({ jsonrpc: "2.0", id, result });
        break;
      }

      default: {
        sendJson({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
    }
  } catch (err) {
    sendJson({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err.message || String(err) },
    });
  }
}

rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (!req || typeof req !== "object") return;
  handleRequest(req);
});

// Graceful shutdown
process.on("SIGINT", () => {
  if (relay) relay.disconnect();
  process.exit(0);
});
process.on("SIGTERM", () => {
  if (relay) relay.disconnect();
  process.exit(0);
});

console.error(`[buzz-mcp] Ready. Relay: ${BUZZ_RELAY_URL} | Npub: ${npub.slice(0, 20)}...`);
