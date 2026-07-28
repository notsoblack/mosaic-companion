import React, { useState, useEffect } from "react";
import { Activity, Radio, Users, MessageSquare, Zap } from "lucide-react";

interface BuzzTelemetryData {
  relayConnected: boolean;
  relayAuthenticated: boolean;
  relayUrl: string;
  onlineAgents: number;
  recentMessages: number;
  lastActivity: number;
}

interface BuzzTelemetryCardProps {
  className?: string;
}

export const BuzzTelemetryCard: React.FC<BuzzTelemetryCardProps> = ({ className = "" }) => {
  const [telemetry, setTelemetry] = useState<BuzzTelemetryData>({
    relayConnected: false,
    relayAuthenticated: false,
    relayUrl: "wss://hpec-stargate.communities.buzz.xyz",
    onlineAgents: 0,
    recentMessages: 0,
    lastActivity: 0,
  });

  // Poll Buzz status and presence every 30s
  useEffect(() => {
    const pollTelemetry = async () => {
      try {
        // Get Buzz bridge status
        const status = await (window as any).chatAPI?.buzzStatus?.();
        
        // Count online agents from presence (would need buzz_get_presence MCP tool)
        // For now, use hardcoded agent list and check if relay is connected
        const knownAgents = [
          "069257d83287b0ab9d9997f80d5b198580179b9fe4e972ae80202f8a56fd8c93", // Goose
          "1dfd7a34d429125979e1e0c94adb275b1aceded8e54b5162e2ecad0d4142c241", // Fizz
          "8cdbbd13191cf99658fa7d081debabcd1d9204ce9e16791671006ee1e711934e", // Honey
          "c7125e3cf3d3885aea723e6f984fb7033cc20a5051afdddee788c71ef3aeb363", // Bumble
        ];
        
        setTelemetry({
          relayConnected: status?.connected || false,
          relayAuthenticated: status?.connected || false, // Same as connected for now
          relayUrl: status?.relayUrl || "wss://hpec-stargate.communities.buzz.xyz",
          onlineAgents: status?.connected ? knownAgents.length : 0, // Estimated
          recentMessages: 0, // Would need history query
          lastActivity: Date.now(),
        });
      } catch (e) {
        console.error("[BuzzTelemetryCard] Failed to poll:", e);
      }
    };

    pollTelemetry();
    const interval = setInterval(pollTelemetry, 30000);
    return () => clearInterval(interval);
  }, []);

  const statusColor = telemetry.relayConnected ? "text-emerald-400" : "text-red-400";
  const statusBg = telemetry.relayConnected ? "bg-emerald-500/20" : "bg-red-500/20";
  const statusBorder = telemetry.relayConnected ? "border-emerald-500/30" : "border-red-500/30";

  return (
    <div className={`p-4 bg-gray-900/60 border border-gray-700 rounded-lg ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Radio size={16} className={statusColor} />
          <span className="font-semibold text-white">Buzz Pulse</span>
        </div>
        <span className={`px-2 py-0.5 text-xs rounded-full border ${statusBg} ${statusColor} ${statusBorder}`}>
          {telemetry.relayConnected ? "Online" : "Offline"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="p-2 bg-gray-800/50 rounded">
          <div className="flex items-center gap-1.5 text-gray-400 text-xs mb-1">
            <Users size={12} />
            <span>Agents</span>
          </div>
          <div className="text-lg font-mono text-white">{telemetry.onlineAgents}</div>
        </div>
        
        <div className="p-2 bg-gray-800/50 rounded">
          <div className="flex items-center gap-1.5 text-gray-400 text-xs mb-1">
            <MessageSquare size={12} />
            <span>Activity</span>
          </div>
          <div className="text-lg font-mono text-white">{telemetry.recentMessages}</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 truncate">
        {telemetry.relayUrl.replace("wss://", "")}
      </div>
    </div>
  );
};

export default BuzzTelemetryCard;
