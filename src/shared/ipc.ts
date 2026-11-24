import type {
  AssistAnswer,
  AssistPreview,
  AssistStatus,
  BackupStatus,
  DisabledGroup,
  FiftyAnswer,
  FiftyFifty,
  FiftyResult,
  FixCall,
  FixOutcome,
  GameRunState,
  JournalEntry,
  KeyStatus,
  LocateView,
  Progress,
  ReportResult,
  ScanResult,
  Settings,
  Symptom
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
  'journal:list': { req: void; res: JournalEntry[] } // the first call also runs safety.recover()
  'journal:undo': { req: { entryId: string }; res: FixOutcome }
  'groups:disabled': { req: void; res: DisabledGroup[] }
  // PR 11 owns this block
  'fifty:get': { req: void; res: FiftyFifty | null }
  'fifty:start': { req: void; res: FiftyResult }
  'fifty:begin-round': { req: void; res: FiftyResult }
  'fifty:answer': { req: { answer: FiftyAnswer; round: number }; res: FiftyResult } // round: the round on her screen, so a late click cannot answer the next one
  'fifty:stop': { req: void; res: FiftyResult }
  'fifty:finish': { req: { keep: 'keep-set-aside' | 'put-back' }; res: FiftyResult }
  // PR 12 owns this block
  'assist:status': { req: void; res: AssistStatus }
  'assist:preview': { req: void; res: AssistPreview | null }
  'assist:send': { req: { previewId: string }; res: AssistAnswer }
  'assist:set-key': { req: { key: string }; res: KeyStatus } // the only message that carries the key
  'assist:clear-key': { req: void; res: KeyStatus }
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
  'assist:clear-key'
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
