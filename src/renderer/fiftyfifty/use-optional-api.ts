import type { SimsHelperApi } from '../../shared/ipc.ts'
import { useApi } from '../api.tsx'

/** The shell renders the banner even where no API exists (the shell's own unit test), so a missing API is no banner. */
export function useOptionalApi(): SimsHelperApi | null {
  try {
    return useApi()
  } catch {
    return null
  }
}
