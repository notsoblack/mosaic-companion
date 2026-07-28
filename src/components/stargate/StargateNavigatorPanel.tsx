import React, { useState } from "react";
import { Globe, Bot } from "lucide-react";

interface Session {
  id: string;
  agentName: string;
  currentView: string;
  lastResponse: string;
  isOnline: boolean;
}

export const StargateNavigatorPanel: React.FC = () => {
  const [sessions] = useState<Session[]>([
    { id: "1", agentName: "Honey", currentView: "fleet", lastResponse: "2 nodes online", isOnline: true },
  ]);

  return (
    <div className="h-full flex flex-col bg-gray-950 text-gray-200">
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
            <Globe size={20} className="text-emerald-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Stargate Navigator</h2>
            <p className="text-xs text-gray-400">Buzz agents browsing Stargate</p>
          </div>
        </div>
      </div>
      <div className="flex-1 p-4">
        <div className="space-y-3">
          {sessions.map((s) => (
            <div key={s.id} className="p-3 bg-gray-900/40 border border-gray-800 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-2 h-2 rounded-full ${s.isOnline ? "bg-emerald-400" : "bg-gray-600"}`} />
                <span className="font-medium text-white">{s.agentName}</span>
              </div>
              <div className="text-sm text-gray-400">Viewing: {s.currentView}</div>
              <div className="text-xs text-emerald-400 mt-1">{s.lastResponse}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default StargateNavigatorPanel;
