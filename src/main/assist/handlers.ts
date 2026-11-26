import type { Handlers } from '../../shared/ipc.ts'
import type { AssistPreview, KeyStatus } from '../../shared/model.ts'
import type { AppContext } from '../ports.ts'
import { ask, assistOffer, buildPreview } from './index.ts'

export type AssistChannel =
  | 'assist:status'
  | 'assist:preview'
  | 'assist:send'
  | 'assist:set-key'
  | 'assist:clear-key'

// No handler here logs a request or passes on an error: `assist:set-key` carries the key.
export function assistHandlers(ctx: AppContext): Handlers<AssistChannel> {
  // The newest preview she was shown. `assist:send` sends only this text, so the renderer cannot change it.
  let kept: AssistPreview | null = null

  async function keyStatus(): Promise<KeyStatus> {
    try {
      return await ctx.keyStore.status()
    } catch {
      return 'not-set'
    }
  }

  return {
    async 'assist:status'() {
      const key = await keyStatus()
      return { key, offer: assistOffer(ctx.session.scan, key) }
    },

    async 'assist:preview'() {
      const scan = ctx.session.scan
      kept = scan === null ? null : buildPreview(scan, ctx.redact, ctx.newId())
      return kept === null ? null : { id: kept.id, text: kept.text }
    },

    async 'assist:send'(req) {
      const previewId: unknown = req?.previewId
      const preview = kept
      if (preview === null || typeof previewId !== 'string' || previewId !== preview.id) {
        return { status: 'no-answer', why: 'preview-expired' }
      }
      return ask(ctx.keyStore, preview)
    },

    async 'assist:set-key'(req) {
      const key: unknown = req?.key
      try {
        return await ctx.keyStore.set(typeof key === 'string' ? key : '')
      } catch {
        const status = await keyStatus()
        return status === 'set' ? 'not-saved' : status
      }
    },

    async 'assist:clear-key'() {
      try {
        return await ctx.keyStore.clear()
      } catch {
        return keyStatus()
      }
    }
  }
}
