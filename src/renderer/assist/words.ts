import type { AssistAnswer, KeyStatus } from '../../shared/model.ts'

export type NoAnswerWhy = Extract<AssistAnswer, { status: 'no-answer' }>['why']

export interface NoAnswerCopy {
  title: string
  detail: string
  canRetry: boolean
}

// A Record over the whole union, so a new reason fails typecheck until it has words.
export const NO_ANSWER_WORDS: Record<NoAnswerWhy, NoAnswerCopy> = {
  'no-key': {
    title: "Ask for help isn't set up on this PC",
    detail: 'Nothing was sent and nothing on your PC was changed. Let Tyler know, and he can set it up.',
    canRetry: false
  },
  'key-rejected': {
    title: 'Ask for help needs Tyler for a moment',
    detail:
      "The key Tyler set up for Ask for help isn't working any more. Nothing on your PC was changed. Let Tyler know, and he can set it up again.",
    canRetry: false
  },
  declined: {
    title: "It couldn't answer this one.",
    detail:
      'Nothing on your PC was changed. The 50/50 test on your check-up can still find the mod that causes the trouble, or you can send your report to Tyler.',
    canRetry: false
  },
  offline: {
    title: "Couldn't reach the helper",
    detail: 'Check that this PC is online, then try again. Nothing on your PC was changed.',
    canRetry: true
  },
  'limit-reached': {
    title: 'Ask for help has reached its limit for now',
    detail: 'Try again later, or send your report to Tyler. Nothing on your PC was changed.',
    canRetry: true
  },
  'preview-expired': {
    title: 'That summary is out of date',
    detail: 'Your check-up changed since the summary was made. Have a look at the new one before sending it.',
    canRetry: true
  },
  error: {
    title: 'Something went wrong while asking for help',
    detail: 'Nothing on your PC was changed. You can try again in a little while.',
    canRetry: true
  }
}

export const KEY_STATUS_WORDS: Record<KeyStatus, string> = {
  set: 'A key is stored on this PC.',
  'not-set': 'No key is stored on this PC.',
  'encryption-unavailable': "This PC can't store a key safely, so no key is stored."
}
