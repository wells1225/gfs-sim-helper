import type { SimsHelperApi } from '../../shared/ipc.ts'
import { Button } from '../components/ui/button.tsx'
import { useNav } from '../nav.tsx'
import { BACK_UNKNOWN, notBackLabels, notBackWords } from './words.ts'

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
