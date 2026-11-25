import { Progress as ProgressPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Progress({ className, value, ...props }: ComponentProps<typeof ProgressPrimitive.Root>) {
  const clamped = typeof value === 'number' ? Math.max(0, Math.min(100, value)) : null
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={clamped}
      className={cn('relative h-2.5 w-full overflow-hidden rounded-full bg-secondary', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          'h-full w-full flex-1 rounded-full bg-primary transition-transform duration-150',
          clamped === null && 'animate-pulse opacity-65'
        )}
        style={{ transform: clamped === null ? 'translateX(-40%)' : `translateX(-${100 - clamped}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}
