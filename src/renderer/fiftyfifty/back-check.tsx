import type { SimsHelperApi } from '../../shared/ipc.ts'
import { Button } from '../components/ui/button.tsx'
import { useNav } from '../nav.tsx'
import type { FiftyFifty } from '../../shared/model.ts'
import { BACK_UNKNOWN, isSetAside, notBackLabels, notBackWords } from './words.ts'

/** Whether everything the test moved is back: the only ground for saying "All your mods are back in place". */
export type BackCheck = { kind: 'all-back' } | { kind: 'left'; labels: string[] } | { kind: 'unknown' }

/** Asks History after a stop. A list that cannot be read is 'unknown', never 'all-back'. */
export async function checkBack(api: SimsHelperApi, sessionId: string | null, keep: string | null): Promise<BackCheck> {
  try {
    const labels = notBackLabels(await api.invoke('journal:list'), sessionId, keep)
    return labels.length === 0 ? { kind: 'all-back' } : { kind: 'left', labels }
  } catch {
    return { kind: 'unknown' }
  }
}

/**
 * What the found card may say. `others`: whether every other mod of this test is back. `causeAside`: whether the
 * cause is set aside right now, or null when History cannot tell.
 */
export interface FoundCheck {
  others: BackCheck
  causeAside: boolean | null
}

export async function checkFound(api: SimsHelperApi, state: FiftyFifty): Promise<FoundCheck> {
  try {
    const journal = await api.invoke('journal:list')
    const labels = notBackLabels(journal, state.id, state.culprit)
    return {
      others: labels.length === 0 ? { kind: 'all-back' } : { kind: 'left', labels },
      causeAside: state.culprit === null ? null : isSetAside(journal, state.folderPath, state.culprit)
    }
  } catch {
    return { others: { kind: 'unknown' }, causeAside: null }
  }
}

export function backWords(back: Exclude<BackCheck, { kind: 'all-back' }>): string {
  return back.kind === 'left' ? notBackWords(back.labels) : BACK_UNKNOWN
}

export function HistoryButton() {
  const { go } = useNav()
  return (
    <Button variant="outline" onClick={() => go({ screen: 'history' })}>
      Open History
    </Button>
  )
}
