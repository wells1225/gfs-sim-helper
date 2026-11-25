import type { GateDeps, GateResult, WriteRequest } from '../ports.ts'

export async function runGate(_deps: GateDeps, _request: WriteRequest): Promise<GateResult> {
  throw new Error('not implemented: runGate')
}
