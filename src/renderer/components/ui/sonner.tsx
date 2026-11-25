import type { CSSProperties } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

export function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: 'rounded-xl border border-border bg-card text-card-foreground shadow-md',
          description: 'text-sm text-muted-foreground',
          actionButton: 'rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground',
          cancelButton: 'rounded-md bg-secondary px-3 py-1.5 text-sm font-medium text-secondary-foreground'
        }
      }}
      style={
        {
          '--normal-bg': 'var(--card)',
          '--normal-text': 'var(--card-foreground)',
          '--normal-border': 'var(--border)'
        } as CSSProperties
      }
      {...props}
    />
  )
}
