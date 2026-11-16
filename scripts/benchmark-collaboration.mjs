#!/usr/bin/env node
// Build the TypeScript workload once, then isolate every sample in a fresh process.
import { build } from 'vite'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir, cpus, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const args = Object.fromEntries(process.argv.slice(2).map((argument) => argument.replace(/^--/, '').split('=')))
const runs = Number(args.runs ?? 3)
const samples = Number(args.samples ?? 100)
const rounds = Number(args.rounds ?? 15)
const fixtures = args.fixtures?.split(',') ?? ['article', 'rich']
const modes = args.modes?.split(',') ?? ['reference', 'incremental']
const scenarios = args.scenarios?.split(',') ?? ['micro', 'transport']
if (![runs, samples, rounds].every((number) => Number.isSafeInteger(number) && number > 0)) throw new Error('runs, samples and rounds must be positive integers.')
const output = resolve(args.output ?? join(tmpdir(), `draftmatter-collaboration-benchmark-${Date.now()}.json`))
const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-collaboration-benchmark-'))
try {
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n')
  await symlink(resolve('node_modules'), join(temporary, 'node_modules'), 'dir')
  await build({ configFile: false, logLevel: 'warn', build: { target: 'node24', outDir: temporary, emptyOutDir: false, minify: false, ssr: resolve('scripts/collaboration-benchmark-worker.ts'), rollupOptions: { output: { entryFileNames: 'worker.js' } } } })
  if (args['baseline-revision']) {
    const sourcePath = resolve('services/collaboration/hocuspocusServer.ts')
    const baselineSource = execFileSync('git', ['show', `${args['baseline-revision']}:services/collaboration/hocuspocusServer.ts`], { encoding: 'utf8' })
    await build({ configFile: false, logLevel: 'warn', plugins: [{ name: 'benchmark-historical-validator', enforce: 'pre', load(id) { if (id === sourcePath) return baselineSource + (/export class CollaborationUpdateValidator/.test(baselineSource) ? '' : '\nexport class CollaborationUpdateValidator {}\n') } }], build: { target: 'node24', outDir: temporary, emptyOutDir: false, minify: false, ssr: resolve('scripts/collaboration-benchmark-worker.ts'), rollupOptions: { output: { entryFileNames: 'reference.js' } } } })
  }
  if (args.profile) await mkdir(resolve(args.profile), { recursive: true })
  const results = []
  const environment = { recordedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, cpu: cpus()[0]?.model, logicalCPUs: cpus().length, memoryBytes: totalmem(), runs, samples, rounds, baselineRevision: args['baseline-revision'] ?? 'current reference reconstruction path', note: 'Local loopback measurements. Server runs separately from ten Node provider clients; this is not a VPS qualification.' }
  for (let run = 0; run < runs; run++) {
    for (const fixture of fixtures) for (const scenario of scenarios) {
      // Alternate order to reduce a consistent first-mode/warm-cache advantage.
      for (const mode of run % 2 ? [...modes].reverse() : modes) {
        console.error(`benchmark run=${run + 1}/${runs} fixture=${fixture} scenario=${scenario} mode=${mode}`)
        const value = await new Promise((resolveResult, reject) => {
          const profileArguments = args.profile ? ['--cpu-prof', `--cpu-prof-dir=${resolve(args.profile)}`, `--cpu-prof-name=${scenario}-${mode}-${fixture}-${run + 1}.cpuprofile`] : []
          const worker = mode === 'reference' && args['baseline-revision'] ? 'reference.js' : 'worker.js'
          const child = spawn(process.execPath, ['--expose-gc', ...profileArguments, join(temporary, worker), scenario, mode, fixture, String(samples), String(rounds)], { stdio: ['ignore', 'pipe', 'inherit'] })
          let stdout = ''
          child.stdout.on('data', (data) => { stdout += data })
          child.once('error', reject)
          child.once('exit', (code) => {
            if (code !== 0) return reject(new Error(`Benchmark exited with ${code}.`))
            try { resolveResult(JSON.parse(stdout)) } catch { reject(new Error(`Invalid benchmark result: ${stdout.slice(-2000)}`)) }
          })
        })
        results.push({ run: run + 1, fixtureName: fixture, scenario, mode, ...value })
        await writeFile(output, `${JSON.stringify({ environment, results }, null, 2)}\n`)
      }
    }
  }
  console.log(output)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
