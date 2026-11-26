import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type Route =
  | { screen: 'start' }
  | { screen: 'welcome' }
  | { screen: 'pick-folder' }
  | { screen: 'what-happened' }
  | { screen: 'check-up' }
  | { screen: 'send-to-tyler' }
  | { screen: 'about' }
  | { screen: 'mods' }
  | { screen: 'history' }
  | { screen: 'fifty-fifty' }
  | { screen: 'ask-for-help' }
  | { screen: 'key-setup' }
  | { screen: 'share' }
  | { screen: 'share-setup' }
  | { screen: 'share-old-saves' }
  | { screen: 'share-settings' }
  | { screen: 'patch-day' }

export interface NavContextValue {
  route: Route
  go(route: Route): void
}

const NavContext = createContext<NavContextValue | null>(null)

export function NavProvider({
  initial = { screen: 'start' },
  children
}: {
  initial?: Route
  children: ReactNode
}) {
  const [route, setRoute] = useState<Route>(initial)
  const go = useCallback((next: Route) => {
    setRoute(next)
  }, [])
  const value = useMemo(() => ({ route, go }), [route, go])
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext)
  if (!ctx) {
    throw new Error('useNav must be used inside NavProvider')
  }
  return ctx
}
