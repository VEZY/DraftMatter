import { describe, expect, it, vi } from 'vitest'
import {
  createRuntimeDiscovery,
  discoverRuntimeInventory,
  healthyKernelsFor,
  type JupyterKernelInventory,
  type RuntimeDiscoveryProbe,
  type RuntimeHealth,
  type RuntimeLanguage,
} from './runtimeDiscovery'

const languages: RuntimeLanguage[] = ['python', 'r', 'julia']

function probeForMask(mask: number): RuntimeDiscoveryProbe {
  return {
    async probeRuntime(language) {
      const available = Boolean(mask & (1 << languages.indexOf(language)))
      return {
        language,
        health: available ? 'available' : 'missing',
        ...(available ? { executable: `/runtime/${language}`, version: `${language} fixture` } : {}),
      }
    },
    async discoverJupyterKernels(): Promise<JupyterKernelInventory> {
      const available = Boolean(mask & 8)
      return {
        health: available ? 'available' : 'missing',
        kernels: available
          ? [{ name: 'python-fixture', displayName: 'Python fixture', language: 'python', health: 'available', resourceDir: '/kernels/python', executable: '/runtime/python' }]
          : [],
        searchedLocations: ['/kernels'],
      }
    },
  }
}

describe('runtime discovery', () => {
  it.each(Array.from({ length: 16 }, (_, mask) => mask))('keeps all present/missing combinations independent (mask %i)', async (mask) => {
    const inventory = await discoverRuntimeInventory(probeForMask(mask), () => new Date('2026-07-15T12:00:00.000Z'))
    const expected = (bit: number): RuntimeHealth => mask & bit ? 'available' : 'missing'

    expect(inventory.discoveredAt).toBe('2026-07-15T12:00:00.000Z')
    expect(inventory.executables.python.health).toBe(expected(1))
    expect(inventory.executables.r.health).toBe(expected(2))
    expect(inventory.executables.julia.health).toBe(expected(4))
    expect(inventory.jupyter.health).toBe(expected(8))
  })

  it('does not probe until an explicit discovery action', async () => {
    const probe = probeForMask(15)
    const runtimeSpy = vi.spyOn(probe, 'probeRuntime')
    const kernelSpy = vi.spyOn(probe, 'discoverJupyterKernels')
    const discovery = createRuntimeDiscovery(probe)

    expect(runtimeSpy).not.toHaveBeenCalled()
    expect(kernelSpy).not.toHaveBeenCalled()
    await discovery.discover()
    expect(runtimeSpy).toHaveBeenCalledTimes(3)
    expect(kernelSpy).toHaveBeenCalledTimes(1)
  })

  it('contains individual probe failures instead of masking healthy languages', async () => {
    const inventory = await discoverRuntimeInventory({
      async probeRuntime(language) {
        if (language === 'r') throw new Error('R probe failed safely')
        return { language, health: 'available', executable: `/runtime/${language}` }
      },
      async discoverJupyterKernels() {
        throw new Error('Kernel locations unreadable')
      },
    })

    expect(inventory.executables.python.health).toBe('available')
    expect(inventory.executables.r).toMatchObject({ health: 'unhealthy', message: 'R probe failed safely' })
    expect(inventory.executables.julia.health).toBe('available')
    expect(inventory.jupyter).toMatchObject({ health: 'unhealthy', message: 'Kernel locations unreadable' })
  })

  it('selects only healthy kernels for the requested language', async () => {
    const inventory = await discoverRuntimeInventory({
      ...probeForMask(15),
      async discoverJupyterKernels() {
        return {
          health: 'available',
          searchedLocations: ['/kernels'],
          kernels: [
            { name: 'py', displayName: 'Python', language: 'python', health: 'available', resourceDir: '/kernels/py' },
            { name: 'py-broken', displayName: 'Python broken', language: 'python', health: 'unhealthy', resourceDir: '/kernels/py-broken' },
            { name: 'jl', displayName: 'Julia', language: 'julia', health: 'available', resourceDir: '/kernels/jl' },
          ],
        } as JupyterKernelInventory
      },
    })

    expect(healthyKernelsFor(inventory, 'python').map((kernel) => kernel.name)).toEqual(['py'])
  })
})
