// SPDX-License-Identifier: AGPL-3.0-only
// The settings page in the centre: the open group's cards, or a computer's or
// a project's own page, in the grammar rows.tsx holds, one card per section.
// While the settings sidebar's field holds text at a width with room for
// both, the centre is a results page: under each group with a match, its name
// as a link and a card of the matching rows, live, so a pick made there is
// made. The Add a project sheet mounts at page level and stands over whichever
// page is open.
import { Fragment } from "react";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import { useStore } from "../protocol/store.js";
import { AddProjectDialog } from "../sidebar/AddProjectDialog.js";
import { ComputerPage } from "./computers.js";
import { GROUP_BLURBS, SETTINGS_WORDS } from "./format.js";
import { drawnGroups, groupById, searchGroup } from "./groups.js";
import { ProjectPage } from "./projects.js";
import { Card, cardDrops, Cards, Line, Row, ROW_CLASS } from "./rows.js";
import { useSettingsAt, useSettingsContext, type SettingsContext } from "./settingsContext.js";
import { useSettingsReads } from "./settingsReads.js";
import { atId, useSettingsStore, type SettingsAt } from "./settingsStore.js";

/** The results page: one card per group with a match, its name over it as the road to the whole group. */
function SearchPage({ ctx, query }: { ctx: SettingsContext; query: string }) {
  const found = drawnGroups()
    .map(group => ({ group, items: searchGroup(group, ctx, query) }))
    .filter(hit => hit.items.length > 0);
  if (found.length === 0) {
    return (
      <p data-k="nothing-matches" className={`${ROW_CLASS} flex items-center justify-center text-[13px] text-muted-foreground`}>
        {SETTINGS_WORDS.nothingMatches}
      </p>
    );
  }
  return (
    <>
      {found.map(({ group, items }) => {
        const drops = cardDrops(items);
        return (
          <Card
            key={group.id}
            id={`search-${group.id}`}
            head={
              <button type="button" data-k={`search-group-${group.id}`} className="text-left transition-colors duration-150 hover:text-foreground" onClick={() => ctx.go({ kind: "group", group: group.id })}>
                {group.name}
              </button>
            }
          >
            {items.map(item => {
              if (item.kind === "line") {
                const { kind: _line, ...line } = item;
                return <Line key={item.id} {...line} />;
              }
              const { kind: _row, ...row } = item;
              return <Row key={item.id} {...row} drops={drops} />;
            })}
          </Card>
        );
      })}
    </>
  );
}

function Page({ at, ctx }: { at: SettingsAt; ctx: SettingsContext }) {
  if (at.kind === "group") {
    const group = groupById(at.group);
    return (
      <>
        <header data-k="settings-page-head" className="flex flex-col gap-1.5 pb-2">
          <h1 className="text-lg font-medium tracking-tight">{group.name}</h1>
          <p className="text-[13px] text-muted-foreground">{GROUP_BLURBS[at.group]}</p>
        </header>
        <Cards cards={group.cards(ctx)} />
      </>
    );
  }
  if (at.kind === "computer") {
    const place = ctx.places.find(p => p.id === at.id);
    return place === undefined ? null : <ComputerPage place={place} ctx={ctx} />;
  }
  const project = ctx.projects.find(p => p.id === at.id);
  return project === undefined ? null : <ProjectPage project={project} ctx={ctx} />;
}

export function SettingsPage() {
  useSettingsReads();
  const ctx = useSettingsContext();
  const at = useSettingsAt();
  const search = useSettingsStore(s => s.search);
  const addProjectAt = useSettingsStore(s => s.addProjectAt);
  const closeAddProject = useSettingsStore(s => s.closeAddProject);
  const isMobile = useIsMobile();
  // At a phone's width the results are in the sheet the field is in, so the centre keeps its page.
  const searching = search !== "" && !isMobile;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div data-settings-page data-settings-at={searching ? "search" : atId(at)} className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-8 pt-14 pb-12 max-sm:px-4 max-sm:pt-6">
        {searching ? <SearchPage ctx={ctx} query={search} /> : <Page key={atId(at)} at={at} ctx={ctx} />}
      </div>
      {addProjectAt === null ? null : (
        <Fragment key={addProjectAt}>
          <AddProjectDialog onClose={closeAddProject} />
        </Fragment>
      )}
    </ScrollArea>
  );
}
