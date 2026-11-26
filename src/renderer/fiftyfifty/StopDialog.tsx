import { Button } from '../components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../components/ui/dialog.tsx'
import { STOP_CONFIRM, STOP_QUESTION } from './words.ts'

/** The one question the 50/50 test asks before it acts: stopping part way. */
export function StopDialog({
  open,
  onOpenChange,
  onConfirm,
  busy
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onConfirm(): void
  busy: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{STOP_QUESTION}</DialogTitle>
          <DialogDescription>
            Every mod the test set aside goes back into your Mods folder. You can start a new test later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep testing
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {STOP_CONFIRM}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
