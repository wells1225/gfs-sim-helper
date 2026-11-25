import type { LocateView, ScanResult, SimsFolder, Symptom } from '../../shared/model.ts'
import type { OnProgress, ScanDeps } from '../ports.ts'

export async function runScan(
  _deps: ScanDeps,
  _input: LocateView & { folder: SimsFolder; symptom: Symptom },
  _onProgress?: OnProgress
): Promise<ScanResult> {
  throw new Error('not implemented: runScan')
}
