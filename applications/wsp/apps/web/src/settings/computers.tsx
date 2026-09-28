// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Computers: one row per computer this wsp runs on, this one
// first, each opening the computer's own page; and that page, which says what
// the host knows about the computer as lines, its connection and what a
// workspace there is made of as rows, the agents, skills and MCP servers on it,
// the workspaces standing on it, and the two things a person can do to it. Only facts the host carries are drawn; a fact
// not reported is left out rather than stood in for.
//
// The list draws every row the host's places list carries: the host lists a
// cloud only once it holds that cloud's key or a stand-in serves in its place,
// so nothing here filters again.
import { CloudIcon, CpuIcon, GaugeIcon, HardDriveIcon, LayersIcon, MemoryStickIcon, ReceiptIcon } from "lucide-react";
import type { ChipItem } from "../components/ui/chips.js";
import { useState } from "react";
import { HERE_PLACE_ID, fmtMemGb, absentRoad, awayMsOf, copyStanding, fmtBytes, fmtRate, fmtSize, isLocalWorkspace, lastKnown, offlineFor, plural, portsWord, spentThisMonth, workspaceStateOf, workspaceWord, type PlaceSpend, type PlaceView, type SealedImageView, type WorkspaceLanding, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { Button, DANGER_BUTTON } from "../components/ui/button.js";
import { AgentsManager } from "../components/agents/AgentsManager.js";
import { imageAgentsReport, recipeMissLines } from "../components/agents/agentsRows.js";
import { useAgentsReport } from "../components/agents/useAgentsReport.js";
import { useServerTools } from "../components/agents/useServerTools.js";
import { useAgentActs } from "../components/agents/useAgentActs.js";
import { useServerActs } from "../components/agents/useServerActs.js";
import { useSkillActs } from "../components/agents/useSkillActs.js";
import { useStore } from "../protocol/store.js";
import { DialButton, useDialPlace } from "./AbsentRoad.js";
import { ADD_COMPUTER_WORDS, WHERE_WORDS } from "./format.js";
import { AddComputer } from "./AddComputer.js";
import { ComputerGlyph, ComputerIconSelect } from "./ComputerGlyph.js";
import { builtWhen, copyOn, IMAGE_WORDS } from "./image.js";
import { useImageCard } from "./ImageCard.js";
import { openImageRecipe } from "./openAt.js";
import { APP_PLATFORM, NOTHING_HELD, THIS_COMPUTER_WORD, absenceOf, absentOf, copiesWord, isProviderPlace, placeCpuWord, placeName, placeOf, placeStateWord, placeWorkspaceCounts, projectOn, threadWord, type PlaceHolding } from "./places.js";
import { keyHeld } from "./providers.js";
import { RemoveComputerDialog } from "./RemoveComputerDialog.js";
import { RefusalSlot } from "./sheetParts.js";
import { Card, cardDrops, Cards, Row, type SettingsCardData, type SettingsItem, type SettingsRowData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import type { SettingsAt } from "./settingsStore.js";

/** What stands on each computer, folded from the workspaces the store already has, each workspace going to
 * exactly one computer by placeOf, the one reading of which computer a workspace stands on. */
export function holdingsFor(
  places: readonly PlaceView[],
  workspaces: readonly WorkspaceView[],
  threadsOf: (workspaceId: string) => number,
  statusOf: (workspaceId: string) => WorkspaceStatus | null = () => null,
): Record<string, PlaceHolding> {
  const held: Record<string, PlaceHolding> = {};
  places.forEach(place => {
    const mine = workspaces.filter(w => placeOf(places, w)?.id === place.id);
    held[place.id] = { workspaces: mine.map(w => ({ name: w.name, state: workspaceWord(workspaceStateOf(w, statusOf(w.id))), threads: threadsOf(w.id) })) };
  });
  return held;
}

/** The facts a computer's list row says under its name, each with its glyph, none of them where none has arrived. */
export function computerChips(place: PlaceView, count: number, spend: PlaceSpend | undefined): ChipItem[] {
  const workspaces: ChipItem | null = count === 0 ? null : { text: plural(count, "task"), icon: LayersIcon };
  if (isProviderPlace(place)) {
    const cloud: (ChipItem | null)[] = [
      { text: WHERE_WORDS.cloud, icon: CloudIcon },
      place.rateUsdPerHour === undefined ? null : { text: fmtRate(place.rateUsdPerHour), icon: GaugeIcon },
      workspaces,
      spend === undefined ? null : { text: spentThisMonth(spend.monthUsd), icon: ReceiptIcon },
    ];
    return cloud.filter((c): c is ChipItem => c !== null);
  }
  const own: (ChipItem | null)[] = [
    place.shape === undefined ? null : { text: `${place.shape.cpu} ${placeCpuWord(place)}`, icon: CpuIcon },
    place.shape === undefined ? null : { text: fmtMemGb(place.shape.memMb), icon: MemoryStickIcon },
    place.diskFreeBytes === undefined ? null : { text: `${fmtBytes(place.diskFreeBytes)} free`, icon: HardDriveIcon },
    workspaces,
  ];
  return own.filter((c): c is ChipItem => c !== null);
}

/** One computer's row: the name a person reads it as with the default mark, the facts it has reported, and the
 * state word while there is one, then the chevron where the row opens a page. */
export function computerRowData(place: PlaceView, o: { here: boolean; count: number; spend?: PlaceSpend | undefined; now: number; state?: string | undefined; open?: (() => void) | undefined }): SettingsRowData {
  const state = o.state ?? placeStateWord(place, absentOf(place, o.now, o.here));
  const chips = computerChips(place, o.count, o.spend);
  return {
    kind: "row",
    id: place.id,
    title: placeName(place, o.here),
    lead: (
      <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-foreground/[0.04]">
        <ComputerGlyph place={place} className="size-5 text-foreground/80" />
      </span>
    ),
    ...(place.default ? { mark: WHERE_WORDS.default } : {}),
    description: chips.map(chip => chip.text),
    chips,
    mono: true,
    ...(state === "" ? {} : { word: state, wordClass: "fact" }),
    ...(o.open === undefined ? {} : { open: o.open }),
    attrs: { "data-place-row": place.id },
  };
}

/** The state of the computer the host runs on, read off its own workspace's daemon rather than off a link it
 * never reports: this row said the Mac was fine while every pane on it said unreachable. */
function ownStateWord(ctx: SettingsContext): string {
  const here = ctx.workspaces.find(w => isLocalWorkspace(w)) ?? null;
  const absent = absenceOf(ctx.places, here, here === null ? null : (ctx.statuses[here.id] ?? null), ctx.now);
  const own = ctx.places.find(place => place.id === HERE_PLACE_ID);
  return own === undefined ? "" : placeStateWord(own, absent);
}

/** The pages under Computers in the sidebar: one per computer the list draws, this one first, off the same list so a
 * row and its sidebar row cannot disagree about which computers there are. */
export function computerSubPages(ctx: SettingsContext): { at: SettingsAt; name: string }[] {
  return ctx.places.map(place => ({ at: { kind: "computer", id: place.id }, name: placeName(place, place.id === HERE_PLACE_ID) }));
}

export function computersCards(ctx: SettingsContext): SettingsCardData[] {
  const counts = placeWorkspaceCounts(ctx.places, ctx.workspaces);
  const rows = ctx.places;
  return [
    {
      id: "computers",
      items: rows.map(place => {
        const here = place.id === HERE_PLACE_ID;
        return computerRowData(place, {
          here,
          count: counts[place.id] ?? 0,
          spend: ctx.reads.spend.find(row => row.place === place.id),
          now: ctx.now,
          ...(here ? { state: ownStateWord(ctx) } : {}),
          open: () => ctx.go({ kind: "computer", id: place.id }),
        });
      }),
      ...(ctx.placesRefused === null
        ? {}
        : { under: <RefusalSlot k="places-refused" said={WHERE_WORDS.notRead(ctx.placesRefused.said)} {...(ctx.placesRefused.fix === undefined ? {} : { fix: ctx.placesRefused.fix })} /> }),
    },
    { id: "add-computer", head: ADD_COMPUTER_WORDS.title, items: [], body: <AddComputer setup={ctx.reads.setup} /> },
  ];
}

/** The one computer row on its own, for the Add a computer sheet's joined screen. */
export function ComputerRow({ place, now }: { place: PlaceView; now: number }) {
  const data = computerRowData(place, { here: false, count: 0, now });
  const { kind: _row, ...row } = data;
  return (
    <Card id="joined">
      <Row {...row} drops={cardDrops([data])} />
    </Card>
  );
}

/** Update: puts this wsp's daemon on the computer and runs the recipe there again. One word in both states, held
 * and dimmed while it runs; held with no title where the client has no such request, since the row's description
 * says why. */
function UpdateControl({ place, held }: { place: PlaceView; held: boolean }) {
  const updatePlace = useStore(s => s.updatePlace);
  const [updating, setUpdating] = useState(false);
  return (
    <Button
      data-k="update"
      size="xs"
      variant="outline"
      held={held}
      disabled={updating}
      onClick={() => {
        setUpdating(true);
        void updatePlace(place.id).finally(() => setUpdating(false));
      }}
    >
      {WHERE_WORDS.update}
    </Button>
  );
}

/** Remove: the confirmation whose sentence is computed from what the computer holds, then the host's own road. */
function RemoveControl({ place, holding, imageBytes, onRemoved }: { place: PlaceView; holding: PlaceHolding; imageBytes: number | undefined; onRemoved: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button data-k="remove" size="xs" variant="outline" className={DANGER_BUTTON} onClick={() => setAsking(true)}>
        {WHERE_WORDS.remove}
      </Button>
      {asking ? (
        <RemoveComputerDialog
          place={place}
          holding={holding}
          {...(imageBytes === undefined ? {} : { imageBytes })}
          open
          onOpenChange={next => {
            if (!next) setAsking(false);
          }}
          onRemoved={onRemoved}
        />
      ) : null}
    </>
  );
}

/** What the agents manager's head says on a computer's page, naming its projects where it holds any, and on a cloud's,
 * whose rows are its image's. */
const AGENTS_PAGE_LINE = (computer: string, projects: boolean): string => `Agents, MCP servers and skills on ${computer}${projects ? " and in its projects" : ""}.`;
const AGENTS_IMAGE_LINE = (cloud: string): string => `The agents in the image every copy at ${cloud} is made from.`;

/** The agents, skills and MCP servers a computer reports, read when its page opens. Every act is held with the
 * page's away word while the computer is not answering, over the last report this window read. */
function ComputerAgents({ place, here, ctx }: { place: PlaceView; here: boolean; ctx: SettingsContext }) {
  const { report, reading, error, refresh } = useAgentsReport({ placeId: place.id });
  const tools = useServerTools({ placeId: place.id });
  const acts = useAgentActs({ placeId: place.id });
  const skills = useSkillActs({ placeId: place.id });
  const servers = useServerActs({ placeId: place.id });
  const away = absentOf(place, ctx.now, here)?.away ?? null;
  const name = here ? THIS_COMPUTER_WORD : placeName(place);
  return (
    <AgentsManager
      shell="page"
      head={{ line: AGENTS_PAGE_LINE(name, (report?.projects?.length ?? 0) > 0) }}
      report={report}
      reading={reading}
      error={error}
      on={name}
      ctx={{ where: here ? "here" : "box", ...(here ? {} : { computer: placeName(place) }), heldWhy: away, ...(tools === undefined ? {} : { tools }), ...(acts === undefined ? {} : { acts }), ...(skills === undefined ? {} : { skills }), ...(servers === undefined ? {} : { servers }) }}
      onRefresh={refresh}
      now={ctx.now}
      misses={recipeMissLines(place.provision?.rows ?? [])}
    />
  );
}

/** What a computer has cost, as its own line: the month's figure and the hourly rate, both the protocol's. The
 * count of workspaces the rate is spread over is not said, since the rate already is what is running there and a
 * line that ends "now across 0 workspaces" wraps at a phone's width to say nothing. */
/** A copy of the image as one comma list: the version with how it stands beside it, its size, and when it was built. */
const copyLineValue = (image: Parameters<typeof copyStanding>[0], copy: SealedImageView["copies"][number], now: number): string => {
  const standing = copyStanding(image, copy);
  return [`v${copy.version}${standing === undefined ? "" : ` (${standing})`}`, ...(copy.sizeBytes === undefined ? [] : [fmtBytes(copy.sizeBytes)]), builtWhen(copy.builtAt, now)].join(", ");
};

const spendLine = (spend: PlaceSpend): string[] => [spentThisMonth(spend.monthUsd), fmtRate(spend.rateUsdPerHour)];

/** Where a workspace of a project on this computer would land, for the Ports row: the first project the host holds
 * on it, since every workspace there reads the same two flags. */
function landingOn(ctx: SettingsContext, place: PlaceView): WorkspaceLanding | null {
  const project = projectOn(place, ctx.projects);
  return project === undefined ? null : (ctx.landings[project.id] ?? null);
}

/** The cloud's page: what it has taken, the image this host sealed and its copies, since the image exists only
 * behind the cloud's row, then Remove, whose dialog says the key is forgotten.
 *
 * The image is what this host builds with the cloud's key, so every word about it stands under the same rule the
 * list row's own cloud stands under: the key is held here. A cloud row drawn for a workspace alone is a machine
 * somebody else's key made, and this host has nothing to say about its image and nothing to edit. */
function cloudCards(ctx: SettingsContext, place: PlaceView, view: SealedImageView | null, imageCard: SettingsCardData[], holding: PlaceHolding, onRemoved: () => void): SettingsCardData[] {
  const held = keyHeld(place.name, ctx.reads.setup);
  const image = held ? (view?.image ?? null) : null;
  const spend = ctx.reads.spend.find(row => row.place === place.id);
  const facts: SettingsItem[] = spend === undefined ? [] : [{ kind: "line" as const, id: "spend", label: WHERE_WORDS.spend, value: spendLine(spend), attrs: { "data-k": "spend" } }];
  const copies: SettingsItem[] =
    image === null || view === null
      ? []
      : view.copies.map(copy => ({
          kind: "line" as const,
          id: `copy-${copy.place}`,
          label: copy.place,
          value: copyLineValue(image, copy, ctx.now),
          attrs: { "data-k": "image-copy", "data-place": copy.place },
        }));
  // A cloud keeps no computer to read: its agents are the image's, and the image is what every act there edits.
  const agents =
    image === null ? undefined : <AgentsManager shell="page" head={{ line: AGENTS_IMAGE_LINE(placeName(place)) }} report={imageAgentsReport(image, place.id)} reading={false} on={placeName(place)} ctx={{ where: "provider", editImage: () => openImageRecipe(place.id) }} now={ctx.now} />;
  return [
    // No card is drawn with nothing in it: before the host has answered, a cloud's page is its one act.
    ...(facts.length === 0 ? [] : [{ id: "cloud", items: facts }]),
    ...(held ? imageCard : []),
    ...(agents === undefined ? [] : [{ id: "agents", items: [], body: agents }]),
    ...(copies.length === 0 ? [] : [{ id: "copies", head: IMAGE_WORDS.copies, items: copies }]),
    {
      id: "acts",
      items: [
        {
          kind: "row" as const,
          id: "remove",
          title: WHERE_WORDS.removeTitle(placeName(place)),
          description: WHERE_WORDS.removeCloudDescription,
          control: <RemoveControl place={place} holding={holding} imageBytes={undefined} onRemoved={onRemoved} />,
        },
      ],
    },
  ];
}

/** One computer's own page. */
export function ComputerPage({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const here = place.id === HERE_PLACE_ID;
  const noUpdate = ctx.api?.placesUpdate === undefined;
  const { dial, busy, line, refused, held, heldWhy, road: dialRoad } = useDialPlace(place);
  const threadsOf = (workspaceId: string): number => ctx.sessions[workspaceId]?.length ?? 0;
  const holding = holdingsFor(ctx.places, ctx.workspaces, threadsOf, id => ctx.statuses[id] ?? null)[place.id] ?? NOTHING_HELD;
  // After the dialog has closed: the page under it goes with the computer, and a portal torn down with its page
  // in one frame is a node React cannot find.
  const onRemoved = (): void => void setTimeout(() => ctx.go({ kind: "group", group: "computers" }), 0);
  const view = ctx.reads.image;
  const image = useImageCard(place, ctx);
  const imageCard: SettingsCardData[] = image === undefined ? [] : [image];
  if (isProviderPlace(place)) return <Cards cards={cloudCards(ctx, place, view, imageCard, holding, onRemoved)} />;

  // How long this host has not heard from it, and null while it is holding its link: a computer that is answering
  // reads its facts plain, since nothing about them is stale.
  const away = place.present === true ? null : awayMsOf(place, ctx.now);
  // A cloud is no computer this host reaches, and this computer is reached by being here: the road reading is a
  // joined computer's alone, and the Connection card stands or goes with it.
  const road = here ? null : absentRoad({ name: place.name, road: place.road, awayMs: awayMsOf(place, ctx.now), dialled: place.dialled });
  const took = place.dialled?.answered === true && place.dialled.roundTripMs !== undefined ? `, ${place.dialled.roundTripMs} ms` : "";
  const copies = copiesWord(place, here);
  const landing = landingOn(ctx, place);
  const ports = landing === null ? "" : portsWord(landing.capabilities, undefined, APP_PLATFORM);
  const spend = ctx.reads.spend.find(row => row.place === place.id);

  const facts: SettingsItem[] = [
    // Marked while the computer is not answering, the way the pane's OS row is: a person who cannot tell which of
    // two screens is stale is the whole of what this line was reported for.
    ...(place.os === undefined ? [] : [{ kind: "line" as const, id: "system", label: WHERE_WORDS.system, value: lastKnown(place.engine !== undefined && place.engine !== "none" ? `${place.os}, ${place.engine}` : place.os, away), hover: WHERE_WORDS.systemHover, attrs: { "data-k": "system" } }]),
    ...(place.shape === undefined ? [] : [{ kind: "line" as const, id: "size", label: WHERE_WORDS.size, value: fmtSize(place.shape, placeCpuWord(place)), attrs: { "data-k": "size" } }]),
    ...(place.diskFreeBytes === undefined ? [] : [{ kind: "line" as const, id: "disk-free", label: WHERE_WORDS.diskFree, value: fmtBytes(place.diskFreeBytes), attrs: { "data-k": "disk-free" } }]),
    ...(here || place.joinedAt === undefined ? [] : [{ kind: "line" as const, id: "joined", label: WHERE_WORDS.joined, value: WHERE_WORDS.ago(offlineFor(ctx.now - Date.parse(place.joinedAt))), attrs: { "data-k": "joined" } }]),
    ...(spend === undefined ? [] : [{ kind: "line" as const, id: "spend", label: WHERE_WORDS.spend, value: spendLine(spend), attrs: { "data-k": "spend" } }]),
  ];
  // The dial's answer replaces the description while it stands, one line with the whole on hover; a wsp that
  // cannot dial says so there and draws no button. A refused dial goes under the card, whole and with its fix.
  const answered = line ?? road?.refused ?? heldWhy ?? WHERE_WORDS.answeredDescription;
  const connection: SettingsItem[] =
    road === null
      ? []
      : [
          ...(road.address === null ? [] : [{ kind: "row" as const, id: "address", title: WHERE_WORDS.address, description: road.dialsBack === null ? WHERE_WORDS.addressDescription : WHERE_WORDS.addressBackDescription(road.dialsBack), word: road.address, attrs: { "data-k": "address" } }]),
          {
            kind: "row" as const,
            id: "answered",
            title: WHERE_WORDS.answered,
            description: answered,
            word: `${road.answered}${took}`,
            attrs: { "data-k": "answered" },
            ...(dialRoad === undefined || heldWhy !== null ? {} : { control: <DialButton busy={busy} held={held} road={dialRoad} onDial={dial} /> }),
          },
        ];
  const workspaceThere: SettingsItem[] = [
    ...(copies === "" ? [] : [{ kind: "row" as const, id: "copies", title: WHERE_WORDS.copies, description: WHERE_WORDS.copiesDescription, word: copies, attrs: { "data-k": "copies" } }]),
    ...(ports === "" ? [] : [{ kind: "row" as const, id: "ports", title: WHERE_WORDS.ports, description: WHERE_WORDS.portsDescription, word: ports, attrs: { "data-k": "ports" } }]),
  ];
  const workspaces = holding.workspaces.map((w, at) => ({ kind: "line" as const, id: `workspace-${at}`, label: w.name, value: [w.state, threadWord(w.threads)], valueClass: "fact" as const, attrs: { "data-k": "workspace-line" } }));
  const imageBytes = ctx.reads.image === null ? undefined : copyOn(ctx.reads.image.copies, place)?.sizeBytes;
  const cards: SettingsCardData[] = [
    { id: "look", items: [{ kind: "row", id: "icon", title: WHERE_WORDS.icon, description: WHERE_WORDS.iconDescription, control: <ComputerIconSelect place={place} onChange={icon => ctx.setPreferences({ computerLook: { [place.id]: { icon } } })} /> }] },
    ...(facts.length === 0 ? [] : [{ id: "facts", items: facts }]),
    ...imageCard,
    ...(connection.length === 0
      ? []
      : [{ id: "connection", head: WHERE_WORDS.connection, items: connection, ...(refused === null ? {} : { under: <RefusalSlot k="dial-refusal" said={refused.said} {...(refused.fix === undefined ? {} : { fix: refused.fix })} /> }) }]),
    ...(workspaceThere.length === 0 ? [] : [{ id: "workspace-there", head: WHERE_WORDS.workspaceThere, items: workspaceThere }]),
    { id: "agents", items: [], body: <ComputerAgents place={place} here={here} ctx={ctx} /> },
    ...(workspaces.length === 0 ? [] : [{ id: "workspaces", head: WHERE_WORDS.workspaces, items: workspaces }]),
    // This computer is the one nothing can be done to: it is the computer the host runs on.
    ...(here
      ? []
      : [
          {
            id: "acts",
            items: [
              {
                kind: "row" as const,
                id: "update",
                title: WHERE_WORDS.updateTitle(placeName(place)),
                description: noUpdate ? `${WHERE_WORDS.updateDescription} ${WHERE_WORDS.updateHeld}` : WHERE_WORDS.updateDescription,
                control: <UpdateControl place={place} held={noUpdate} />,
              },
              {
                kind: "row" as const,
                id: "remove",
                title: WHERE_WORDS.removeTitle(placeName(place)),
                description: WHERE_WORDS.removeDescription(placeName(place)),
                control: <RemoveControl place={place} holding={holding} imageBytes={imageBytes} onRemoved={onRemoved} />,
              },
            ],
          },
        ]),
  ];
  return <Cards cards={cards} />;
}
