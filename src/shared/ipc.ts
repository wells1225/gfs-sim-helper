import type {
  AssistAnswer,
  AssistPreview,
  AssistStatus,
  BackupStatus,
  DisabledGroup,
  FiftyAnswer,
  FiftyGet,
  FiftyResult,
  FiftyStopResult,
  FixCall,
  FindAnswer,
  FindPreview,
  FixOutcome,
  GameRunState,
  JournalEntry,
  KeySetResult,
  KeyStatus,
  LocalSave,
  LocateView,
  OldSave,
  PcRole,
  Progress,
  ReportResult,
  ScanResult,
  Settings,
  ShareReceiveResult,
  ShareSendResult,
  ShareView,
  StartupRecovery,
  Symptom,
  UpdateInstall,
  UpdateState
} from './model.ts'

export interface IpcInvoke {
  // PR 7 owns this block
  'settings:get': { req: void; res: Settings }
  'settings:update': { req: Partial<Settings>; res: Settings } // folderPath must be a folder locate finds now
  'locate:run': { req: void; res: LocateView }
  'scan:run': { req: { folderPath: string; symptom: Symptom }; res: ScanResult } // same folderPath rule
  'game:check': { req: void; res: GameRunState }
  'report:build': { req: void; res: ReportResult }
  'report:reveal': { req: void; res: void } // shows the last report in Explorer
  // PR 10 owns this block
  'backup:status': { req: void; res: BackupStatus }
  'fix:apply': { req: FixCall; res: FixOutcome }
  'journal:list': { req: void; res: JournalEntry[] } // reads only; waits for the start-up recovery to finish
  'journal:recovery': { req: void; res: StartupRecovery } // reads only: what the start-up recovery did, once it finished
  'journal:undo': { req: { entryId: string }; res: FixOutcome }
  'groups:disabled': { req: void; res: DisabledGroup[] }
  // PR 11 owns this block
  'fifty:get': { req: void; res: FiftyGet } // { status: 'damaged' } when fiftyfifty.json cannot be read
  'fifty:start': { req: void; res: FiftyResult }
  'fifty:begin-round': { req: void; res: FiftyResult }
  'fifty:answer': { req: { answer: FiftyAnswer; round: number }; res: FiftyResult } // round: the round on her screen, so a late click cannot answer the next one
  'fifty:stop': { req: void; res: FiftyStopResult } // FiftyStopPartWay: a damaged-file stop that ended part way
  'fifty:finish': { req: { keep: 'keep-set-aside' | 'put-back' }; res: FiftyResult }
  // PR 12 owns this block
  'assist:status': { req: void; res: AssistStatus }
  'assist:preview': { req: void; res: AssistPreview | null }
  'assist:send': { req: { previewId: string }; res: AssistAnswer }
  'assist:set-key': { req: { key: string }; res: KeySetResult } // the only message that carries the key
  'assist:clear-key': { req: void; res: KeyStatus }
  // PR 13 owns this block
  'update:get': { req: void; res: UpdateState }
  'update:check': { req: { by: 'start' | 'click' }; res: UpdateState } // 'start' checks at most once in 24 hours
  'update:download': { req: void; res: UpdateState } // only from 'available'
  'update:install': { req: void; res: UpdateInstall } // only from 'ready'; 'busy' while a change runs
  // PR 14 owns this block
  'share:get': { req: void; res: ShareView } // reads the folder again
  'share:set-role': { req: { role: PcRole }; res: ShareView }
  'share:find-folder': { req: { by: 'look' | 'pick' | 'make' }; res: ShareView } // pick: main's own dialog; make: create it in My Drive
  'share:check': { req: void; res: ShareView } // writes our hello file, reads the other PC's
  'share:settings': { req: { keepOld?: number; keepInDrive?: number }; res: ShareView }
  'share:local-saves': { req: void; res: LocalSave[] }
  'share:send': { req: { shareId: string } | { slotId: string; name: string }; res: ShareSendResult } // second form: a save's first send
  'share:receive': { req: { shareId: string; seq: number; olderGame: 'stop' | 'go' }; res: ShareReceiveResult }
  'share:keep': { req: { shareId: string; keep: 'mine' | 'theirs' }; res: ShareView } // answers 'which-to-keep'
  'share:old-saves': { req: void; res: OldSave[] }
  'share:restore': { req: { oldId: string }; res: ShareReceiveResult }
  'share:stop': { req: { shareId: string }; res: ShareView } // forgets the link; every file stays
  'share:mod-link': { req: { groupId: string; link: string | null }; res: 'saved' | 'refused' } // typed for a manual mod
  'share:open-link': { req: { linkId: string }; res: 'opened' | 'refused' } // only addresses main validated itself
  'share:find-preview': { req: { shareId: string; seq: number; key: string }; res: FindPreview | null }
  'share:find-send': { req: { previewId: string }; res: FindAnswer }
}

export interface IpcEvents {
  progress: Progress
}

export const INVOKE_CHANNELS = [
  'settings:get',
  'settings:update',
  'locate:run',
  'scan:run',
  'game:check',
  'report:build',
  'report:reveal',
  'backup:status',
  'fix:apply',
  'journal:list',
  'journal:recovery',
  'journal:undo',
  'groups:disabled',
  'fifty:get',
  'fifty:start',
  'fifty:begin-round',
  'fifty:answer',
  'fifty:stop',
  'fifty:finish',
  'assist:status',
  'assist:preview',
  'assist:send',
  'assist:set-key',
  'assist:clear-key',
  'update:get',
  'update:check',
  'update:download',
  'update:install',
  'share:get',
  'share:set-role',
  'share:find-folder',
  'share:check',
  'share:settings',
  'share:local-saves',
  'share:send',
  'share:receive',
  'share:keep',
  'share:old-saves',
  'share:restore',
  'share:stop',
  'share:mod-link',
  'share:open-link',
  'share:find-preview',
  'share:find-send'
] as const satisfies readonly (keyof IpcInvoke)[]

export type Handlers<K extends keyof IpcInvoke> = {
  [C in K]: (req: IpcInvoke[C]['req']) => Promise<IpcInvoke[C]['res']>
}

export interface SimsHelperApi {
  invoke<K extends keyof IpcInvoke>(
    channel: K,
    ...req: IpcInvoke[K]['req'] extends void ? [] : [IpcInvoke[K]['req']]
  ): Promise<IpcInvoke[K]['res']>
  onProgress(listener: (progress: Progress) => void): () => void
}
