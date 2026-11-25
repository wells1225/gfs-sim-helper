import type { IsoTime, LogReport } from '../../shared/model.ts'

export function parseGameLog(_text: string, _file: string, _fileModifiedAt: IsoTime): LogReport[] {
  throw new Error('not implemented: parseGameLog')
}

export function parseBetterExceptions(_html: string, _file: string, _fileModifiedAt: IsoTime): LogReport[] {
  throw new Error('not implemented: parseBetterExceptions')
}

export function parseMccc(_html: string, _file: string, _fileModifiedAt: IsoTime): LogReport[] {
  throw new Error('not implemented: parseMccc')
}

export async function readLogs(_input: { folderPath: string }): Promise<LogReport[]> {
  throw new Error('not implemented: readLogs')
}
