// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import { createFixtureHost } from '../locate/fixture-host.ts'
import { locate } from '../locate/index.ts'
import { parseBetterExceptions, parseGameLog, parseMccc, readLogs } from './index.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const SPECS_DIR = join(THIS_DIR, '../../../scripts/fixtures/specs')

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()
  async function walk(dir: string, rel: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name)
      const relPath = rel === '' ? name : `${rel}/${name}`
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        snapshot.set(relPath, `link ${await readlink(full)}`)
      } else if (info.isDirectory()) {
        snapshot.set(relPath, `dir ${info.mtimeMs}`)
        await walk(full, relPath)
      } else {
        const hash = createHash('sha256')
          .update(await readFile(full))
          .digest('hex')
        snapshot.set(relPath, `file ${info.size} ${info.mtimeMs} ${hash}`)
      }
    }
  }
  await walk(root, '')
  return snapshot
}

describe('log parsers and readLogs', () => {
  let workDir: string
  let exceptionsRoot: string
  let exceptionsSimsDir: string
  let cleanSimsDir: string

  beforeAll(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-logs-test-')))
    exceptionsRoot = join(workDir, 'exceptions')
    const cleanRoot = join(workDir, 'clean')

    await generateFixture(await loadSpec(join(SPECS_DIR, 'exceptions.json')), exceptionsRoot)
    await generateFixture(await loadSpec(join(SPECS_DIR, 'clean.json')), cleanRoot)

    const locatedExceptions = await locate(createFixtureHost(exceptionsRoot))
    expect(locatedExceptions.userFolders.length).toBeGreaterThan(0)
    exceptionsSimsDir = locatedExceptions.userFolders[0]!.path

    const locatedClean = await locate(createFixtureHost(cleanRoot))
    expect(locatedClean.userFolders.length).toBeGreaterThan(0)
    cleanSimsDir = locatedClean.userFolders[0]!.path
  })

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  describe('fixture formats', () => {
    it('parses lastException_63887256771.txt: groups duplicate categoryId, all game frames, no modHints', async () => {
      const file = 'lastException_63887256771.txt'
      const text = await readFile(join(exceptionsSimsDir, file), 'utf8')
      const mtime = '2026-11-20T19:42:07.000Z'

      const reports = parseGameLog(text, file, mtime)
      expect(reports).toHaveLength(1)

      const report = reports[0]!
      expect(report.file).toBe(file)
      expect(report.kind).toBe('exception')
      expect(report.fileModifiedAt).toBe(mtime)
      expect(report.createdLocal).toBe('2026-11-20 19:42:07')
      expect(report.gameVersion).toBe('1.129.39.1030')
      expect(report.categoryId).toBe('tunable.py:2138')
      expect(report.count).toBe(2)
      expect(report.completeness).toBe('complete')
      expect(report.message).toContain('[maxisdev] Caught exception loading reference.')
      expect(report.frames).toEqual([
        {
          path: 'T:\\InGame\\Gameplay\\Scripts\\Core\\sims4\\tuning\\instance_manager.py',
          line: 433,
          origin: 'game'
        },
        {
          path: 'T:\\InGame\\Gameplay\\Scripts\\Core\\sims4\\tuning\\tunable.py',
          line: 2138,
          origin: 'game'
        }
      ])
      expect(report.modHints).toEqual([])
    })

    it('parses lastException_63887259912.txt: extracts mod frame and normalized modHints', async () => {
      const file = 'lastException_63887259912.txt'
      const text = await readFile(join(exceptionsSimsDir, file), 'utf8')
      const mtime = '2026-11-20T19:51:12.000Z'

      const reports = parseGameLog(text, file, mtime)
      expect(reports).toHaveLength(1)

      const report = reports[0]!
      expect(report.kind).toBe('exception')
      expect(report.categoryId).toBe('outfit_picker.py:142')
      expect(report.gameVersion).toBe('1.129.39.1030')
      expect(report.count).toBe(1)
      expect(report.completeness).toBe('complete')
      expect(report.frames).toEqual([
        { path: 'T:\\InGame\\Gameplay\\Scripts\\Server\\scheduling.py', line: 219, origin: 'game' },
        { path: 'T:\\InGame\\Gameplay\\Scripts\\Server\\elements.py', line: 376, origin: 'game' },
        { path: 'C:\\Users\\ModAuthor\\Projects\\wicked_wardrobe\\outfit_picker.py', line: 142, origin: 'mod' }
      ])
      expect(report.modHints).toEqual(['c:/users/modauthor/projects/wicked_wardrobe/outfit_picker'])
    })

    it('parses cut-off lastException_63887260105.txt: keeps categoryId and marks cut-off', async () => {
      const file = 'lastException_63887260105.txt'
      const text = await readFile(join(exceptionsSimsDir, file), 'utf8')
      const mtime = '2026-11-20T19:55:00.000Z'

      const reports = parseGameLog(text, file, mtime)
      expect(reports).toHaveLength(1)

      const report = reports[0]!
      expect(report.kind).toBe('exception')
      expect(report.categoryId).toBe('zone.py:890')
      expect(report.gameVersion).toBe('1.129.39.1030')
      expect(report.createdLocal).toBe('2026-11-20 19:55:00')
      expect(report.completeness).toBe('cut-off')
      expect(report.message).toContain('Exception during zone spin up before hard exit')
    })

    it('parses lastUIException.txt: kind uiException, ActionScript frames with null lines, no modHints', async () => {
      const file = 'lastUIException.txt'
      const text = await readFile(join(exceptionsSimsDir, file), 'utf8')
      const mtime = '2026-11-20T19:48:30.000Z'

      const reports = parseGameLog(text, file, mtime)
      expect(reports).toHaveLength(1)

      const report = reports[0]!
      expect(report.kind).toBe('uiException')
      expect(report.gameVersion).toBe('1.129.39.1030')
      expect(report.categoryId).toBe('(AS)widgets.Example::ExampleWidget/onUpdate')
      expect(report.message).toBe('TypeError: Error #1009: Cannot access a property or method of a null object reference.')
      // ActionScript lists the innermost call first; frames are innermost last, as for Python.
      expect(report.frames).toEqual([
        { path: 'olympus.controls::GUIComponent/validateNow', line: null, origin: 'game' },
        { path: 'widgets.Example::ExampleWidget/onUpdate', line: null, origin: 'game' }
      ])
      expect(report.modHints).toEqual([])
      expect(report.completeness).toBe('complete')
    })

    it('parses lastCrash.txt: kind crash, version and time only, no frames and no modHints', async () => {
      const file = 'lastCrash.txt'
      const text = await readFile(join(exceptionsSimsDir, file), 'utf8')
      const mtime = '2026-11-20T19:58:51.000Z'

      const reports = parseGameLog(text, file, mtime)
      expect(reports).toHaveLength(1)

      const report = reports[0]!
      expect(report.kind).toBe('crash')
      expect(report.gameVersion).toBe('1.129.39.1030')
      expect(report.createdLocal).toBe('2026-11-20 19:58:51')
      expect(report.frames).toEqual([])
      expect(report.modHints).toEqual([])
      expect(report.message).toBeNull()
      expect(report.completeness).toBe('complete')
    })

    it('parses BE-ExceptionReport.html from beRawLEData only and sets kind betterExceptions', async () => {
      const file = 'BE-ExceptionReport.html'
      const html = await readFile(join(exceptionsSimsDir, file), 'utf8')
      const mtime = '2026-11-20T19:51:15.000Z'

      const reports = parseBetterExceptions(html, file, mtime)
      expect(reports).toHaveLength(1)

      const report = reports[0]!
      expect(report.file).toBe(file)
      expect(report.kind).toBe('betterExceptions')
      expect(report.gameVersion).toBe('1.129.39.1030')
      expect(report.categoryId).toBe('outfit_picker.py:142')
      expect(report.frames).toEqual([
        { path: 'T:\\InGame\\Gameplay\\Scripts\\Server\\scheduling.py', line: 219, origin: 'game' },
        { path: 'C:\\Users\\ModAuthor\\Projects\\wicked_wardrobe\\outfit_picker.py', line: 142, origin: 'mod' }
      ])
      expect(report.modHints).toEqual(['c:/users/modauthor/projects/wicked_wardrobe/outfit_picker'])
      expect(report.completeness).toBe('complete')

      // Without beRawLEData, Possible Cause is ignored and [] is returned.
      const withoutRaw = html.replace(/<div id="beRawLEData"[\s\S]*?<\/div>/, '')
      expect(parseBetterExceptions(withoutRaw, file, mtime)).toEqual([])
    })

    it('parses Mods/MCCC/mc_lastexception.html after decoding HTML entities', async () => {
      const file = 'Mods/MCCC/mc_lastexception.html'
      const html = await readFile(join(exceptionsSimsDir, file), 'utf8')
      const mtime = '2026-11-20T19:51:18.000Z'

      const reports = parseMccc(html, file, mtime)
      expect(reports).toHaveLength(1)

      const report = reports[0]!
      expect(report.file).toBe(file)
      expect(report.kind).toBe('mccc')
      expect(report.categoryId).toBeNull()
      expect(report.gameVersion).toBe('1.129.39.1030')
      expect(report.createdLocal).toBe('2026-11-20 19:51:12')
      expect(report.message).toBe("AttributeError: 'SimInfo' object has no attribute 'get_current_outfit_tag'")
      expect(report.frames).toEqual([
        { path: 'T:\\InGame\\Gameplay\\Scripts\\Server\\scheduling.py', line: 219, origin: 'game' },
        { path: 'C:\\Users\\ModAuthor\\Projects\\wicked_wardrobe\\outfit_picker.py', line: 142, origin: 'mod' }
      ])
      expect(report.modHints).toEqual(['c:/users/modauthor/projects/wicked_wardrobe/outfit_picker'])
      expect(report.completeness).toBe('complete')
    })
  })

  describe('entity decoding, limits and normalization', () => {
    it('decodes decimal/hex numeric entities and named entities without double-decoding', () => {
      const xml = [
        '<?xml version="1.0" ?><root><report>',
        '<type>desync</type>',
        '<createtime>2026-11-21 10:00:00</createtime>',
        '<buildsignature>Local.Unknown.Unknown.1.129.39.1030-1.200.000.999.Release</buildsignature>',
        '<categoryid>foo.py:10</categoryid>',
        '<desyncdata>Error in &lt;module&gt; &amp; &apos;init&apos; (&quot;bad&quot; &amp;lt;literal&amp;gt;)&#13;&#10;',
        '  File &#x22;C:\\Mods\\Alpha\\bar.pyc&#x22;, line 10, in &lt;module&gt;&#x0D;&#x0A;',
        '  File "C:\\Mods\\Alpha\\baz.pyo", line 12, in run&#13;&#10;',
        '  File "C:\\Mods\\Alpha\\bar.PY", line 99, in run_again</desyncdata>',
        '</report></root>'
      ].join('')

      const reports = parseGameLog(xml, 'lastException.txt', '2026-11-21T10:00:00.000Z')
      expect(reports).toHaveLength(1)

      const report = reports[0]!
      expect(report.message).toBe('Error in <module> & \'init\' ("bad" &lt;literal&gt;)')
      expect(report.frames).toHaveLength(3)
      expect(report.modHints).toEqual(['c:/mods/alpha/bar', 'c:/mods/alpha/baz'])
    })

    it('caps frames at 60 (keeping innermost) and message at 300 characters', () => {
      const longMessage = 'E'.repeat(450)
      const frameLines: string[] = []
      for (let i = 1; i <= 80; i += 1) {
        frameLines.push(`  File "T:\\InGame\\Gameplay\\Scripts\\frame_${i}.py", line ${i}, in fn_${i}`)
      }
      const xml = [
        '<report><type>desync</type><categoryid>frame_80.py:80</categoryid>',
        `<desyncdata>${longMessage}&#13;&#10;${frameLines.join('&#13;&#10;')}</desyncdata></report>`
      ].join('')

      const reports = parseGameLog(xml, 'lastException.txt', '2026-11-21T10:00:00.000Z')
      expect(reports).toHaveLength(1)
      expect(reports[0]!.message).toHaveLength(300)
      expect(reports[0]!.frames).toHaveLength(60)
      expect(reports[0]!.frames[0]!.line).toBe(21)
      expect(reports[0]!.frames[59]!.line).toBe(80)
    })

    it('never names a mod from a crash log even if unexpected traceback text is present', () => {
      const xml = [
        '<report><type>crash</type>',
        '<createtime>2026-11-21 11:00:00</createtime>',
        '<buildsignature>Local.Unknown.Unknown.1.129.39.1030-1.200.000.999.Release</buildsignature>',
        '<desyncdata>  File "C:\\Mods\\sus\\mod.py", line 1, in boom</desyncdata></report>'
      ].join('')

      const reports = parseGameLog(xml, 'lastCrash.txt', '2026-11-21T11:00:00.000Z')
      expect(reports).toHaveLength(1)
      expect(reports[0]!.kind).toBe('crash')
      expect(reports[0]!.frames).toEqual([])
      expect(reports[0]!.modHints).toEqual([])
      expect(reports[0]!.message).toBeNull()
    })
  })

  describe('defensive parsing and ReDoS bounds', () => {
    it('never throws on empty input, 1 MB of random bytes, or a lone <report>', () => {
      const mtime = '2026-11-21T12:00:00.000Z'

      // Empty
      expect(parseGameLog('', 'lastException.txt', mtime)).toEqual([])
      expect(parseBetterExceptions('', 'BE-ExceptionReport.html', mtime)).toEqual([])
      expect(parseMccc('', 'Mods/MCCC/mc_lastexception.html', mtime)).toEqual([])

      // 1 MB of deterministic pseudo-random bytes decoded as utf8
      const randomBytes = Buffer.allocUnsafe(1024 * 1024)
      let state = 0x12345678
      for (let i = 0; i < randomBytes.length; i += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        randomBytes[i] = state & 0xff
      }
      const randomText = randomBytes.toString('utf8')
      expect(() => parseGameLog(randomText, 'lastException.txt', mtime)).not.toThrow()
      expect(() => parseBetterExceptions(randomText, 'BE-ExceptionReport.html', mtime)).not.toThrow()
      expect(() => parseMccc(randomText, 'Mods/MCCC/mc_lastexception.html', mtime)).not.toThrow()

      // Only <report>
      const onlyReport = parseGameLog('<report>', 'lastException.txt', mtime)
      expect(onlyReport).toHaveLength(1)
      expect(onlyReport[0]!.completeness).toBe('cut-off')
      expect(onlyReport[0]!.categoryId).toBeNull()
      expect(onlyReport[0]!.frames).toEqual([])
      expect(onlyReport[0]!.modHints).toEqual([])
    })

    it('parses 8 MB of < characters in under 2 seconds across all parsers', () => {
      const eightMb = '<'.repeat(8 * 1024 * 1024)
      const mtime = '2026-11-21T12:00:00.000Z'

      const start = performance.now()
      expect(parseGameLog(eightMb, 'lastException.txt', mtime)).toEqual([])
      expect(parseBetterExceptions(eightMb, 'BE-ExceptionReport.html', mtime)).toEqual([])
      expect(parseMccc(eightMb, 'Mods/MCCC/mc_lastexception.html', mtime)).toEqual([])
      const elapsedMs = performance.now() - start

      expect(elapsedMs).toBeLessThan(2000)
    })

    it('handles BE single-quoted/reordered attributes and MCCC inline/br/style tags cleanly', () => {
      const mtime = '2026-11-21T12:00:00.000Z'
      const beHtml = [
        '<DIV style="display:none" id=\'beRawLEData\'>',
        '&lt;report&gt;&lt;type&gt;desync&lt;/type&gt;&lt;categoryid&gt;x.py:7&lt;/categoryid&gt;',
        '&lt;buildsignature&gt;Local.Unknown.Unknown.1.129.39.1030-1.0&lt;/buildsignature&gt;',
        '&lt;desyncdata&gt;Boom&amp;#13;&amp;#10;  File &quot;D:\\Mod\\x.py&quot;, line 7, in f&lt;/desyncdata&gt;&lt;/report&gt;',
        '</DIV>'
      ].join('')
      const beReports = parseBetterExceptions(beHtml, 'BE-ExceptionReport-OLD.html', mtime)
      expect(beReports).toHaveLength(1)
      expect(beReports[0]!.kind).toBe('betterExceptions')
      expect(beReports[0]!.modHints).toEqual(['d:/mod/x'])

      const mcccHtml = [
        '<style>body { color: red; }</style>',
        '<p><b>Game Version:</b> 1.129.39.1030</p>',
        '<div><span>File </span><span>&quot;D:\\Mod\\y.pyo&quot;, line 4, in g</span><br/>KeyError: missing</div>'
      ].join('')
      const mcccReports = parseMccc(mcccHtml, 'Mods/mc_lastexception.html', mtime)
      expect(mcccReports).toHaveLength(1)
      expect(mcccReports[0]!.gameVersion).toBe('1.129.39.1030')
      expect(mcccReports[0]!.modHints).toEqual(['d:/mod/y'])
      expect(mcccReports[0]!.message).toBe('KeyError: missing')
    })
  })

  describe('review fixes', () => {
    const mtime = '2026-11-24T12:00:00.000Z'
    const HOSTILE_BYTES = 8 * 1024 * 1024

    function timed(run: () => unknown): number {
      const start = performance.now()
      run()
      return performance.now() - start
    }

    it('collects modHints from every frame before capping frames at 60', () => {
      const lines = ['  File "C:\\Users\\Author\\injector\\hooks.py", line 5, in wrapper']
      for (let i = 2; i <= 100; i += 1) {
        lines.push(`  File "T:\\InGame\\Gameplay\\Scripts\\Server\\frame_${i}.py", line ${i}, in fn`)
      }
      const xml = `<report><type>desync</type><categoryid>frame_100.py:100</categoryid><desyncdata>Boom&#13;&#10;${lines.join('&#13;&#10;')}</desyncdata></report>`

      const [report] = parseGameLog(xml, 'lastException.txt', mtime)
      expect(report!.frames).toHaveLength(60)
      expect(report!.frames.every((frame) => frame.origin === 'game')).toBe(true)
      expect(report!.modHints).toEqual(['c:/users/author/injector/hooks'])
    })

    it('treats <frozen ...> and <string> pseudo-files as game frames, never modHints', () => {
      const xml = [
        '<report><type>desync</type><categoryid>x.py:1</categoryid><desyncdata>Boom&#13;&#10;',
        '  File "&lt;frozen importlib._bootstrap&gt;", line 219, in _call_with_frames_removed&#13;&#10;',
        '  File "&lt;string&gt;", line 1, in &lt;module&gt;&#13;&#10;',
        '  File "T:\\InGame\\Gameplay\\Scripts\\Core\\x.py", line 1, in f</desyncdata></report>'
      ].join('')

      const [report] = parseGameLog(xml, 'lastException.txt', mtime)
      expect(report!.frames.map((frame) => frame.origin)).toEqual(['game', 'game', 'game'])
      expect(report!.modHints).toEqual([])
    })

    it('never names a mod from a lastCrash file, even without a <type> tag', () => {
      const xml =
        '<report><createtime>2026-11-24 11:00:00</createtime><desyncdata>  File "C:\\Mods\\sus\\mod.py", line 1, in boom</desyncdata></report>'

      for (const file of ['lastCrash.txt', 'LastCrash_63887260000.txt']) {
        const [report] = parseGameLog(xml, file, mtime)
        expect(report!.kind).toBe('crash')
        expect(report!.frames).toEqual([])
        expect(report!.modHints).toEqual([])
        expect(report!.message).toBeNull()
      }
    })

    it('keeps the 60 innermost UI frames, innermost last', () => {
      const atLines = Array.from({ length: 80 }, (_, i) => `\tat widgets.W${i + 1}::Fn()`)
      const xml = `<report><type>desync</type><desyncdata>TypeError: boom&#13;&#10;${atLines.join('&#13;&#10;')}</desyncdata></report>`

      const [report] = parseGameLog(xml, 'lastUIException.txt', mtime)
      expect(report!.frames).toHaveLength(60)
      expect(report!.frames[59]!.path).toBe('widgets.W1::Fn')
      expect(report!.frames[0]!.path).toBe('widgets.W60::Fn')
    })

    it('decodes each escaping layer exactly once in Better Exceptions and MCCC', () => {
      // Raw XML holds the literal text "&lt;b&gt;" (written &amp;lt;b&amp;gt;); BE escapes that XML once more.
      const be = `<div id="beRawLEData">&lt;report&gt;&lt;type&gt;desync&lt;/type&gt;&lt;desyncdata&gt;Bad &amp;amp;lt;b&amp;amp;gt; and &amp;lt;module&amp;gt;&lt;/desyncdata&gt;&lt;/report&gt;</div>`
      expect(parseBetterExceptions(be, 'BE-ExceptionReport.html', mtime)[0]!.message).toBe('Bad &lt;b&gt; and <module>')

      const mccc = '<p>KeyError: &amp;lt;b&amp;gt; in &lt;module&gt;</p>'
      expect(parseMccc(mccc, 'Mods/mc_lastexception.html', mtime)[0]!.message).toBe('KeyError: &lt;b&gt; in <module>')
    })

    it('stays linear on 8 MB inputs built to make searches rescan', () => {
      const reports = '<report>'.repeat(HOSTILE_BYTES / 8)
      const shapes: Array<[string, () => unknown]> = [
        ['many <report>', () => parseGameLog(reports, 'lastException.txt', mtime)],
        ['many <report>, one close', () => parseGameLog(`${reports}</report>`, 'lastException.txt', mtime)],
        ['many beRawLEData', () => parseBetterExceptions('beRawLEData'.repeat(HOSTILE_BYTES / 11), 'BE.html', mtime)],
        [
          'one div, many ids',
          () => parseBetterExceptions(`<div ${'beRawLEData '.repeat(HOSTILE_BYTES / 12)}>`, 'BE.html', mtime)
        ],
        [
          'buildsignature digits',
          () =>
            parseGameLog(`<report><buildsignature>${'1'.repeat(HOSTILE_BYTES)}</buildsignature></report>`, 'lastException.txt', mtime)
        ],
        ['MCCC Game Version digits', () => parseMccc(`Game Version: ${'1'.repeat(HOSTILE_BYTES)}`, 'mc.html', mtime)],
        [
          'UI at + spaces',
          () =>
            parseGameLog(`<report><desyncdata>at${' '.repeat(HOSTILE_BYTES)}x</desyncdata></report>`, 'lastUIException.txt', mtime)
        ]
      ]
      for (const [name, run] of shapes) {
        expect({ name, fast: timed(run) < 2000 }).toEqual({ name, fast: true })
      }
    }, 60_000)
  })

  describe('last check', () => {
    const mtime = '2026-11-24T12:00:00.000Z'

    // Outermost first, as Python prints them: one mod path far from the error and again next to it, 25 others between.
    function manyModFrames(): string[] {
      const lines = ['  File "C:\\Mods\\repeat\\r.py", line 1, in outer']
      for (let i = 1; i <= 25; i += 1) {
        lines.push(`  File "C:\\Mods\\m${i}\\a.py", line ${i}, in fn`)
        lines.push(`  File "T:\\InGame\\Gameplay\\Scripts\\Server\\g${i}.py", line ${i}, in fn`)
      }
      lines.push('  File "C:\\Mods\\repeat\\r.py", line 9, in inner')
      lines.push('  File "T:\\InGame\\Gameplay\\Scripts\\Server\\last.py", line 3, in boom')
      return lines
    }

    const nearestTwenty = ['c:/mods/repeat/r']
    for (let i = 25; i >= 7; i -= 1) nearestTwenty.push(`c:/mods/m${i}/a`)

    it('caps modHints at 20, keeping the frames closest to the error, nearest first', () => {
      const xml = `<report><type>desync</type><categoryid>last.py:3</categoryid><desyncdata>Boom&#13;&#10;${manyModFrames().join('&#13;&#10;')}</desyncdata></report>`
      const [report] = parseGameLog(xml, 'lastException.txt', mtime)
      expect(nearestTwenty).toHaveLength(20)
      expect(report!.modHints).toEqual(nearestTwenty)
      expect(report!.frames).toHaveLength(53)
    })

    it('applies the same cap to MCCC and Better Exceptions reports', () => {
      const mccc = `<pre>\r\n${manyModFrames().join('\r\n').replaceAll('"', '&quot;')}\r\nKeyError: x\r\n</pre>`
      expect(parseMccc(mccc, 'Mods/mc_lastexception.html', mtime)[0]!.modHints).toEqual(nearestTwenty)

      const inner = `<report><type>desync</type><desyncdata>Boom&#13;&#10;${manyModFrames().join('&#13;&#10;')}</desyncdata></report>`
      const be = `<div id="beRawLEData">${inner.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>`
      expect(parseBetterExceptions(be, 'BE-ExceptionReport.html', mtime)[0]!.modHints).toEqual(nearestTwenty)
    })

    it('never takes an MCCC createdLocal from the traceback or the error text', () => {
      const html = [
        '<p>Game Version: 1.129.39.1030</p>',
        '<pre>',
        'Traceback (most recent call last):',
        '  File &quot;C:\\Mods\\clock\\tick.py&quot;, line 4, in run',
        'ValueError: bad save stamp 2019-01-02 03:04:05',
        '</pre>'
      ].join('\r\n')
      const [report] = parseMccc(html, 'Mods/mc_lastexception.html', mtime)
      expect(report!.createdLocal).toBeNull()
      expect(report!.modHints).toEqual(['c:/mods/clock/tick'])
    })
  })

  describe('readLogs', () => {
    it('reads every log in the exceptions fixture ordered newest first', async () => {
      const reports = await readLogs({ folderPath: exceptionsSimsDir })
      expect(reports.map((r) => r.file)).toEqual([
        'lastCrash.txt',
        'lastException_63887260105.txt',
        'Mods/MCCC/mc_lastexception.html',
        'BE-ExceptionReport.html',
        'lastException_63887259912.txt',
        'lastUIException.txt',
        'lastException_63887256771.txt'
      ])
      expect(reports.map((r) => r.kind)).toEqual([
        'crash',
        'exception',
        'mccc',
        'betterExceptions',
        'exception',
        'uiException',
        'exception'
      ])
    })

    it('returns [] for the clean fixture and for a missing folder', async () => {
      expect(await readLogs({ folderPath: cleanSimsDir })).toEqual([])
      expect(await readLogs({ folderPath: join(workDir, 'does-not-exist') })).toEqual([])
    })

    it('matches case-insensitively, searches Mods up to 2 folders deep, caps reads at 8 MB, and skips unreadable files', async () => {
      const customDir = join(workDir, 'custom-sims')
      await mkdir(join(customDir, 'mods', 'Sub1', 'Sub2', 'Sub3'), { recursive: true })
      await mkdir(join(customDir, 'lastException_dir.txt'), { recursive: true })

      const leXml =
        '<report><type>desync</type><createtime>2026-11-22 01:00:00</createtime><buildsignature>1.129.39.1030</buildsignature><categoryid>a.py:1</categoryid><desyncdata>Err&#13;&#10;  File "C:\\mod\\a.py", line 1, in f</desyncdata></report>'
      const mcccHtml =
        '<html><body><p>Game Version: 1.129.39.1030</p><pre>  File &quot;C:\\mod\\deep.py&quot;, line 5, in g</pre></body></html>'

      const caseFile = join(customDir, 'LASTEXCEPTION_CASE.TXT')
      const depth0File = join(customDir, 'mods', 'mc_lastexception.html')
      const depth2File = join(customDir, 'mods', 'Sub1', 'Sub2', 'MC_LASTEXCEPTION.HTML')
      const depth3File = join(customDir, 'mods', 'Sub1', 'Sub2', 'Sub3', 'mc_lastexception.html')
      const oversizedFile = join(customDir, 'lastException_oversized.txt')
      const brokenLink = join(customDir, 'lastException_broken.txt')

      await writeFile(caseFile, leXml, 'utf8')
      await writeFile(depth0File, mcccHtml, 'utf8')
      await writeFile(depth2File, mcccHtml, 'utf8')
      await writeFile(depth3File, mcccHtml, 'utf8')

      // Over 8 MB file: valid report at start, padded beyond 8 MB so readLogs truncates it.
      const padding = ' '.repeat(8 * 1024 * 1024)
      await writeFile(oversizedFile, `${leXml}${padding}`, 'utf8')

      // Broken symlink (skip creation on platforms where symlinks require elevation).
      try {
        await symlink(join(customDir, 'missing-target.txt'), brokenLink)
      } catch {
        // Ignore EPERM on unprivileged Windows hosts.
      }

      // Set deterministic distinct mtimes.
      await utimes(oversizedFile, new Date('2026-11-22T04:00:00.000Z'), new Date('2026-11-22T04:00:00.000Z'))
      await utimes(depth2File, new Date('2026-11-22T03:00:00.000Z'), new Date('2026-11-22T03:00:00.000Z'))
      await utimes(depth0File, new Date('2026-11-22T02:00:00.000Z'), new Date('2026-11-22T02:00:00.000Z'))
      await utimes(caseFile, new Date('2026-11-22T01:00:00.000Z'), new Date('2026-11-22T01:00:00.000Z'))

      // On POSIX (non-root), also verify an unreadable file is skipped.
      const unreadableFile = join(customDir, 'lastCrash_unreadable.txt')
      await writeFile(unreadableFile, '<report><type>crash</type></report>', 'utf8')
      if (process.platform !== 'win32') {
        await chmod(unreadableFile, 0o000)
      }

      try {
        const reports = await readLogs({ folderPath: customDir })
        const files = reports.map((r) => r.file)

        expect(files).toContain('lastException_oversized.txt')
        expect(files).toContain('mods/Sub1/Sub2/MC_LASTEXCEPTION.HTML')
        expect(files).toContain('mods/mc_lastexception.html')
        expect(files).toContain('LASTEXCEPTION_CASE.TXT')
        expect(files).not.toContain('mods/Sub1/Sub2/Sub3/mc_lastexception.html')
        expect(files).not.toContain('lastException_broken.txt')
        expect(files).not.toContain('lastException_dir.txt')

        const oversized = reports.find((r) => r.file === 'lastException_oversized.txt')
        expect(oversized?.completeness).toBe('cut-off')
      } finally {
        if (process.platform !== 'win32') {
          await chmod(unreadableFile, 0o644)
        }
      }
    })

    it('is strictly read-only: tree snapshot before and after readLogs is identical', async () => {
      const before = await snapshotTree(exceptionsRoot)
      expect(before.size).toBeGreaterThan(20)

      const reports = await readLogs({ folderPath: exceptionsSimsDir })
      expect(reports).toHaveLength(7)

      expect(await snapshotTree(exceptionsRoot)).toEqual(before)
    })
  })
})
