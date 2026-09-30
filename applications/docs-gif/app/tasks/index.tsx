import { BookOpen } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";

import { columns } from "./components/columns";
import { DataTable } from "./components/data-table";
import { taskSchema } from "./data/schema";
import tasksJson from "./data/tasks.json";
import { TasksProvider, useTasks } from "./store";
import { TweaksPanel } from "../tweaks";

// Bad seed data throws here instead of rendering half a table.
const tasks = z.array(taskSchema).parse(tasksJson);

export function TasksPage() {
  return (
    <TasksProvider initial={tasks}>
      <Tasks />
    </TasksProvider>
  );
}

// The recorder must always see the table, so don't hide it on small screens.
function Tasks() {
  const { tasks, deleted, undo } = useTasks();
  return (
    <div className="flex h-full flex-1 flex-col gap-8 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight">Welcome back!</h2>
          <p className="text-muted-foreground">
            Here&apos;s a list of your tasks for this month.
          </p>
        </div>
        {/* The docs navbar links back to :3000; keep the two in step. */}
        <Button asChild>
          <a href="http://localhost:3001">
            <BookOpen />
            Go to docs
          </a>
        </Button>
      </div>
      {deleted.length > 0 && (
        <div role="status" className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          Deleted {deleted.map((t) => t.id).join(", ")}.
          <Button variant="link" size="sm" className="h-auto p-0" onClick={undo}>
            Undo
          </Button>
        </div>
      )}
      <DataTable data={tasks} columns={columns} />
      <TweaksPanel />
    </div>
  );
}
