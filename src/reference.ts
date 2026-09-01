// These numbers are copied from getsolari.com's own benchmark tables.
// Only the row marked isLive is measured by this app. Everything else here
// is a static reference so a visitor can see where a live run lands next
// to the field - this server never calls a competitor's API.

export interface ReferenceRow {
  name: string;
  value: number;
  isLive?: boolean;
}

export interface ReferenceTable {
  title: string;
  unit: string;
  sourceLabel: string;
  sourceUrl: string;
  rows: ReferenceRow[];
}

export const browserReference: ReferenceTable = {
  title: "end-to-end browser latency",
  unit: "ms",
  sourceLabel: "getsolari.com, measured on Steel's open source benchmark",
  sourceUrl: "https://www.getsolari.com",
  rows: [
    { name: "Solari", value: 199, isLive: true },
    { name: "Kernel", value: 778 },
    { name: "Steel", value: 867 },
    { name: "Browserbase", value: 2888 },
  ],
};

export const sandboxReference: ReferenceTable = {
  title: "full sandbox lifecycle",
  unit: "s",
  sourceLabel: "getsolari.com, measured on the nibzard open source benchmark",
  sourceUrl: "https://www.getsolari.com",
  rows: [
    { name: "Solari", value: 8.2, isLive: true },
    { name: "E2B", value: 10.8 },
    { name: "Modal", value: 11.9 },
    { name: "Daytona", value: 13.6 },
    { name: "CodeSandbox", value: 24.8 },
  ],
};
