import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeRehearsalPlan, rehearsalSettings } from '../../scripts/rehearse-single-host.mjs'

const source = { project: 'draftmatter-rehearsal-unit' }
const target = { project: 'draftmatter-restore-unit' }

function fixture({ failPhase } = {}) {
  const calls = []
  const record = (name, value) => { calls.push([name, value?.project]); return undefined }
  const actions = {
    async phase(name, action) {
      calls.push(['phase', name])
      if (name === failPhase) throw new Error('private fixture failure')
      return await action()
    },
    async skip(name) { calls.push(['skip', name]) },
    async validate(value) { record('validate', value) },
    async build(value) { record('build', value) },
    async start(value) { record('start', value) },
    async ready(value) { record('ready', value) },
    async smoke(value, verify) { calls.push([verify ? 'verify' : 'smoke', value.project]) },
    async restart(value) { record('restart', value) },
    async backup(value) { record('backup', value); return '/private/fixture.dmbackup' },
    async prepare(value) { record('prepare', value); return target },
    async restore(value) { record('restore', value) },
    async stop(value) { record('stop', value) },
  }
  return { actions, calls }
}

describe('single-host rehearsal orchestration boundaries', () => {
  it('refuses production modes, public bindings and non-rehearsal project names before mutating anything', () => {
    const directory = join(tmpdir(), 'draftmatter-rehearsal-unit')
    const envFile = join(directory, 'runtime.env')
    const environment = {
      DM_SINGLE_HOST_MODE: 'rehearsal', BIND_ADDRESS: '127.0.0.1', HTTP_PORT: '8088', HTTPS_PORT: '8443',
      COMPOSE_PROJECT_NAME: source.project, DM_SINGLE_HOST_DIR: directory,
      APP_HOST: 'app.draftmatter.localhost', COLLABORATION_HOST: 'sync.draftmatter.localhost', AUTH_HOST: 'auth.draftmatter.localhost',
    }
    expect(rehearsalSettings(environment, envFile)).toMatchObject({ restoreProject: target.project, restoreDirectory: `${directory}-restore` })
    for (const override of [
      { DM_SINGLE_HOST_MODE: 'production' }, { BIND_ADDRESS: '0.0.0.0' },
      { COMPOSE_PROJECT_NAME: 'draftmatter-alpha-production' }, { APP_HOST: 'app.real-domain.fr' },
    ]) expect(() => rehearsalSettings({ ...environment, ...override }, envFile)).toThrow()
  })

  it('stops the source when the first smoke fails and never prepares or stops an unrelated target', async () => {
    const { actions, calls } = fixture({ failPhase: 'initial-smoke' })
    await expect(executeRehearsalPlan(source, actions)).rejects.toThrow('private fixture failure')
    expect(calls.filter(([name]) => name === 'stop')).toEqual([['stop', source.project]])
    expect(calls.some(([name]) => name === 'prepare')).toBe(false)
  })

  it('preserves volumes by stopping only the dedicated projects after a restored verification failure', async () => {
    const { actions, calls } = fixture({ failPhase: 'restored-persistence' })
    await expect(executeRehearsalPlan(source, actions, { keepRunning: true })).rejects.toThrow('private fixture failure')
    expect(calls.filter(([name]) => name === 'stop')).toEqual([
      ['stop', source.project], ['stop', target.project], ['stop', source.project],
    ])
    expect(calls.some(([name]) => /delete|down|prune/.test(name))).toBe(false)
  })

  it('checks persistence after restart and restore, then stops both projects by default', async () => {
    const { actions, calls } = fixture()
    const result = await executeRehearsalPlan(source, actions, { skipBuild: true })
    expect(calls).toContainEqual(['skip', 'build'])
    expect(calls.some(([name]) => name === 'build')).toBe(false)
    expect(calls.filter(([name]) => name === 'verify')).toEqual([['verify', source.project], ['verify', target.project]])
    expect(result).toMatchObject({ status: 'passed', keptRunning: false, cleanup: [
      { project: target.project, stopped: true }, { project: source.project, stopped: true },
    ] })
  })

  it('honours keep-running only after success and still stops the source before starting the restore', async () => {
    const { actions, calls } = fixture()
    const result = await executeRehearsalPlan(source, actions, { keepRunning: true })
    expect(result).toMatchObject({ status: 'passed', keptRunning: true, cleanup: [] })
    const stoppedSource = calls.findIndex(([name]) => name === 'stop')
    const startedTarget = calls.findIndex(([name, project]) => name === 'start' && project === target.project)
    expect(stoppedSource).toBeLessThan(startedTarget)
    expect(calls.filter(([name]) => name === 'stop')).toEqual([['stop', source.project]])
  })
})
