/** PR 14 (unit C, Fable): the web addresses the app may open. Stubs until then. */

/** https only, no user or password, no port, a host name with a dot (no IP address), 300 characters at most. */
export function safeWebLink(_text: string): { url: string; host: string } | null {
  throw new Error('not implemented: safeWebLink')
}

/** https://www.curseforge.com/projects/<addonId>, built from a number. */
export function curseForgePage(_addonId: number): string {
  throw new Error('not implemented: curseForgePage')
}

/** 'usual' for curseforge.com, patreon.com, modthesims.info and their subdomains, else 'not-usual'. */
export function placeOf(_host: string): 'usual' | 'not-usual' {
  throw new Error('not implemented: placeOf')
}
