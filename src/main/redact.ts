function lookupEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const direct = env[key]
  if (typeof direct === 'string' && direct.trim() !== '') {
    return direct.trim()
  }
  const lower = key.toLowerCase()
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower && typeof v === 'string' && v.trim() !== '') {
      return v.trim()
    }
  }
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lastSegment(profilePath: string): string | undefined {
  const parts = profilePath.replace(/[\\/]+$/, '').split(/[\\/]/)
  const last = parts[parts.length - 1]?.trim()
  return last ? last : undefined
}

export function makeRedactor(env: Record<string, string | undefined>): (text: string) => string {
  const candidates: string[] = []
  const seen = new Set<string>()

  const add = (name: string | undefined): void => {
    if (!name) return
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(name)
  }

  add(lookupEnv(env, 'USERNAME'))
  const userProfile = lookupEnv(env, 'USERPROFILE')
  if (userProfile) {
    add(lastSegment(userProfile))
  }

  if (candidates.length === 0) {
    return (text: string) => text
  }

  candidates.sort((a, b) => b.length - a.length)
  const alternation = candidates.map(escapeRegExp).join('|')
  const pattern = new RegExp(
    `(?<=^|[\\\\/])(?:${alternation})(?=$|[\\\\/])|(?<=[\\\\/])(?:${alternation})(?=["'\\r\\n])`,
    'gi'
  )

  return (text: string) => text.replace(pattern, '<user>')
}
