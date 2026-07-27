import React, { useState, useEffect } from "react";
import {
  Plug, Unplug, Plus, Link as LinkIcon, MessageSquare, Hash, Globe,
  KeyRound, RefreshCw, CheckCircle2, Copy, Bot, Send, Target, Activity,
  Import, Eye, EyeOff, AlertTriangle, Settings, Save, X,
} from "lucide-react";
import { toast } from "react-toastify";

interface AgentOption {
  id: string;
  name: string;
  type: string;
  status?: string;
}

type BuzzStatus = {
  enabled: boolean;
  connected: boolean;
  npub?: string;
  relayUrl: string;
  lastError?: string;
};

type RoomMap = {
  roomId: string;
  roomName: string;
  channelTag: string;
  channelName: string;
};

type ActiveMission = {
  id: string;
  agentId: string;
  agentName: string;
  channelTag: string;
  channelName: string;
  task: string;
  status: "deploying" | "active" | "idle" | "error";
  lastActivity?: number;
  roomName?: string;
};

interface StargateBuzzPanelProps {
  userAgents?: AgentOption[];
}

export const StargateBuzzPanel: React.FC<StargateBuzzPanelProps> = ({ userAgents = [] }) => {
  const [status, setStatus] = useState<BuzzStatus>({
    enabled: false,
    connected: false,
    relayUrl: "wss://hpec-stargate.communities.buzz.xyz",
  });
  const [loading, setLoading] = useState(true);
  const [selectedChannelTag, setSelectedChannelTag] = useState("hpec-stargate");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [taskText, setTaskText] = useState("");
  const [missions, setMissions] = useState<ActiveMission[]>([]);
  const [roomMaps, setRoomMaps] = useState<RoomMap[]>([]);
  const [showImportKey, setShowImportKey] = useState(false);
  const [importNsec, setImportNsec] = useState("");
  const [showNsec, setShowNsec] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [configRelay, setConfigRelay] = useState("wss://hpec-stargate.communities.buzz.xyz");
  const [configChannel, setConfigChannel] = useState("hpec-stargate");
  const [savingConfig, setSavingConfig] = useState(false);

  // ── Load status on mount ──
  useEffect(() => {
    loadStatus();
    loadRoomMaps();
    const interval = setInterval(() => loadStatus(), 5000);
    return () => clearInterval(interval);
  }, []);

  const loadStatus = async () => {
    try {
      const s = await (window as any).chatAPI?.buzzStatus?.();
      if (s) setStatus(s);
    } catch (e) {
      console.error("[StargateBuzzPanel] status error:", e);
    } finally {
      setLoading(false);
    }
  };

  const loadRoomMaps = async () => {
    try {
      const cfg = await (window as any).chatAPI?.buzzGetConfig?.();
      if (cfg?.roomMapping) {
        const maps: RoomMap[] = [];
        for (const [roomId, channelTag] of Object.entries(cfg.roomMapping)) {
          maps.push({ roomId, roomName: roomId, channelTag: channelTag as string, channelName: channelTag as string });
        }
        setRoomMaps(maps);
      }
    } catch (e) {
      console.error("[StargateBuzzPanel] room maps error:", e);
    }
  };

  const handleToggle = async () => {
    const next = !status.enabled;
    try {
      const s = await (window as any).chatAPI?.buzzEnable?.(next);
      if (s) {
        setStatus(s);
        toast.success(next ? "Buzz Bridge enabled" : "Buzz Bridge disabled");
      }
    } catch (e: any) {
      toast.error(e.message || "Toggle failed");
    }
  };

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      // Update relay URL
      await (window as any).chatAPI?.buzzSetRelay?.(configRelay);
      // Update default channel
      setSelectedChannelTag(configChannel);
      toast.success("Configuration saved");
      setShowConfig(false);
      // Refresh status to pick up new relay
      await loadStatus();
    } catch (e: any) {
      toast.error(e.message || "Failed to save config");
    } finally {
      setSavingConfig(false);
    }
  };

  const handleImportKey = async () => {
    const input = importNsec.trim();
    if (!input) { toast.error("Paste your nsec key"); return; }
    try {
      const res = await (window as any).chatAPI?.buzzImportKey?.(input);
      if (res?.success) {
        toast.success(`Key imported! npub: ${res.npub?.slice(0, 16)}...`);
        setShowImportKey(false);
        setImportNsec("");
        await loadStatus();
      } else {
        toast.error(res?.error || "Import failed");
      }
    } catch (e: any) {
      toast.error(e.message || "Import failed");
    }
  };

  const handleDeployAgent = async () => {
    if (!status.connected) { toast.error("Buzz relay not connected"); return; }
    if (!selectedAgentId) { toast.error("Select an agent"); return; }
    if (!selectedChannelTag) { toast.error("Enter a Buzz channel tag"); return; }
    if (!taskText.trim()) { toast.error("Describe the task"); return; }

    const agent = userAgents.find(a => a.id === selectedAgentId);
    const missionId = `mission-${Date.now()}`;
    const mission: ActiveMission = {
      id: missionId,
      agentId: selectedAgentId,
      agentName: agent?.name || selectedAgentId,
      channelTag: selectedChannelTag,
      channelName: selectedChannelTag,
      task: taskText.trim(),
      status: "deploying",
      lastActivity: Date.now(),
    };
    setMissions(prev => [...prev, mission]);

    try {
      const dispatchResult = await (window as any).chatAPI?.buzzDispatch?.(
        selectedAgentId,
        taskText.trim(),
        selectedChannelTag,
      );
      if (dispatchResult?.success) {
        toast.success(`Agent dispatched! Job ${dispatchResult.jobId?.slice(0, 8)}`);
        setMissions(prev => prev.map(m => m.id === missionId ? { ...m, status: "active" } : m));
        setTaskText("");
      } else {
        throw new Error(dispatchResult?.error || "Dispatch failed");
      }
    } catch (e: any) {
      console.error("[StargateBuzzPanel] Deploy failed:", e);
      toast.error(e.message || "Deploy failed");
      setMissions(prev => prev.map(m => m.id === missionId ? { ...m, status: "error" } : m));
    }
  };

  const copyNpub = () => {
    if (!status.npub) return;
    navigator.clipboard.writeText(status.npub);
    toast.success("Public key copied");
  };

  const statusBadge = () => {
    if (status.connected) return <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 text-xs rounded-full border border-emerald-500/30">Connected</span>;
    if (status.enabled && status.lastError?.includes("not a relay member")) return <span className="px-2 py-0.5 bg-red-500/20 text-red-300 text-xs rounded-full border border-red-500/30">Auth Failed</span>;
    if (status.enabled) return <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 text-xs rounded-full border border-amber-500/30">Connecting…</span>;
    return <span className="px-2 py-0.5 bg-gray-700/40 text-gray-400 text-xs rounded-full border border-gray-600/30">Standby</span>;
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-950 text-gray-400">
        <RefreshCw size={24} className="animate-spin mr-3" />
        Loading Buzz Mission Control…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-950 text-gray-200">
      {/* Header */}
      <div className="p-6 border-b border-gray-800">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400"><path d="M12 3c-4.97 0-9 4.03-9 9 0 1.76.5 3.4 1.36 4.8L3 21l4.2-1.36C8.6 20.5 10.24 21 12 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z"/><path d="M12 7v6"/><path d="M9 10h6"/></svg>
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Buzz Mission Control</h2>
              <p className="text-xs text-gray-400">Deploy agents to Buzz channels via Nostr relay</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {statusBadge()}
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 flex items-center gap-1"
            >
              <Settings size={12} /> Config
            </button>
            <button
              onClick={handleToggle}
              className={`px-3 py-1.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors ${
                status.enabled
                  ? "bg-red-500/20 text-red-300 border-red-500/30 hover:bg-red-500/30"
                  : "bg-emerald-500/20 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/30"
              }`}
            >
              {status.enabled ? <Unplug size={14} /> : <Plug size={14} />}
              {status.enabled ? "Disable" : "Enable"}
            </button>
          </div>
        </div>

        {/* Auth failure banner */}
        {status.enabled && status.lastError?.includes("not a relay member") && (
          <div className="mb-4 p-3 bg-red-900/20 border border-red-700/40 rounded-lg flex items-start gap-3">
            <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="text-sm text-red-200 font-medium">Private relay rejected this identity</div>
              <div className="text-xs text-red-300/70 mt-1">
                Export your nsec from the Windows Buzz Desktop and import it below.
              </div>
            </div>
            <button
              onClick={() => setShowImportKey(!showImportKey)}
              className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-xs rounded-lg flex items-center gap-1.5 shrink-0"
            >
              <Import size={12} /> Import nsec
            </button>
          </div>
        )}

        {/* Config Panel */}
        {showConfig && (
          <div className="mb-4 p-4 bg-gray-900/60 border border-gray-700 rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Settings size={14} /> Buzz Configuration</h3>
              <button onClick={() => setShowConfig(false)} className="text-gray-400 hover:text-white"><X size={14} /></button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Relay URL</label>
                <input
                  type="text"
                  value={configRelay}
                  onChange={e => setConfigRelay(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-amber-500"
                  placeholder="wss://relay.example.com"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Default Channel Tag</label>
                <input
                  type="text"
                  value={configChannel}
                  onChange={e => setConfigChannel(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-amber-500"
                  placeholder="hpec-stargate"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded-lg flex items-center gap-1.5 disabled:opacity-50"
              >
                <Save size={12} /> {savingConfig ? "Saving…" : "Save Config"}
              </button>
            </div>
          </div>
        )}

        {/* Key import panel */}
        {showImportKey && (
          <div className="mb-4 p-3 bg-gray-900/60 border border-gray-700 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-white">Import nsec Key</h3>
              <button onClick={() => setShowImportKey(false)} className="text-gray-400 hover:text-white text-xs">Close</button>
            </div>
            <div className="flex gap-2">
              <input
                type={showNsec ? "text" : "password"}
                value={importNsec}
                onChange={e => setImportNsec(e.target.value)}
                placeholder="nsec1… or hex"
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-amber-500"
              />
              <button onClick={() => setShowNsec(!showNsec)} className="p-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white">
                {showNsec ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button onClick={handleImportKey} className="px-3 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm rounded-lg flex items-center gap-1.5">
                <Import size={14} /> Import
              </button>
            </div>
          </div>
        )}

        {/* Status Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="p-3 bg-gray-900/40 border border-gray-800 rounded-lg">
            <div className="text-xs text-gray-400 mb-1">Relay</div>
            <div className="text-sm text-white font-mono truncate">{status.relayUrl}</div>
          </div>
          <div className="p-3 bg-gray-900/40 border border-gray-800 rounded-lg">
            <div className="text-xs text-gray-400 mb-1">Public Key</div>
            <div className="flex items-center gap-2">
              <div className="text-sm text-white font-mono truncate">{status.npub ? `${status.npub.slice(0, 16)}…${status.npub.slice(-8)}` : "—"}</div>
              {status.npub && (
                <button onClick={copyNpub} className="p-1 text-gray-400 hover:text-white"><Copy size={12} /></button>
              )}
            </div>
          </div>
          <div className="p-3 bg-gray-900/40 border border-gray-800 rounded-lg">
            <div className="text-xs text-gray-400 mb-1">Bridge</div>
            <div className="text-sm text-white">{status.enabled ? "Enabled" : "Disabled"}</div>
          </div>
        </div>
      </div>

      {/* Deploy Agent */}
      <div className="p-6 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2"><Target size={14} /> Deploy Agent</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Agent</label>
            <select
              value={selectedAgentId}
              onChange={e => setSelectedAgentId(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-amber-500"
            >
              <option value="">Select agent…</option>
              {userAgents.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Channel Tag</label>
            <input
              type="text"
              value={selectedChannelTag}
              onChange={e => setSelectedChannelTag(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-amber-500"
              placeholder="hpec-stargate"
            />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-gray-400 mb-1 block">Task</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={taskText}
                onChange={e => setTaskText(e.target.value)}
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-amber-500"
                placeholder="Describe the agent's mission…"
              />
              <button
                onClick={handleDeployAgent}
                disabled={!status.connected || !selectedAgentId || !selectedChannelTag || !taskText.trim()}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm rounded-lg flex items-center gap-1.5"
              >
                <Send size={14} /> Deploy
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Active Missions */}
      <div className="p-6">
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2"><Activity size={14} /> Active Missions</h3>
        {missions.length === 0 ? (
          <div className="text-center py-8 text-gray-500 text-sm">No missions deployed yet. Select an agent and channel above.</div>
        ) : (
          <div className="space-y-2">
            {missions.map(m => (
              <div key={m.id} className="p-3 bg-gray-900/40 border border-gray-800 rounded-lg flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Bot size={16} className={m.status === "active" ? "text-emerald-400" : m.status === "error" ? "text-red-400" : "text-amber-400"} />
                  <div>
                    <div className="text-sm text-white font-medium">{m.agentName} → #{m.channelTag}</div>
                    <div className="text-xs text-gray-400">{m.task}</div>
                  </div>
                </div>
                <span className={`px-2 py-0.5 text-xs rounded-full border ${
                  m.status === "active" ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" :
                  m.status === "error" ? "bg-red-500/20 text-red-300 border-red-500/30" :
                  "bg-amber-500/20 text-amber-300 border-amber-500/30"
                }`}>{m.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default StargateBuzzPanel;
