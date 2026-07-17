export type RuntimeLanguage = 'python' | 'r' | 'julia'
export type RuntimeHealth = 'available' | 'missing' | 'unhealthy'

export interface RuntimeExecutableProbe {
  language: RuntimeLanguage
  health: RuntimeHealth
  executable?: string
  version?: string
  message?: string
}

export interface JupyterKernelProbe {
  name: string
  displayName: string
  language?: RuntimeLanguage
  health: RuntimeHealth
  resourceDir: string
  executable?: string
  message?: string
}

export interface JupyterKernelInventory {
  health: RuntimeHealth
  kernels: JupyterKernelProbe[]
  searchedLocations: string[]
  message?: string
}

export interface RuntimeInventory {
  discoveredAt: string
  executables: Record<RuntimeLanguage, RuntimeExecutableProbe>
  jupyter: JupyterKernelInventory
}

export interface RuntimeDiscoveryProbe {
  probeRuntime(language: RuntimeLanguage): Promise<RuntimeExecutableProbe>
  discoverJupyterKernels(): Promise<JupyterKernelInventory>
}

function failedExecutableProbe(language: RuntimeLanguage, error: unknown): RuntimeExecutableProbe {
  return {
    language,
    health: 'unhealthy',
    message: error instanceof Error ? error.message : String(error),
  }
}

function failedKernelProbe(error: unknown): JupyterKernelInventory {
  return {
    health: 'unhealthy',
    kernels: [],
    searchedLocations: [],
    message: error instanceof Error ? error.message : String(error),
  }
}

export async function discoverRuntimeInventory(
  probe: RuntimeDiscoveryProbe,
  clock: () => Date = () => new Date(),
): Promise<RuntimeInventory> {
  const [python, r, julia, jupyter] = await Promise.all([
    probe.probeRuntime('python').catch((error) => failedExecutableProbe('python', error)),
    probe.probeRuntime('r').catch((error) => failedExecutableProbe('r', error)),
    probe.probeRuntime('julia').catch((error) => failedExecutableProbe('julia', error)),
    probe.discoverJupyterKernels().catch(failedKernelProbe),
  ])
  return {
    discoveredAt: clock().toISOString(),
    executables: { python, r, julia },
    jupyter,
  }
}

export function createRuntimeDiscovery(probe: RuntimeDiscoveryProbe, clock?: () => Date) {
  return {
    discover: () => discoverRuntimeInventory(probe, clock),
  }
}

export function healthyKernelsFor(inventory: RuntimeInventory, language: RuntimeLanguage) {
  return inventory.jupyter.kernels.filter((kernel) => kernel.language === language && kernel.health === 'available')
}

export function runtimeExecutableForKernelSetup(
  kernel: JupyterKernelProbe | undefined,
  savedEnvironment: string | undefined,
  runtime: RuntimeExecutableProbe | undefined,
) {
  return kernel?.executable ?? savedEnvironment ?? (runtime?.health === 'available' ? runtime.executable : undefined)
}
