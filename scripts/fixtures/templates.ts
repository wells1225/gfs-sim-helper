import type {
  BetterExceptionsFileSpec,
  CurseForgeSpec,
  LastCrashFileSpec,
  LastExceptionFileSpec,
  LastExceptionReportSpec,
  LastUiExceptionFileSpec,
  McccExceptionFileSpec,
  OptionsIniSpec
} from './spec-types.ts'

const CRLF = '\r\n'

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeHtml(text: string): string {
  return escapeXml(text).replaceAll('"', '&quot;')
}

export function renderOptionsIni(opts: OptionsIniSpec): string {
  const showStartup = opts.showmodliststartup ?? 1
  return [
    '[options]',
    'fullscreen=1',
    'resolutionwidth=1920',
    'resolutionheight=1080',
    `modsdisabled=${opts.modsdisabled}`,
    `scriptmodsenabled=${opts.scriptmodsenabled}`,
    `showmodliststartup=${showStartup}`,
    ''
  ].join(CRLF)
}

export function renderResourceCfg(maxDepth = 5): string {
  const lines = ['Priority 500', 'PackedFile *.package']
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const pattern = `${'*/'.repeat(depth)}*.package`
    lines.push(`PackedFile ${pattern}`)
  }
  lines.push('')
  return lines.join(CRLF)
}

export function renderGameVersion(version: string): string {
  return `${version}${CRLF}`
}

/**
 * INFERRED AND UNVERIFIED: the research (section 5) says only that GameVersion.txt "may not be
 * plain text only". This layout (a 4-byte little-endian length, then the version, no line end)
 * is a stand-in for "bytes around the version", not a claim about the real file. Readers must
 * find the version with a pattern, never by trimming the whole file.
 */
export function renderGameVersionWithBinaryPrefix(version: string): Buffer {
  const text = Buffer.from(version, 'ascii')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(text.length, 0)
  return Buffer.concat([prefix, text])
}

export function renderConfigLog(version: string): string {
  return [
    '=== Application info ===',
    'Name:            Sims4',
    `Version:         ${version}`,
    'Build:           Release',
    '=== Machine info ===',
    'OS version:      Windows 11 (10.0.26100)',
    'CPU:             Fixture x64',
    ''
  ].join(CRLF)
}

function renderReportInner(report: LastExceptionReportSpec): string {
  const sku = report.sku ?? 'ea.maxis.sims4_64.15.pc'
  const desyncLines = [
    report.message,
    'Traceback (most recent call last):',
    ...report.tracebackLines,
    ...(report.footerLines ?? ['rtim=0', "ClientInfo isn't here"])
  ]
  const encodedDesync = desyncLines.map(escapeXml).join('&#13;&#10;')

  return [
    '<report>',
    '<version>2</version>',
    `<sessionid>${escapeXml(report.sessionId)}</sessionid>`,
    '<type>desync</type>',
    `<sku>${escapeXml(sku)}</sku>`,
    `<createtime>${escapeXml(report.createTime)}</createtime>`,
    `<buildsignature>${escapeXml(report.buildSignature)}</buildsignature>`,
    `<categoryid>${escapeXml(report.categoryId)}</categoryid>`,
    `<desyncid>${escapeXml(report.sessionId)}</desyncid>`,
    '<systemconfig/><screenshot/>',
    `<desyncdata>${encodedDesync}</desyncdata>`,
    '</report>'
  ].join('')
}

export function renderLastException(spec: LastExceptionFileSpec): string {
  const reportsXml = spec.reports.map(renderReportInner).join(CRLF)
  const full = `<?xml version="1.0" ?><root>${CRLF}${reportsXml}${CRLF}</root>${CRLF}`
  if (!spec.truncated) {
    return full
  }
  // Cut off mid-last-report so XML is malformed and requires regex fallback.
  const cutIndex = Math.max(40, Math.floor(full.length * 0.65))
  return full.slice(0, cutIndex)
}

export function renderLastUiException(spec: LastUiExceptionFileSpec): string {
  const encodedDesync = escapeXml(spec.errorText).replaceAll('\n', '&#13;&#10;')
  return [
    '<?xml version="1.0" ?><root>',
    [
      '<report>',
      '<version>2</version>',
      `<sessionid>${escapeXml(spec.sessionId)}</sessionid>`,
      '<type>desync</type>',
      '<sku>ea.maxis.sims4_64.15.pc</sku>',
      `<createtime>${escapeXml(spec.createTime)}</createtime>`,
      `<buildsignature>${escapeXml(spec.buildSignature)}</buildsignature>`,
      `<categoryid>${escapeXml(spec.categoryId)}</categoryid>`,
      `<desyncid>${escapeXml(spec.sessionId)}</desyncid>`,
      '<systemconfig/><screenshot/>',
      `<desyncdata>${encodedDesync}</desyncdata>`,
      '</report>'
    ].join(''),
    '</root>',
    ''
  ].join(CRLF)
}

export function renderLastCrash(spec: LastCrashFileSpec): string {
  const stack = spec.stack ?? spec.categoryId
  // Real lastCrash.txt is a single line whose root is <report> (no <root> wrapper).
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<report>',
    '<version>2</version>',
    `<sessionid>${escapeXml(spec.sessionId)}</sessionid>`,
    '<type>crash</type>',
    '<sku>ea.maxis.sims4_64.15.pc</sku>',
    `<createtime>${escapeXml(spec.createTime)}</createtime>`,
    `<buildsignature>${escapeXml(spec.buildSignature)}</buildsignature>`,
    '<systemconfig></systemconfig>',
    `<categoryid> ${escapeXml(spec.categoryId)}</categoryid>`,
    `<stack> ${escapeXml(stack)}</stack>`,
    '<threads></threads>',
    '<screenshot></screenshot>',
    '<memdump>FIXTUREMEMDUMP0000000000000000</memdump>',
    '<contextdata>Current Game State: 0x9b8c93c0<br /></contextdata>',
    '</report>'
  ].join('')
}

export function renderBetterExceptionsHtml(spec: BetterExceptionsFileSpec): string {
  const rawXml = `<?xml version="1.0" ?><root>${renderReportInner(spec.rawReport)}</root>`
  const escapedRawXml = escapeHtml(rawXml)
  const debugMods = spec.modList.join('|')

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <title>Better Exceptions Report</title>',
    '</head>',
    '<body>',
    '  <h1>Better Exceptions v3.17</h1>',
    '  <section id="exceptionSummary">',
    `    <p>Exception Date: ${escapeHtml(spec.createTime)}</p>`,
    `    <p>Game Version: ${escapeHtml(spec.buildSignature)}</p>`,
    `    <p>Category ID: ${escapeHtml(spec.categoryId)}</p>`,
    `    <p>Possible Cause (Confidence: ${spec.confidence}%): ${escapeHtml(spec.possibleCause)}</p>`,
    `    <p>Recommended Action: ${escapeHtml(spec.recommendedAction)}</p>`,
    '  </section>',
    `  <div id="beRawLEData" style="display:none;">${escapedRawXml}</div>`,
    `  <div id="beDebugData" style="display:none;">${escapeHtml(debugMods)}</div>`,
    '</body>',
    '</html>',
    ''
  ].join(CRLF)
}

export function renderMcccLastExceptionHtml(spec: McccExceptionFileSpec): string {
  const lines = spec.tracebackLines.map(escapeHtml).join(CRLF)
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <title>MC Command Center Last Exception</title>',
    '</head>',
    '<body>',
    `  <h2>MC Command Center Last Exception (${escapeHtml(spec.createTime)})</h2>`,
    `  <p>Game Version: ${escapeHtml(spec.gameVersion)}</p>`,
    '  <pre>',
    'Traceback (most recent call last):',
    lines,
    '  </pre>',
    '</body>',
    '</html>',
    ''
  ].join(CRLF)
}

export function renderCurseForgeAddonGameInstance(spec: CurseForgeSpec): string {
  const payload = [
    {
      _comment:
        'INFERRED AND UNVERIFIED: schema inferred from CurseForge addon-game agent metadata (see docs/research/neon-curseforge-tools-stack.md section 1); verify against a real Sims 4 CurseForge install at Gate G1.',
      gameInstanceGuid: spec.gameInstanceGuid,
      gameID: 78062,
      installPath: spec.installPath,
      installedAddons: spec.installedAddons.map((addon) => ({
        addonID: addon.addonID,
        gameID: 78062,
        installed: true,
        installedFile: {
          id: addon.fileId,
          displayName: addon.displayName,
          fileNameOnDisk: addon.fileNameOnDisk,
          fileDate: addon.fileDate,
          releaseType: addon.releaseType,
          downloadUrl: addon.downloadUrl,
          modules: addon.modules
        }
      }))
    }
  ]
  return `${JSON.stringify(payload, null, 2)}\n`
}
