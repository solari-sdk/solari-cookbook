"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { observe, checkpoint, takeover, reopen } = require("./observation.cjs");
const [command, root] = process.argv.slice(2);
if (root !== "/tmp/hito-semantic-checkpoint/project")
  throw Error("FIXED_GUEST_ROOT_REQUIRED");
const state = path.join(root, ".maat"),
  saved = path.join(state, "solari-public-checkpoint.json");
if (command === "capture") {
  if (fs.existsSync(state)) throw Error("FRESH_STATE_REQUIRED");
  const value = checkpoint(observe(root));
  fs.mkdirSync(state);
  fs.writeFileSync(saved, JSON.stringify(value), { flag: "wx" });
  console.log(JSON.stringify(value));
} else if (command === "takeover") {
  const raw = fs.readFileSync(saved);
  if (raw.length > 524288) throw Error("CHECKPOINT_LIMIT");
  const value = JSON.parse(raw);
  reopen(value);
  console.log(JSON.stringify(takeover(root, value)));
} else throw Error("UNKNOWN_COMMAND");
