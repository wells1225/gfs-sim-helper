import { useEffect } from 'react'
import { APP_TITLE } from '../shared/app.ts'
import { About } from './About.tsx'
import { AskScreen } from './assist/AskScreen.tsx'
import { KeySetupScreen } from './assist/KeySetupScreen.tsx'
import { Emblem } from './components/Emblem.tsx'
import { Button } from './components/ui/button.tsx'
import { Toaster } from './components/ui/sonner.tsx'
import { FiftyFiftyScreen } from './fiftyfifty/FiftyFiftyScreen.tsx'
import { ResumeBanner } from './fiftyfifty/ResumeBanner.tsx'
import { FIXES_READY } from './fixes/feature.ts'
import { HistoryScreen } from './fixes/HistoryScreen.tsx'
import { ModsScreen } from './fixes/ModsScreen.tsx'
import { RecoveryNotice } from './fixes/RecoveryNotice.tsx'
import { NavProvider, useNav, type Route } from './nav.tsx'
import { CheckUp } from './screens/CheckUp.tsx'
import { PickFolder } from './screens/PickFolder.tsx'
import { SendToTyler } from './screens/SendToTyler.tsx'
import { Start } from './screens/Start.tsx'
import { Welcome } from './screens/Welcome.tsx'
import { WhatHappened } from './screens/WhatHappened.tsx'
import { SessionProvider } from './session.tsx'
import { UpdateBanner } from './update/UpdateBanner.tsx'
import { UpdateRow } from './update/UpdateRow.tsx'

function renderScreen(route: Route) {
  switch (route.screen) {
    case 'start':
      return <Start />
    case 'welcome':
      return <Welcome />
    case 'pick-folder':
      return <PickFolder />
    case 'what-happened':
      return <WhatHappened />
    case 'check-up':
      return <CheckUp />
    case 'send-to-tyler':
      return <SendToTyler />
    case 'about':
      return (
        <>
          <About />
          <UpdateRow />
        </>
      )
    case 'mods':
      return <ModsScreen />
    case 'history':
      return <HistoryScreen />
    case 'fifty-fifty':
      return <FiftyFiftyScreen />
    case 'ask-for-help':
      return <AskScreen />
    case 'key-setup':
      return <KeySetupScreen />
  }
}

function Shell() {
  const { route, go } = useNav()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        go({ screen: 'key-setup' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [go])

  const navItems: { label: string; screen: Route['screen'] }[] = [
    { label: 'Check-up', screen: 'check-up' },
    ...(FIXES_READY
      ? [
          { label: 'Your mods', screen: 'mods' as const },
          { label: 'History', screen: 'history' as const }
        ]
      : []),
    { label: 'About', screen: 'about' }
  ]

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border bg-card/80 backdrop-blur-xs">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <Emblem className="size-8" />
            <span className="text-base font-semibold tracking-tight">{APP_TITLE}</span>
          </div>

          <nav aria-label="Primary" className="flex items-center gap-1">
            {navItems.map((item) => {
              const active = route.screen === item.screen
              return (
                <Button
                  key={item.screen}
                  variant={active ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => go({ screen: item.screen })}
                >
                  {item.label}
                </Button>
              )
            })}
          </nav>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-5 py-6">
        <UpdateBanner />
        <RecoveryNotice />
        <ResumeBanner />
        <div className="flex-1">{renderScreen(route)}</div>
      </div>

      <footer className="border-t border-border bg-card/60">
        <div className="mx-auto w-full max-w-3xl px-5 py-3 text-center text-sm text-muted-foreground">
          Saves and Tray are never touched · A backup is made before any change
        </div>
      </footer>

      <Toaster />
    </div>
  )
}

export function App({ initialRoute = { screen: 'start' } }: { initialRoute?: Route } = {}) {
  return (
    <SessionProvider>
      <NavProvider initial={initialRoute}>
        <Shell />
      </NavProvider>
    </SessionProvider>
  )
}
