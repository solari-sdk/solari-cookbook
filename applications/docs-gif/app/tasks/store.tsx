import * as React from "react"

import { type Task } from "./data/schema"

type Store = {
  tasks: Task[]
  deleted: Task[]
  add: (t: Omit<Task, "id">) => void
  update: (id: string, patch: Partial<Task>) => void
  updateMany: (ids: string[], patch: Partial<Task>) => void
  remove: (ids: string[]) => void
  duplicate: (id: string) => void
  undo: () => void
}

const Ctx = React.createContext<Store>(null!)
export const useTasks = () => React.useContext(Ctx)

export function TasksProvider({ initial, children }: { initial: Task[]; children: React.ReactNode }) {
  const [tasks, setTasks] = React.useState(initial)
  const [deleted, setDeleted] = React.useState<Task[]>([])
  const seq = React.useRef(9000)
  const newId = () => `TASK-${++seq.current}`

  const updateMany: Store["updateMany"] = (ids, patch) =>
    setTasks((ts) => ts.map((t) => (ids.includes(t.id) ? { ...t, ...patch } : t)))

  const store: Store = {
    tasks,
    deleted,
    add: (t) => setTasks((ts) => [{ ...t, id: newId() }, ...ts]),
    update: (id, patch) => updateMany([id], patch),
    updateMany,
    remove: (ids) => {
      setDeleted(tasks.filter((t) => ids.includes(t.id)))
      setTasks((ts) => ts.filter((t) => !ids.includes(t.id)))
    },
    duplicate: (id) =>
      setTasks((ts) => ts.flatMap((t) => (t.id === id ? [t, { ...t, id: newId() }] : [t]))),
    undo: () => {
      setTasks((ts) => [...deleted, ...ts])
      setDeleted([])
    },
  }
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}
