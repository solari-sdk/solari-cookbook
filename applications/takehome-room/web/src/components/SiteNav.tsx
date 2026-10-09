import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { demoQuery } from '../api'

const REPO = 'https://github.com/nitan-jana/takehome-room'

const item = 'underline-offset-4 hover:text-ink hover:underline'

/**
 * The bar on the home page and the Reviewer page. The Candidate's pages and the
 * Report have none: a Candidate must not wander off mid-interview, and a Report
 * is a page on its own that gets passed around.
 */
export function SiteNav() {
  const demo = useQuery(demoQuery())
  return (
    <nav aria-label="Site" className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-rule pb-4">
      <Link to="/" className="font-mono text-xs font-semibold tracking-wide uppercase">
        takehome-room
      </Link>
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0 text-sm text-graphite">
        {demo.data?.enabled && (
          <li>
            <Link to="/" hash="demo" className={item}>
              Demo
            </Link>
          </li>
        )}
        <li>
          <Link to="/" hash="how-it-works" className={item}>
            How it works
          </Link>
        </li>
        <li>
          <Link to="/admin" className={item} activeProps={{ className: 'font-semibold text-ink' }}>
            Reviewer
          </Link>
        </li>
        <li>
          <a href={REPO} target="_blank" rel="noreferrer" className={item}>
            GitHub
          </a>
        </li>
      </ul>
    </nav>
  )
}
