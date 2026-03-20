// MultiAgentPanel.tsx
// Compact horizontal status bar for multi-agent activity
// Positioned below the chat input

import React from 'react';
import { 
  Users, 
  Brain, 
  MessageSquare, 
  Wallet, 
  Globe, 
  Code, 
  Shield, 
  Sparkles,
  Loader2,
  CheckCircle2,
  Circle
} from 'lucide-react';
import { AIAgentConfig } from '../types/ai';
import { OrchestrationMode } from '../types/agentOrchestration';

interface MultiAgentPanelProps {
  agents: AIAgentConfig[];
  selectedAgentIds: string[];
  orchestrationMode: OrchestrationMode;
  isActive: boolean;
  isRunning?: boolean;
  currentAgentName?: string | null;
}

// Role icons mapping
const roleIcons: Record<string, React.ReactNode> = {
  'reasoning': <Brain className="w-3.5 h-3.5" />,
  'chat': <MessageSquare className="w-3.5 h-3.5" />,
  'wallet': <Wallet className="w-3.5 h-3.5" />,
  'web': <Globe className="w-3.5 h-3.5" />,
  'code': <Code className="w-3.5 h-3.5" />,
  'security': <Shield className="w-3.5 h-3.5" />,
  'default': <Sparkles className="w-3.5 h-3.5" />,
};

// Get role from agent name
const getAgentRole = (agent: AIAgentConfig): string => {
  const name = agent.name.toLowerCase();
  if (name.includes('wallet') || name.includes('crypto')) return 'wallet';
  if (name.includes('code') || name.includes('dev') || name.includes('program')) return 'code';
  if (name.includes('security') || name.includes('audit')) return 'security';
  if (name.includes('web') || name.includes('search') || name.includes('browser')) return 'web';
  if (name.includes('reason') || name.includes('think') || name.includes('analyze')) return 'reasoning';
  return 'chat';
};

// Mode display names
const modeDisplayNames: Record<OrchestrationMode, string> = {
  sequential: 'Sequential',
  parallel: 'Parallel',
  collaborative: 'Collaborative',
  orchestrator: 'Coordinator',
};

export const MultiAgentPanel: React.FC<MultiAgentPanelProps> = ({
  agents,
  selectedAgentIds,
  orchestrationMode,
  isActive,
  isRunning = false,
  currentAgentName = null,
}) => {
  const selectedAgents = agents.filter(a => selectedAgentIds.includes(a.id));

  if (!isActive || selectedAgentIds.length === 0) {
    return null;
  }

  return (
    <div className="shrink-0 border-t border-gray-800/50 bg-gray-950/95 backdrop-blur-sm">
      <div className="max-w-4xl mx-auto">
        {/* Horizontal agent status bar */}
        <div className="flex items-center gap-2 px-4 py-2 overflow-x-auto">
          {/* Mode indicator */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-purple-600/20 border border-purple-500/30 shrink-0">
            <Users className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-xs font-medium text-purple-300">
              {selectedAgentIds.length} {modeDisplayNames[orchestrationMode]}
            </span>
          </div>

          {/* Divider */}
          <div className="w-px h-4 bg-gray-700 shrink-0" />

          {/* Agent chips */}
          <div className="flex items-center gap-2 flex-1 overflow-x-auto">
            {selectedAgents.map((agent) => {
              const role = getAgentRole(agent);
              const isRunningNow = isRunning && currentAgentName === agent.name;
              const isDone = isRunning && currentAgentName !== agent.name;
              const isWaiting = !isRunning;

              return (
                <div
                  key={agent.id}
                  className={`
                    flex items-center gap-2 px-3 py-1.5 rounded-full shrink-0 transition-all
                    ${isRunningNow 
                      ? 'bg-purple-600/30 border border-purple-500 shadow-sm' 
                      : isDone
                        ? 'bg-green-600/20 border border-green-500/50'
                        : 'bg-gray-800/50 border border-gray-700 hover:border-gray-600'
                    }
                  `}
                >
                  {/* Status icon */}
                  <div className={`
                    w-4 h-4 rounded-full flex items-center justify-center shrink-0
                    ${isRunningNow 
                      ? 'bg-purple-500' 
                      : isDone 
                        ? 'bg-green-500' 
                        : 'bg-gray-700'
                    }
                  `}>
                    {isRunningNow ? (
                      <Loader2 className="w-2.5 h-2.5 text-white animate-spin" />
                    ) : isDone ? (
                      <CheckCircle2 className="w-2.5 h-2.5 text-white" />
                    ) : (
                      <Circle className="w-2.5 h-2.5 text-gray-400" />
                    )}
                  </div>

                  {/* Agent role icon */}
                  <div className="text-gray-400">
                    {roleIcons[role] || roleIcons.default}
                  </div>

                  {/* Agent name */}
                  <span className={`text-sm font-medium truncate max-w-[120px] ${
                    isRunningNow ? 'text-white' : 'text-gray-300'
                  }`}>
                    {agent.name}
                  </span>

                  {/* Status text */}
                  <span className={`text-xs shrink-0 ${
                    isRunningNow 
                      ? 'text-purple-300' 
                      : isDone 
                        ? 'text-green-400' 
                        : 'text-gray-500'
                  }`}>
                    {isRunningNow ? 'Thinking' : isDone ? 'Done' : 'Ready'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MultiAgentPanel;