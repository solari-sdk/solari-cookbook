import type { QueryClient } from '@tanstack/react-query'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { lazy } from 'react'

import '../styles.css'

// Devtools load only in development, so they never ship to Candidates.
const Devtools = import.meta.env.DEV ? lazy(() => import('../components/Devtools')) : () => null

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootComponent,
  notFoundComponent: NotFound,
})

function RootComponent() {
  return (
    <>
      <Outlet />
      <Devtools />
    </>
  )
}

function NotFound() {
  return (
    <main className="mx-auto max-w-xl px-4 py-24">
      <h1 className="display text-2xl font-bold">This link does not lead anywhere</h1>
      <p className="mt-3 text-graphite">
        Check that you copied the whole link. If it still fails, ask the person who sent it for a new one.
      </p>
    </main>
  )
}
