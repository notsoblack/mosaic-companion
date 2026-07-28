/**
 * AgentJobsPanel - Job dashboard for Mosaic agents
 * Pre-Buzz: Internal job queue
 * Post-Buzz: Bridge to Buzz dispatch
 */

import React, { useState, useEffect, useMemo } from "react";
import {
  Plus,
  Play,
  CheckCircle2,
  AlertCircle,
  Clock,
  Trash2,
  Send,
  Bot,
  Filter,
  MoreHorizontal,
  RefreshCw,
  ChevronDown,
  Target,
  Zap,
  Pause,
} from "lucide-react";
import { toast } from "react-toastify";
import { agentJobService, AgentJob, JobStatus, JobPriority } from "../../services/stargate/AgentJobService";

interface AgentOption {
  id: string;
  name: string;
}

interface AgentJobsPanelProps {
  userAgents?: AgentOption[];
  className?: string;
}

type FilterTab = 'all' | 'pending' | 'running' | 'completed' | 'failed';

const priorityColors: Record<JobPriority, string> = {
  low: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  medium: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  high: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  urgent: 'bg-red-500/20 text-red-400 border-red-500/30',
};

const statusIcons: Record<JobStatus, React.ReactNode> = {
  pending: <Clock size={14} className="text-gray-400" />,
  assigned: <Bot size={14} className="text-blue-400" />,
  running: <RefreshCw size={14} className="text-amber-400 animate-spin" />,
  completed: <CheckCircle2 size={14} className="text-emerald-400" />,
  failed: <AlertCircle size={14} className="text-red-400" />,
  cancelled: <Pause size={14} className="text-gray-400" />,
};

export const AgentJobsPanel: React.FC<AgentJobsPanelProps> = ({ 
  userAgents = [],
  className = ""
}) => {
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [showNewJob, setShowNewJob] = useState(false);
  const [newTask, setNewTask] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPriority, setNewPriority] = useState<JobPriority>('medium');
  const [newAgentId, setNewAgentId] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [selectedChannel, setSelectedChannel] = useState("hpec-stargate");

  // Subscribe to job updates
  useEffect(() => {
    setJobs(agentJobService.getJobs());
    const unsubscribe = agentJobService.subscribe((updatedJobs) => {
      setJobs(updatedJobs);
    });
    return unsubscribe;
  }, []);

  // Filtered jobs
  const filteredJobs = useMemo(() => {
    if (filter === 'all') return jobs;
    return jobs.filter(job => job.status === filter);
  }, [jobs, filter]);

  // Stats
  const stats = useMemo(() => agentJobService.getStats(), [jobs]);

  // Create new job
  const handleCreateJob = () => {
    if (!newTask.trim()) {
      toast.error("Enter a task description");
      return;
    }

    const agent = userAgents.find(a => a.id === selectedAgent);
    
    agentJobService.createJob(newTask, {
      description: newDescription,
      priority: newPriority,
      assignedAgentId: selectedAgent || undefined,
      assignedAgentName: agent?.name,
      buzzChannelTag: selectedChannel,
    });

    toast.success("Job created");
    setNewTask("");
    setNewDescription("");
    setShowNewJob(false);
  };

  // Dispatch to Buzz
  const handleDispatchToBuzz = async (job: AgentJob) => {
    if (!job.assignedAgentId) {
      toast.error("Assign an agent before dispatching");
      return;
    }

    try {
      const result = await (window as any).chatAPI?.buzzDispatch?.(
        job.assignedAgentId,
        job.task,
        job.buzzChannelTag || selectedChannel
      );

      if (result?.success) {
        agentJobService.markDispatchedToBuzz(job.id, result.jobId);
        toast.success(`Dispatched to Buzz! Job ${result.jobId?.slice(0, 8)}`);
      } else {
        throw new Error(result?.error || "Dispatch failed");
      }
    } catch (e: any) {
      toast.error(e.message || "Failed to dispatch");
    }
  };

  // Delete job
  const handleDeleteJob = (id: string) => {
    agentJobService.deleteJob(id);
    toast.success("Job deleted");
  };

  // Format relative time
  const formatTime = (timestamp?: number) => {
    if (!timestamp) return "—";
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  return (
    <div className={`h-full flex flex-col bg-gray-950 text-gray-200 ${className}`}>
      {/* Header */}
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-violet-500/20 flex items-center justify-center border border-violet-500/30">
              <Target size={20} className="text-violet-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Agent Jobs</h2>
              <p className="text-xs text-gray-400">{stats.total} jobs · {stats.successRate}% success rate</p>
            </div>
          </div>
          <button
            onClick={() => setShowNewJob(!showNewJob)}
            className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-lg flex items-center gap-1.5"
          >
            <Plus size={14} />
            New Job
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-5 gap-2 mb-4">
          {[
            { key: 'all', label: 'All', count: stats.total, color: 'bg-gray-700' },
            { key: 'pending', label: 'Pending', count: stats.pending, color: 'bg-gray-600' },
            { key: 'running', label: 'Running', count: stats.running, color: 'bg-amber-600' },
            { key: 'completed', label: 'Done', count: stats.completed, color: 'bg-emerald-600' },
            { key: 'failed', label: 'Failed', count: stats.failed, color: 'bg-red-600' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key as FilterTab)}
              className={`p-2 rounded-lg border text-left transition-colors ${
                filter === tab.key 
                  ? `${tab.color} text-white border-transparent` 
                  : 'bg-gray-900/40 border-gray-800 hover:bg-gray-800/60'
              }`}
            >
              <div className="text-xs text-gray-400">{tab.label}</div>
              <div className="text-lg font-mono font-semibold">{tab.count}</div>
            </button>
          ))}
        </div>

        {/* New Job Form */}
        {showNewJob && (
          <div className="p-4 bg-gray-900/60 border border-gray-700 rounded-lg space-y-3">
            <input
              type="text"
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              placeholder="Task description..."
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-violet-500"
            />
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Additional details (optional)..."
              rows={2}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-violet-500 resize-none"
            />
            
            <div className="grid grid-cols-3 gap-3">
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as JobPriority)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-violet-500"
              >
                <option value="low">Low Priority</option>
                <option value="medium">Medium Priority</option>
                <option value="high">High Priority</option>
              </select>

              <select
                value={newAgentId}
                onChange={(e) => setNewAgentId(e.target.value)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-violet-500"
              >
                <option value="">Select agent...</option>
                {userAgents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>

              <button
                onClick={() => {
                  if (newTask.trim() && newAgentId) {
                    (window as any).chatAPI?.buzzDispatch?.(newAgentId, newTask.trim(), "hpec-stargate");
                    setNewTask("");
                    setNewDescription("");
                    setNewAgentId("");
                    setShowNewJob(false);
                  }
                }}
                disabled={!newTask.trim() || !newAgentId}
                className="px-3 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm rounded-lg transition-colors"
              >
                Dispatch
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
    
