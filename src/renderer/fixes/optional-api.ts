import type { SimsHelperApi } from '../../shared/ipc.ts'
import { useApi } from '../api.tsx'

/**
 * Safe wrapper around `useApi()` for shell slots (like RecoveryNotice) that may
 * mount in unit tests where `<App />` is rendered without `<ApiProvider>`.
 * `useApi()` calls `useContext` unconditionally before throwing, so hook order stays stable.
 */
export function useOptionalApi(): SimsHelperApi | null {
  try {
    return useApi()
  } catch {
    return null
  }
}
