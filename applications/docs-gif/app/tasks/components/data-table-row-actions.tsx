"use client"

import * as React from "react"
import { type Row, type RowData } from "@tanstack/react-table"
import { MoreHorizontal } from "lucide-react"

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { labels } from "../data/data"
import { taskSchema } from "../data/schema"
import { useTasks } from "../store"
import { type TasksTableFeatures } from "./data-table-features"
import { TaskDialog } from "./task-dialog"

interface DataTableRowActionsProps<TData extends RowData> {
  row: Row<TasksTableFeatures, TData>
}

export function DataTableRowActions<TData extends RowData>({
  row,
}: DataTableRowActionsProps<TData>) {
  const task = taskSchema.parse(row.original)
  const { update, remove, duplicate } = useTasks()
  // Dialogs live outside the menu: the menu unmounts on close.
  const [editing, setEditing] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 data-[state=open]:bg-muted"
          >
            <MoreHorizontal />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[160px]">
          <DropdownMenuItem onSelect={() => setEditing(true)}>Edit</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => duplicate(task.id)}>Make a copy</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Labels</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={task.label}
                onValueChange={(label) => update(task.id, { label })}
              >
                {labels.map((label) => (
                  <DropdownMenuRadioItem key={label.value} value={label.value}>
                    {label.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            Delete
            <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing && <TaskDialog task={task} onClose={() => setEditing(false)} />}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {task.id}?</DialogTitle>
            <DialogDescription>
              The task is removed from the list. An Undo link appears above the table.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                remove([task.id])
                setConfirming(false)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
