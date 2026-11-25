import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const alertVariants = cva(
  'relative flex w-full flex-col gap-1 rounded-xl border px-4 py-3 text-[0.9375rem] [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-foreground',
        destructive: 'border-severity-stop-border bg-severity-stop-bg text-severity-stop',
        warn: 'border-severity-warn-border bg-severity-warn-bg text-severity-warn',
        info: 'border-severity-info-border bg-severity-info-bg text-severity-info',
        ok: 'border-severity-ok-border bg-severity-ok-bg text-severity-ok'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

export function Alert({ className, variant, ...props }: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant, className }))} {...props} />
}

export function AlertTitle({ className, ...props }: ComponentProps<'h4'>) {
  return <h4 data-slot="alert-title" className={cn('font-semibold leading-snug', className)} {...props} />
}

export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('text-sm leading-relaxed opacity-95', className)} {...props} />
}
