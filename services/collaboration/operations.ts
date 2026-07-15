export interface CollaborationCostInputs {
  activeProjects: number
  inactiveProjects: number
  averageUpdateBytes: number
  updatesPerActiveProjectMinute: number
  retainedSnapshotBytesPerProject: number
  monthlyEgressBytes: number
  activeHoursPerProjectMonth: number
}

export interface CollaborationUnitCosts {
  storagePerGbMonth: number
  egressPerGb: number
  activeServicePerHour: number
}

export interface CollaborationCapacityEstimate {
  monthlyUpdateBytes: number
  retainedBytes: number
  activeServiceHours: number
  estimatedMonthlyCost: number
}

export interface ProjectOperationalMetrics {
  updateCount: number
  updateBytes: number
  snapshotCount: number
  snapshotBytes: number
  compactionCount: number
  restoreSuccessCount: number
  restoreFailureCount: number
  deletionCount: number
  backupCount: number
  backupBytes: number
  backupVerificationFailureCount: number
  lastActivityAt?: string
}

const EMPTY_METRICS: ProjectOperationalMetrics = {
  updateCount: 0,
  updateBytes: 0,
  snapshotCount: 0,
  snapshotBytes: 0,
  compactionCount: 0,
  restoreSuccessCount: 0,
  restoreFailureCount: 0,
  deletionCount: 0,
  backupCount: 0,
  backupBytes: 0,
  backupVerificationFailureCount: 0,
}

export function estimateCollaborationCapacity(
  inputs: CollaborationCostInputs,
  costs: CollaborationUnitCosts,
): CollaborationCapacityEstimate {
  const minutesPerMonth = 30 * 24 * 60
  const monthlyUpdateBytes = inputs.activeProjects * inputs.averageUpdateBytes * inputs.updatesPerActiveProjectMinute * minutesPerMonth
  const retainedBytes = inputs.retainedSnapshotBytesPerProject * (inputs.activeProjects + inputs.inactiveProjects) + monthlyUpdateBytes
  const activeServiceHours = inputs.activeProjects * inputs.activeHoursPerProjectMonth
  const bytesPerGb = 1024 ** 3
  const estimatedMonthlyCost = retainedBytes / bytesPerGb * costs.storagePerGbMonth
    + inputs.monthlyEgressBytes / bytesPerGb * costs.egressPerGb
    + activeServiceHours * costs.activeServicePerHour
  return { monthlyUpdateBytes, retainedBytes, activeServiceHours, estimatedMonthlyCost }
}

export class CollaborationOperationsDashboard {
  private readonly metrics = new Map<string, ProjectOperationalMetrics>()

  private mutate(projectKey: string, update: (metrics: ProjectOperationalMetrics) => void, at?: string) {
    const metrics = { ...(this.metrics.get(projectKey) ?? EMPTY_METRICS) }
    update(metrics)
    if (at) metrics.lastActivityAt = at
    this.metrics.set(projectKey, metrics)
  }

  recordUpdate(projectKey: string, bytes: number, at: string) {
    this.mutate(projectKey, (metrics) => {
      metrics.updateCount += 1
      metrics.updateBytes += bytes
    }, at)
  }

  recordSnapshot(projectKey: string, bytes: number, at: string) {
    this.mutate(projectKey, (metrics) => {
      metrics.snapshotCount += 1
      metrics.snapshotBytes += bytes
    }, at)
  }

  recordCompaction(projectKey: string, at: string) {
    this.mutate(projectKey, (metrics) => { metrics.compactionCount += 1 }, at)
  }

  recordRestore(projectKey: string, success: boolean, at: string) {
    this.mutate(projectKey, (metrics) => {
      if (success) metrics.restoreSuccessCount += 1
      else metrics.restoreFailureCount += 1
    }, at)
  }

  recordDeletion(projectKey: string, at: string) {
    this.mutate(projectKey, (metrics) => { metrics.deletionCount += 1 }, at)
  }

  recordBackup(projectKey: string, bytes: number, at: string) {
    this.mutate(projectKey, (metrics) => {
      metrics.backupCount += 1
      metrics.backupBytes += bytes
    }, at)
  }

  recordBackupVerification(projectKey: string, success: boolean, at: string) {
    this.mutate(projectKey, (metrics) => {
      if (!success) metrics.backupVerificationFailureCount += 1
    }, at)
  }

  project(projectKey: string) {
    return { ...(this.metrics.get(projectKey) ?? EMPTY_METRICS) }
  }

  snapshot() {
    return [...this.metrics.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([projectKey, metrics]) => ({ projectKey, ...metrics }))
  }
}
