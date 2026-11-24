import type { AssistAnswer, AssistPreview, KeyStatus, Scan } from '../../shared/model.ts'
import type { KeyStore } from '../ports.ts'

export const ASSIST_MODEL = 'claude-haiku-5-5'

export function assistOffer(_scan: Scan | null, _key: KeyStatus): 'offer' | 'hide' {
  throw new Error('not implemented: assistOffer')
}

export function buildPreview(_scan: Scan, _redact: (text: string) => string, _id: string): AssistPreview {
  throw new Error('not implemented: buildPreview')
}

export async function ask(_keyStore: KeyStore, _preview: AssistPreview): Promise<AssistAnswer> {
  throw new Error('not implemented: ask')
}
