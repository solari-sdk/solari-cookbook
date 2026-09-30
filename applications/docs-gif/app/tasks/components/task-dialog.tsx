import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { labels, priorities, statuses } from "../data/data"
import { type Task } from "../data/schema"
import { useTasks } from "../store"

const blank = { title: "New task", status: "todo", label: "feature", priority: "medium" }
type Draft = typeof blank

// Add (no task) and Edit (task) share this form. Mount it only while open so the draft resets.
export function TaskDialog({ task, onClose }: { task?: Task; onClose: () => void }) {
  const { add, update } = useTasks()
  const [draft, setDraft] = React.useState<Draft>({ ...blank, ...task })
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }))

  const field = (name: keyof Draft, label: string, options: { value: string; label: string }[]) => (
    <label className="grid gap-1.5 text-sm font-medium">
      {label}
      <Select value={draft[name]} onValueChange={set(name)}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{task ? `Edit ${task.id}` : "Add task"}</DialogTitle>
          <DialogDescription>
            {task ? "Change the fields and save." : "Fill in the fields and create the task."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-sm font-medium">
            Title
            <Input value={draft.title} onChange={(e) => set("title")(e.target.value)} />
          </label>
          {field("status", "Status", statuses)}
          {field("priority", "Priority", priorities)}
          {field("label", "Label", labels)}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={() => {
              task ? update(task.id, draft) : add(draft)
              onClose()
            }}
          >
            {task ? "Save changes" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
