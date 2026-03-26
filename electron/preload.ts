import { gmailAPI } from "./integrations/gmail/gmailAPI";
import { mcpAPI } from "./integrations/mcp/MCPAPI";
import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

// =============================================================================
// Type Definitions
// =============================================================================

interface Node {
  id: string;
  name: string;
  apiHost: string;
  apiPort: string;
  hasAdminPanel: boolean;
  adminHost: string;
  adminPort: string;
  isActive: boolean;
}

interface AIAgent {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface ChatSession {
  id: string;
  agentId: string;
  [key: string]: unknown;
}

interface UpdateSettings {
  autoDownload?: boolean;
  titleBarStyle?: string;
}

// =============================================================================
// Expose API to Renderer
// =============================================================================

contextBridge.exposeInMainWorld("electronAPI", {
  logInput: (text: string) => ipcRenderer.invoke("log-input", text),
  getCsvPath: () => ipcRenderer.invoke("get-csv-path"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  getUpdateSettings: () => ipcRenderer.invoke("get-update-settings"),
  setUpdateSettings: (settings: UpdateSettings) =>
    ipcRenderer.invoke("set-update-settings", settings),
  getUpdateLogs: () => ipcRenderer.invoke("get-update-logs"),
  getUpdateLogPath: () => ipcRenderer.invoke("get-update-log-path"),
  restartWindow: () => ipcRenderer.invoke("restart-window"),
  showTitleBarConfirm: () => ipcRenderer.invoke("show-title-bar-confirm"),
  nodes: {
    get: () => ipcRenderer.invoke("nodes:get"),
    add: (node: Partial<Omit<Node, "id">>) =>
      ipcRenderer.invoke("nodes:add", node),
    update: (id: string, updates: Partial<Omit<Node, "id">>) =>
      ipcRenderer.invoke("nodes:update", id, updates),
    delete: (id: string) => ipcRenderer.invoke("nodes:delete", id),
    onChanged: (callback: (nodes: Node[]) => void) => {
      ipcRenderer.on(
        "nodes-changed",
        (_event: IpcRendererEvent, nodes: Node[]) => callback(nodes),
      );
      // Return cleanup
      return () => ipcRenderer.removeAllListeners("nodes-changed");
    },
  },
  aiAgents: {
    get: () => ipcRenderer.invoke("ai-agents:get"),
    set: (agents: AIAgent[]) => ipcRenderer.invoke("ai-agents:set", agents),
    add: (agent: Omit<AIAgent, "id">) =>
      ipcRenderer.invoke("ai-agents:add", agent),
    update: (id: string, updates: Partial<Omit<AIAgent, "id">>) =>
      ipcRenderer.invoke("ai-agents:update", id, updates),
    delete: (id: string) => ipcRenderer.invoke("ai-agents:delete", id),
    clear: () => ipcRenderer.invoke("ai-agents:clear"),
  },
  themes: {
    get: () => ipcRenderer.invoke("themes:get"),
    set: (activeTheme: string) => ipcRenderer.invoke("themes:set", activeTheme),
  },
  aiAgentsHistory: {
    getAll: (agentId: string) =>
      ipcRenderer.invoke("ai-agents-history:get-all", agentId),
    get: (agentId: string, sessionId: string) =>
      ipcRenderer.invoke("ai-agents-history:get", agentId, sessionId),
    save: (chatSession: ChatSession) =>
      ipcRenderer.invoke("ai-agents-history:save", chatSession),
    delete: (agentId: string, sessionId: string) =>
      ipcRenderer.invoke("ai-agents-history:delete", agentId, sessionId),
    deleteAll: (agentId: string) =>
      ipcRenderer.invoke("ai-agents-history:delete-all", agentId),
  },
  mcpAPI,
  gmailAPI,
  // Midnight Network API
  midnight: {
    init: () => ipcRenderer.invoke("midnight:init"),
    createNode: (config: {
      type: "validator" | "full" | "light";
      stake: number;
      privacy: "public" | "shielded" | "private";
      delegation: "user" | "agent" | "hybrid";
      agentId?: string;
    }) => ipcRenderer.invoke("midnight:create-node", config),
    delegate: (nodeId: string, agentId: string) =>
      ipcRenderer.invoke("midnight:delegate", nodeId, agentId),
    getStatus: (nodeId: string) =>
      ipcRenderer.invoke("midnight:get-status", nodeId),
    stopNode: (nodeId: string) =>
      ipcRenderer.invoke("midnight:stop-node", nodeId),
    restartNode: (nodeId: string) =>
      ipcRenderer.invoke("midnight:restart-node", nodeId),
    getNetworkInfo: () => ipcRenderer.invoke("midnight:get-network-info"),
    listNodes: () => ipcRenderer.invoke("midnight:list-nodes"),
    getConfig: () => ipcRenderer.invoke("midnight:get-config"),
    saveConfig: (config: {
      network?: "testnet" | "mainnet";
      provider?: "cardano-partnerchain";
      rpcEndpoint?: string;
    }) => ipcRenderer.invoke("midnight:save-config", config),
  },
  // Linux AppImage sandbox state (read-only)
  sandbox: {
    getState: () => ipcRenderer.invoke("sandbox:get-state"),
  },
  // Window controls (for custom title bar)
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  },
  // Network capabilities (for Builder mode)
  network: {
    fetch: (url: string, options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeout?: number;
    }) => ipcRenderer.invoke("network:fetch", url, options),
    graphql: (url: string, query: string, variables?: Record<string, any>) =>
      ipcRenderer.invoke("network:graphql", url, query, variables),
  },
  // Shell execution (for Builder mode)
  shell: {
    execute: (command: string, options?: {
      cwd?: string;
      timeout?: number;
    }) => ipcRenderer.invoke("shell:execute", command, options),
  },
});
