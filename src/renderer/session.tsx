import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Scan, Symptom } from '../shared/model.ts'

export interface SessionContextValue {
  scan: Scan | null
  setScan(scan: Scan | null): void
  symptom: Symptom
  setSymptom(symptom: Symptom): void
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({
  initialScan = null,
  initialSymptom = 'not-sure',
  children
}: {
  initialScan?: Scan | null
  initialSymptom?: Symptom
  children: ReactNode
}) {
  const [scan, setScan] = useState<Scan | null>(initialScan)
  const [symptom, setSymptom] = useState<Symptom>(initialSymptom)
  const value = useMemo(() => ({ scan, setScan, symptom, setSymptom }), [scan, symptom])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) {
    throw new Error('useSession must be used inside SessionProvider')
  }
  return ctx
}
