/**
 * AgentJobService - Track and manage agent jobs
 * Foundation for Mosaic → Buzz job bridge
 */

export type JobStatus = 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface AgentJob {
  id: string;
  task: string;
  description?: string;
  assignedAgentId?: string;
  assignedAgentName?: string;
  status: JobStatus;
  priority: JobPriority;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  // Buzz bridge fields
  buzzChannelTag?: string;
  buzzJobId?: string;
  dispatchedToBuzz: boolean;
  buzzResponse?: any;
}

export interface JobStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  successRate: number; // percentage
}

class AgentJobService {
  private jobs: Map<string, AgentJob> = new Map();
  private listeners: Set<(jobs: AgentJob[]) => void> = new Set();

  // Generate unique job ID
  private generateId(): string {
    return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // Create a new job
  createJob(task: string, options: {
    description?: string;
    priority?: JobPriority;
    assignedAgentId?: string;
    assignedAgentName?: string;
    buzzChannelTag?: string;
  } = {}): AgentJob {
    const job: AgentJob = {
      id: this.generateId(),
      task,
      description: options.description,
      assignedAgentId: options.assignedAgentId,
      assignedAgentName: options.assignedAgentName,
      status: options.assignedAgentId ? 'assigned' : 'pending',
      priority: options.priority || 'medium',
      createdAt: Date.now(),
      buzzChannelTag: options.buzzChannelTag,
      dispatchedToBuzz: false,
    };

    this.jobs.set(job.id, job);
    this.notifyListeners();
    return job;
  }

  // Get all jobs
  getJobs(): AgentJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  // Get jobs by status
  getJobsByStatus(status: JobStatus): AgentJob[] {
    return this.getJobs().filter(job => job.status === status);
  }

  // Get jobs by agent
  getJobsByAgent(agentId: string): AgentJob[] {
    return this.getJobs().filter(job => job.assignedAgentId === agentId);
  }

  // Get a single job
  getJob(id: string): AgentJob | undefined {
    return this.jobs.get(id);
  }

  // Update job status
  updateJobStatus(id: string, status: JobStatus, updates: Partial<AgentJob> = {}): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    job.status = status;
    
    if (status === 'running' && !job.startedAt) {
      job.startedAt = Date.now();
    }
    
    if ((status === 'completed' || status === 'failed') && !job.completedAt) {
      job.completedAt = Date.now();
    }

    Object.assign(job, updates);
    this.notifyListeners();
    return true;
  }

  // Assign job to agent
  assignJob(id: string, agentId: string, agentName?: string): boolean {
    return this.updateJobStatus(id, 'assigned', { assignedAgentId: agentId, assignedAgentName: agentName });
  }

  // Mark job as dispatched to Buzz
  markDispatchedToBuzz(id: string, buzzJobId: string): boolean {
    return this.updateJobStatus(id, 'running', { 
      buzzJobId, 
      dispatchedToBuzz: true 
    });
  }

  // Record Buzz response
  recordBuzzResponse(id: string, response: any): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    job.buzzResponse = response;
    job.result = response?.event?.content;
    job.status = 'completed';
    job.completedAt = Date.now();
    
    this.notifyListeners();
    return true;
  }

  // Cancel a job
  cancelJob(id: string): boolean {
    return this.updateJobStatus(id, 'cancelled');
  }

  // Delete a job
  deleteJob(id: string): boolean {
    const deleted = this.jobs.delete(id);
    if (deleted) this.notifyListeners();
    return deleted;
  }

  // Get statistics
  getStats(): JobStats {
    const all = this.getJobs();
    const completed = all.filter(j => j.status === 'completed');
    const failed = all.filter(j => j.status === 'failed');
    const finished = completed.length + failed.length;
    
    return {
      total: all.length,
      pending: all.filter(j => j.status === 'pending').length,
      running: all.filter(j => j.status === 'running').length,
      completed: completed.length,
      failed: failed.length,
      cancelled: all.filter(j => j.status === 'cancelled').length,
      successRate: finished > 0 ? Math.round((completed.length / finished) * 100) : 0,
    };
  }

  // Subscribe to changes
  subscribe(listener: (jobs: AgentJob[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Notify all listeners
  private notifyListeners(): void {
    const jobs = this.getJobs();
    this.listeners.forEach(listener => listener(jobs));
  }

  // Export for persistence
  export(): AgentJob[] {
    return this.getJobs();
  }

  // Import from persistence
  import(jobs: AgentJob[]): void {
    this.jobs.clear();
    jobs.forEach(job => this.jobs.set(job.id, job));
    this.notifyListeners();
  }

  // Clear all jobs (use with caution)
  clear(): void {
    this.jobs.clear();
    this.notifyListeners();
  }
}

// Singleton instance
export const agentJobService = new AgentJobService();
export default agentJobService;
