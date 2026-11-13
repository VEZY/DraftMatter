import { describe, expect, it } from 'vitest'
import { createSmokeCheckParser, runRehearsalCommand, runSmokeCheck } from '../../scripts/rehearse-single-host.mjs'

const secret = 'synthetic-private-oauth-response-and-password'

describe('sanitized rehearsal sub-check diagnostics', () => {
  it('emits only fixed identifiers, preserves failures and refuses unknown identifiers before actions run', async () => {
    const lines = [], emit = (line) => lines.push(line)
    await expect(runSmokeCheck('application-home', async () => 42, emit)).resolves.toBe(42)
    const failure = new Error(secret)
    await expect(runSmokeCheck('application-session', async () => { throw failure }, emit)).rejects.toBe(failure)
    let ran = false
    await expect(runSmokeCheck(secret, async () => { ran = true }, emit)).rejects.toThrow('Unknown rehearsal smoke check identifier')
    expect(ran).toBe(false)
    expect(lines).toEqual([
      'DM_REHEARSAL_CHECK=application-home:started', 'DM_REHEARSAL_CHECK=application-home:passed',
      'DM_REHEARSAL_CHECK=application-session:started', 'DM_REHEARSAL_CHECK=application-session:failed',
    ])
    expect(JSON.stringify(lines)).not.toContain(secret)
  })

  it('handles split pipe writes while rejecting private, unknown, decorated and oversized lines', () => {
    const events = [], parser = createSmokeCheckParser((event) => events.push(event))
    parser.write(Buffer.from(secret + '\nDM_REHEARSAL_CHE'))
    parser.write(Buffer.from('CK=public-legal-confidentialite:started\n'))
    parser.write(Buffer.from('DM_REHEARSAL_CHECK=unknown-' + secret + ':failed\n'))
    parser.write(Buffer.from('DM_REHEARSAL_CHECK=application-home:failed ' + secret + '\n'))
    parser.write(Buffer.from('x'.repeat(200_000)))
    parser.write(Buffer.from('DM_REHEARSAL_CHECK=application-home:failed\n'))
    parser.write(Buffer.from('DM_REHEARSAL_CHECK=public-legal-confidentialite:failed\nDM_REHEARSAL_CHECK=public-checks:failed'))
    parser.finish()
    expect(events).toEqual([
      { name: 'public-legal-confidentialite', status: 'started' },
      { name: 'public-legal-confidentialite', status: 'failed' },
      { name: 'public-checks', status: 'failed' },
    ])
    expect(parser.failed).toBe('public-legal-confidentialite')
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it.each([
    ['started', 'at'], ['failed', 'at'], ['passed', 'after'],
  ])('names a real failing child %s check without forwarding its private stdout/stderr', async (status, relation) => {
    const events = []
    const output = 'unrecognized-private-output=' + secret + '\nDM_REHEARSAL_CHECK=application-session:' + status + '\n'
    const program = 'process.stdout.write(' + JSON.stringify(output) + '); process.stderr.write(' + JSON.stringify(secret) + '); process.exitCode = 1;'
    let error
    try {
      await runRehearsalCommand(process.execPath, ['-e', program], { label: 'Rehearsal Node phase', onCheck: (event) => events.push(event) })
    } catch (caught) { error = caught }
    expect(error?.message).toBe('Rehearsal Node phase failed ' + relation + ' smoke check application-session; run that phase directly for private diagnostics.')
    expect(events).toEqual([{ name: 'application-session', status }])
    expect(error.message + JSON.stringify(events)).not.toContain(secret)
  })
})
