import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-severity-stop-border bg-severity-stop-bg text-severity-stop',
        outline: 'border-border bg-transparent text-foreground',
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

export type BadgeProps = ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
  }

export function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span'
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant, className }))} {...props} />
}
