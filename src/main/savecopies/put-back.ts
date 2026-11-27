import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SavePutBack } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import type { GateResult } from '../ports.ts'
import { askGame, isSimsFolder, readSaveCopy, SAVE_NAME, type SaveCopyDeps } from './store.ts'

/** The highest slot the gate's save-new-slot zone takes: Slot_0 and 7 hex digits. */
const HIGHEST_SLOT = 0x0fffffff
/** Any name in saves/ that starts with a slot number: the save itself, its .ver files, anything else of it. */
const SLOT_NUMBER = /^Slot_([0-9a-fA-F]{8})(?:\.|$)/

/**
 * The new save's name: the lowest unused 8-digit lower-case hex number above the highest slot in saves/
 * (Slot_00000009.save there gives Slot_0000000a.save). Null above Slot_0fffffff.save.
 */
export function nextSlotName(names: readonly string[]): string | null {
  let highest = 0
  for (const name of names) {
    const match = SLOT_NUMBER.exec(name)
    if (match) highest = Math.max(highest, Number.parseInt(match[1]!, 16))
  }
  const next = highest + 1
  if (next > HIGHEST_SLOT) return null
  return `Slot_${next.toString(16).padStart(8, '0')}.save`
}

const refused = (why: Extract<SavePutBack, { kind: 'refused' }>['why']): SavePutBack => ({ kind: 'refused', why })

async function hashOrNull(file: string): Promise<string | null> {
  try {
    return await sha256File(file)
  } catch {
    return null
  }
}

/**
 * Puts one save from a copy back as a new save in saves/. It adds one file and changes nothing of hers, so it
 * has no journal entry and no Undo. One gate request, reason 'save-put-back': a copy into a slot name nobody has.
 * The new file is then read back and its hash compared.
 */
export async function putBackSave(
  deps: SaveCopyDeps,
  folderPath: string | null,
  copyId: string,
  save: string
): Promise<SavePutBack> {
  if (typeof copyId !== 'string' || typeof save !== 'string' || !SAVE_NAME.test(save)) return refused('not-found')
  const copy = await readSaveCopy(deps.paths, copyId)
  if (copy === null) return refused('not-found')
  const file = copy.saves.find((entry) => entry.name === save)
  if (file === undefined) return refused('not-found')
  if (copy.status !== 'checked') return refused('copy-broken')
  if (folderPath === null || !(await isSimsFolder(folderPath))) return refused('error')

  const game = await askGame(deps)
  if (game === 'running') return refused('game-running')
  if (game !== 'not-running') return refused('game-state-unknown')

  const from = join(deps.paths.saveCopiesDir, copy.id, 'saves', file.name)
  if ((await hashOrNull(from)) !== file.sha256) return refused('copy-broken')

  let names: string[]
  try {
    names = await readdir(join(folderPath, 'saves'))
  } catch {
    return refused('error')
  }
  const newSlot = nextSlotName(names)
  if (newSlot === null) return refused('no-free-slot')
  const to = join(folderPath, 'saves', newSlot)

  let result: GateResult
  try {
    result = await deps.gate.run({ reason: 'save-put-back', folderPath, ops: [{ op: 'copy', from, to }] })
  } catch {
    return refused('error')
  }
  if (result.status === 'refused') {
    if (result.refusal.reason === 'game-running') return refused('game-running')
    if (result.refusal.reason === 'game-state-unknown') return refused('game-state-unknown')
    return refused('error')
  }
  // 'failed' includes a disk that cannot make hard links: the gate never gives a save its name by a rename.
  if (result.status !== 'done') return refused('error')

  // Read back. A mismatch is told plainly; the file stays, since nothing of hers was replaced.
  if ((await hashOrNull(to)) !== file.sha256) return refused('error')
  return { kind: 'done', newSlot }
}
