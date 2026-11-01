import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"

// The settings forms are long, so the save bar stays pinned to the bottom of
// the viewport and Save is reachable from any field; Discard only appears
// once there are unsaved edits. It takes the card's fill so it blends into the
// Configuration page's panel while hiding the fields scrolling beneath it.
export function SaveBar(props: { dirty: boolean; onDiscard: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-card pt-4 pb-4">
      {props.children}
      {props.dirty && (
        <>
          <Button type="button" variant="ghost" onClick={props.onDiscard} disabled={props.disabled}>
            Discard
          </Button>
          <span className="text-sm text-muted-foreground">Unsaved changes</span>
        </>
      )}
    </div>
  )
}
