import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** Soft rounded house silhouette cradling a 4-point sparkle (never a diamond or gem). */
export function Emblem({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn('size-8 shrink-0 text-primary', className)}
      {...props}
    >
      <rect width="64" height="64" rx="16" className="fill-accent" />
      <path
        d="M14 31.5L30.2 17.6C31.2 16.7 32.8 16.7 33.8 17.6L50 31.5"
        stroke="currentColor"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 29V45.5C20 47.4 21.6 49 23.5 49H40.5C42.4 49 44 47.4 44 45.5V29"
        stroke="currentColor"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M32 29.5C32.4 33.6 33.4 34.6 37.5 35C33.4 35.4 32.4 36.4 32 40.5C31.6 36.4 30.6 35.4 26.5 35C30.6 34.6 31.6 33.6 32 29.5Z"
        fill="currentColor"
      />
    </svg>
  )
}
