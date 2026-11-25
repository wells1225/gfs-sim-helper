import { createContext, useContext, type ReactNode } from 'react'
import type { SimsHelperApi } from '../shared/ipc.ts'

declare global {
  interface Window {
    simsHelper?: SimsHelperApi
  }
}

const ApiContext = createContext<SimsHelperApi | null>(null)

export function ApiProvider({ value, children }: { value: SimsHelperApi; children: ReactNode }) {
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
}

export function useApi(): SimsHelperApi {
  const fromContext = useContext(ApiContext)
  if (fromContext) return fromContext
  if (typeof window !== 'undefined' && window.simsHelper) {
    return window.simsHelper
  }
  throw new Error('SimsHelperApi is not available (wrap tests in <ApiProvider value={fakeApi(...)}>)')
}
