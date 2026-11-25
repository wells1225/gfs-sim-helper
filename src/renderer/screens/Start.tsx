import { useEffect } from 'react'
import { useNav } from '../nav.tsx'

export function Start() {
  const { go } = useNav()

  useEffect(() => {
    go({ screen: 'about' })
  }, [go])

  return null
}
