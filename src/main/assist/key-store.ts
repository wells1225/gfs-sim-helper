import type { KeyStatus } from '../../shared/model.ts'
import type { AssistMessage, AssistReply, KeyStoreDeps } from '../ports.ts'

export async function keyStatus(_deps: KeyStoreDeps): Promise<KeyStatus> {
  throw new Error('not implemented: keyStatus')
}

export async function setKey(_deps: KeyStoreDeps, _key: string): Promise<KeyStatus> {
  throw new Error('not implemented: setKey')
}

export async function clearKey(_deps: KeyStoreDeps): Promise<KeyStatus> {
  throw new Error('not implemented: clearKey')
}

export async function sendWithKey(_deps: KeyStoreDeps, _message: AssistMessage): Promise<AssistReply> {
  throw new Error('not implemented: sendWithKey')
}
