import { useEffect, useRef, useState } from 'react'
import { APP_TITLE } from '../shared/app.ts'
import type { Progress, StartupRecovery } from '../shared/model.ts'
import { About } from './About.tsx'
import { AskScreen } from './assist/AskScreen.tsx'
import { KeySetupScreen } from './assist/KeySetupScreen.tsx'
import { Emblem } from './components/Emblem.tsx'
import { Button } from './components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.tsx'
import { Toaster } from './components/ui/sonner.tsx'
import { FiftyFiftyScreen } from './fiftyfifty/FiftyFiftyScreen.tsx'
import { ResumeBanner } from './fiftyfifty/ResumeBanner.tsx'
import { FIXES_READY } from './fixes/feature.ts'
import { HistoryScreen } from './fixes/HistoryScreen.tsx'
import { ModsScreen } from './fixes/ModsScreen.tsx'
import { useOptionalApi } from './fixes/optional-api.ts'
import { RecoveryNotice } from './fixes/RecoveryNotice.tsx'
import { NavProvider, useNav, type Route } from './nav.tsx'
import { PatchDayScreen } from './patchday/PatchDayScreen.tsx'
import { CheckUp } from './screens/CheckUp.tsx'
import { PickFolder } from './screens/PickFolder.tsx'
import { SendToTyler } from './screens/SendToTyler.tsx'
import { Start } from './screens/Start.tsx'
import { Welcome } from './screens/Welcome.tsx'
import { WhatHappened } from './screens/WhatHappened.tsx'
import { SessionProvider } from './session.tsx'
import { SHARE_READY } from './share/feature.ts'
import { OldSavesScreen } from './share/OldSavesScreen.tsx'
import { SetupScreen } from './share/SetupScreen.tsx'
import { ShareBanner } from './share/ShareBanner.tsx'
import { ShareScreen } from './share/ShareScreen.tsx'
import { SharingSettingsScreen } from './share/SharingSettingsScreen.tsx'
import { UpdateBanner } from './update/UpdateBanner.tsx'
import { UpdateRow } from './update/UpdateRow.tsx'

const RECOVERY_WAIT_DELAY_MS = 250

function renderScreen(route: Route, hasApi: boolean) {
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
          {hasApi && <UpdateRow />}
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
    case 'share':
      return <ShareScreen />
    case 'share-setup':
      return <SetupScreen />
    case 'share-old-saves':
      return <OldSavesScreen />
    case 'share-settings':
      return <SharingSettingsScreen />
    case 'patch-day':
      return <PatchDayScreen />
  }
}

function recoveryProgressCopy(progress: Progress | null): { label: string; detail: string | null } | null {
  if (!progress) return null
  if (progress.task === 'backup') {
    if (progress.total === null) {
      return { label: 'Making a safety copy first...', detail: 'Counting files to protect...' }
    }
    const verb = progress.stage === 'checking' ? 'Checking' : 'Copying'
    return {
      label: 'Making a safety copy first...',
      detail: `${verb} ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} files`
    }
  }
  if (progress.task === 'fix') {
    return {
      label: 'Putting files back...',
      detail:
        progress.total !== null ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} steps` : null
    }
  }
  return null
}

function Shell() {
  const api = useOptionalApi()
  const { route, go } = useNav()
  const [recoveryState, setRecoveryState] = useState<{ api: NonNullable<typeof api>; value: StartupRecovery } | null>(
    null
  )
  const [showRecoveryWait, setShowRecoveryWait] = useState(false)
  const [recoveryProgress, setRecoveryProgress] = useState<Progress | null>(null)

  const recovery = api !== null && recoveryState?.api === api ? recoveryState.value : null
  const recoveryPending = api !== null && recovery === null
  const recoveryPendingRef = useRef(recoveryPending)
  recoveryPendingRef.current = recoveryPending

  useEffect(() => {
    if (!api) return
    let cancelled = false
    api
      .invoke('journal:recovery')
      .then((answer) => {
        if (!cancelled) setRecoveryState({ api, value: answer })
      })
      .catch(() => {
        if (!cancelled) setRecoveryState({ api, value: { status: 'failed' } })
      })
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => {
    if (!api || !recoveryPending) {
      setShowRecoveryWait(false)
      setRecoveryProgress(null)
      return
    }
    const timer = setTimeout(() => {
      setShowRecoveryWait(true)
    }, RECOVERY_WAIT_DELAY_MS)
    const unsubscribe = api.onProgress((progress) => {
      if (progress.task === 'backup' || progress.task === 'fix') {
        setRecoveryProgress(progress)
      }
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [api, recoveryPending])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (recoveryPendingRef.current) return
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
    ...(SHARE_READY ? [{ label: 'Share saves', screen: 'share' as const }] : []),
    { label: 'About', screen: 'about' }
  ]

  const progressCopy = recoveryProgressCopy(recoveryProgress)

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
                  disabled={recoveryPending}
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
        {recoveryPending ? (
          <div
            role="status"
            aria-live="polite"
            className={showRecoveryWait ? 'flex flex-1 items-center justify-center py-12' : 'flex-1'}
          >
            {showRecoveryWait && (
              <Card className="w-full max-w-lg">
                <CardHeader>
                  <CardTitle>Checking your last session...</CardTitle>
                  <CardDescription>
                    Making sure your last change finished cleanly. Your saves and households are never touched.
                  </CardDescription>
                </CardHeader>
                {progressCopy && (
                  <CardContent className="text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">{progressCopy.label}</p>
                    {progressCopy.detail && <p>{progressCopy.detail}</p>}
                  </CardContent>
                )}
              </Card>
            )}
          </div>
        ) : (
          <>
            {api !== null && <UpdateBanner />}
            <ShareBanner />
            <RecoveryNotice recovery={recovery} />
            <ResumeBanner />
            <div className="flex-1">{renderScreen(route, api !== null)}</div>
          </>
        )}
      </div>

      <footer className="border-t border-border bg-card/60">
        <div className="mx-auto w-full max-w-3xl px-5 py-3 text-center text-sm text-muted-foreground">
          {/* PR 14 changes this line again when Share saves lands (briefs/pr-14.md, contract request 9). */}
          Your saves and households are never touched · A backup is made before any change
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
