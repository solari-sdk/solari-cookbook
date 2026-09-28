// SPDX-License-Identifier: AGPL-3.0-only
// The breadcrumb over the settings page: Settings, inert on every page since
// there is no page under it; the group, the one link on a computer's or a
// project's page, back to its list; and the page itself in the foreground ink
// at medium weight, as the thread crumb is. While the field holds text the
// page is Search. The left crumbs give way first when the line is short.
import { ProjectGlyph } from "../projects/look.js";
import { HERE_PLACE_ID } from "@wsp/protocol";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import { useStore } from "../protocol/store.js";
import { SETTINGS_WORDS } from "./format.js";
import { groupById } from "./groups.js";
import { placeName } from "./places.js";
import { useSettingsAt } from "./settingsContext.js";
import { groupOf, useSettingsStore } from "./settingsStore.js";

const Slash = () => (
  <span aria-hidden className="shrink-0 text-muted-foreground/50">
    /
  </span>
);

export function SettingsCrumbs() {
  const at = useSettingsAt();
  const search = useSettingsStore(s => s.search);
  const go = useSettingsStore(s => s.go);
  const places = useStore(s => s.places);
  const projects = useStore(s => s.projects);
  const isMobile = useIsMobile();
  const group = groupById(groupOf(at));
  const searching = search !== "" && !isMobile;
  const place = at.kind === "computer" ? places.find(p => p.id === at.id) : undefined;
  const project = at.kind === "project" ? projects.find(p => p.id === at.id) : undefined;
  const page = place !== undefined ? placeName(place, place.id === HERE_PLACE_ID) : project?.name;
  return (
    <>
      <span data-breadcrumb-settings className="min-w-0 truncate text-muted-foreground">
        {SETTINGS_WORDS.title}
      </span>
      <Slash />
      {searching ? (
        <span data-breadcrumb-page className="shrink-0 font-medium text-foreground">
          {SETTINGS_WORDS.searchPage}
        </span>
      ) : page === undefined ? (
        <span data-breadcrumb-group className="shrink-0 font-medium text-foreground">
          {group.name}
        </span>
      ) : (
        <>
          <button type="button" data-breadcrumb-group className="min-w-0 cursor-pointer truncate text-muted-foreground transition-colors duration-150 hover:text-foreground" onClick={() => go({ kind: "group", group: group.id })}>
            {group.name}
          </button>
          <Slash />
          <span data-breadcrumb-page className="flex min-w-0 max-w-[70%] shrink-0 items-center gap-2 font-medium text-foreground">
            {project !== undefined ? <ProjectGlyph projectId={project.id} /> : null}
            <span className="truncate">{page}</span>
          </span>
        </>
      )}
    </>
  );
}
