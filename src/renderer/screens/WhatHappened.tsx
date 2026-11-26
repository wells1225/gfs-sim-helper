import {
  ChevronRight,
  CircleX,
  FolderOpen,
  HelpCircle,
  Home,
  MonitorOff,
  PauseCircle,
  RefreshCw,
  type LucideIcon
} from 'lucide-react'
import type { Symptom } from '../../shared/model.ts'
import { Button } from '../components/ui/button.tsx'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'

interface SymptomOption {
  id: Symptom
  title: string
  description: string
  icon: LucideIcon
}

const SYMPTOM_OPTIONS: readonly SymptomOption[] = [
  {
    id: 'closes',
    title: 'The game closes by itself',
    description: 'It crashes straight back to the desktop while you are playing.',
    icon: CircleX
  },
  {
    id: 'freezes',
    title: 'It freezes or gets stuck',
    description: 'The screen stops moving or stays stuck on a loading screen.',
    icon: PauseCircle
  },
  {
    id: 'wont-load',
    title: "It won't open or load at all",
    description: 'The game never reaches the main menu, or breaks right after patch day.',
    icon: MonitorOff
  },
  {
    id: 'one-save-or-lot',
    title: 'One save or lot is broken',
    description: 'A specific household, lot, CAS, or Build/Buy triggers the crash.',
    icon: Home
  },
  {
    id: 'not-sure',
    title: "I'm not sure, just check everything",
    description: 'Look through my mods folder, script mods, package files, and crash logs.',
    icon: HelpCircle
  }
]

export function WhatHappened() {
  const { go } = useNav()
  const { setSymptom, setScan } = useSession()

  function handleChoose(symptom: Symptom) {
    setSymptom(symptom)
    setScan(null)
    go({ screen: 'check-up' })
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">What happened?</h1>
        <p className="text-muted-foreground">
          Pick the closest match and we&apos;ll run a calm, read-only check-up on your mods folder.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {SYMPTOM_OPTIONS.map((option) => {
          const Icon = option.icon
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => handleChoose(option.id)}
              className="group flex w-full cursor-pointer items-center gap-3.5 rounded-xl border border-border bg-card px-4 py-3 text-left text-card-foreground shadow-xs hover:border-primary/50 hover:bg-accent/50"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground group-hover:bg-primary group-hover:text-primary-foreground">
                <Icon className="size-5" strokeWidth={1.75} />
              </span>

              <span className="flex flex-1 flex-col gap-0.5">
                <span className="text-base font-semibold text-foreground">{option.title}</span>
                <span className="text-sm text-muted-foreground">{option.description}</span>
              </span>

              <ChevronRight
                className="size-5 shrink-0 text-muted-foreground group-hover:translate-x-0.5 group-hover:text-foreground"
                strokeWidth={1.75}
              />
            </button>
          )
        })}
      </div>

      <button
        type="button"
        onClick={() => go({ screen: 'patch-day' })}
        className="group flex w-full cursor-pointer items-center gap-3.5 rounded-xl border border-dashed border-border bg-transparent px-4 py-3 text-left hover:border-primary/50 hover:bg-accent/30"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <RefreshCw className="size-5" strokeWidth={1.75} />
        </span>
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="text-[0.9375rem] font-medium text-foreground">The Sims 4 just updated</span>
          <span className="text-sm text-muted-foreground">
            Set aside script mods safely before opening your save. Your custom content and saves stay untouched.
          </span>
        </span>
        <ChevronRight className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      </button>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => go({ screen: 'pick-folder' })}>
          <FolderOpen className="size-4" strokeWidth={1.75} />
          Switch Sims 4 folder
        </Button>
      </div>
    </main>
  )
}
