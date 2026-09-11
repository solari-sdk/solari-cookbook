"use strict";
// Public acquisition/transport wrapper. Semantic claims and currentness are
// derived only by the four retained HITO routines in hito-observation.cjs.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const hito = require("./hito-observation.cjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SUBJECT = "hito-public-tiny-delivery-v1",
  ROOT = "hito:tiny-delivery";
const SELECTION = [
  ["README.md", "architecture", "DOCUMENTARY_EVIDENCE_ONLY"],
  ["package.json", "projectMetadata", "STRUCTURAL_DECLARATION"],
  ["src/index.js", "runtime", "PHYSICAL_OBSERVATION"],
];
const UNKNOWN = Object.freeze([
  "Runtime behavior has not been verified.",
  "Tests and deployment readiness have not been established.",
  "Project paths outside the three selected files remain unobserved.",
]);
const NEXT = Object.freeze({
  state: "NO_JUSTIFIED_NEXT_STEP",
  mutatingCommand: null,
  executionAuthority: false,
});
function reader(root, rel, budget) {
  if (!SELECTION.some((row) => row[0] === rel))
    return { state: "UNAVAILABLE", reason: "OUTSIDE_PUBLIC_SCOPE" };
  try {
    let current = root;
    if (fs.lstatSync(root).isSymbolicLink())
      return { state: "UNAVAILABLE", reason: "LINK_EXCLUDED" };
    for (const part of rel.split("/")) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink())
        return { state: "UNAVAILABLE", reason: "LINK_EXCLUDED" };
    }
    const stat = fs.statSync(current);
    if (!stat.isFile())
      return { state: "UNAVAILABLE", reason: "NOT_REGULAR_FILE" };
    if (stat.size > 65536)
      return { state: "INDETERMINATE", reason: "ACQUISITION_LIMIT" };
    const fd = fs.openSync(current, "r");
    let bytes;
    try {
      bytes = Buffer.alloc(65537);
      bytes = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0));
    } finally {
      fs.closeSync(fd);
    }
    if (bytes.length > 65536)
      return { state: "INDETERMINATE", reason: "ACQUISITION_LIMIT" };
    const content = bytes.toString("utf8");
    if (!Buffer.from(content).equals(bytes))
      return { state: "UNAVAILABLE", reason: "INVALID_UTF8" };
    budget.files++;
    budget.bytes += bytes.length;
    return {
      state: "OBSERVED",
      content,
      contentSha256: sha(bytes),
      bytes: bytes.length,
    };
  } catch (e) {
    return {
      state: e.code === "ENOENT" ? "UNAVAILABLE" : "INDETERMINATE",
      reason: e.code === "ENOENT" ? "NOT_FOUND_AT_CAPTURE" : "READ_FAILED",
    };
  }
}
function observe(root) {
  const budget = { files: 0, bytes: 0 };
  const artifacts = SELECTION.map(([rel, dimension, authority]) =>
    hito.artifact(ROOT, rel, dimension, authority, reader(root, rel, budget)),
  );
  return {
    subjectIdentity: SUBJECT,
    artifacts,
    claims: artifacts.flatMap((a) => hito.claimsFor(a, SUBJECT)),
    unknowns: [...UNKNOWN],
    authority: { canonicalAuthority: false, executionAuthority: false },
    nextStep: { ...NEXT },
  };
}
function checkpoint(observation) {
  const payload = {
    kind: "HITO_SOLARI_BOUNDED_CHECKPOINT_V1",
    subjectIdentity: SUBJECT,
    observation,
  };
  const bytes = JSON.stringify(payload);
  return {
    kind: "HITO_SOLARI_CHECKPOINT_ENVELOPE_V1",
    sha256: sha(Buffer.from(bytes)),
    payload,
  };
}
function reopen(value) {
  if (
    !value ||
    Object.keys(value).sort().join("|") !== "kind|payload|sha256" ||
    value.kind !== "HITO_SOLARI_CHECKPOINT_ENVELOPE_V1" ||
    sha(Buffer.from(JSON.stringify(value.payload))) !== value.sha256
  )
    throw Error("CHECKPOINT_INTEGRITY");
  const p = value.payload;
  if (
    Object.keys(p).sort().join("|") !== "kind|observation|subjectIdentity" ||
    p.kind !== "HITO_SOLARI_BOUNDED_CHECKPOINT_V1" ||
    p.subjectIdentity !== SUBJECT
  )
    throw Error("CHECKPOINT_SUBJECT");
  const o = p.observation;
  if (
    !o ||
    o.subjectIdentity !== SUBJECT ||
    !Array.isArray(o.artifacts) ||
    o.artifacts.length !== 3
  )
    throw Error("CHECKPOINT_SCOPE");
  const expectedArtifacts = o.artifacts.map((a, i) => {
    const [rel, dimension, authority] = SELECTION[i];
    if (
      a.path !== rel ||
      a.dimension !== dimension ||
      a.authority !== authority
    )
      throw Error("CHECKPOINT_AUTHORITY");
    let observation;
    if (a.state === "OBSERVED") {
      if (
        typeof a.content !== "string" ||
        Buffer.byteLength(a.content) > 65536 ||
        sha(Buffer.from(a.content)) !== a.contentSha256 ||
        Buffer.byteLength(a.content) !== a.bytes
      )
        throw Error("CHECKPOINT_CONTENT");
      observation = {
        state: "OBSERVED",
        content: a.content,
        contentSha256: a.contentSha256,
        bytes: a.bytes,
      };
    } else {
      if (
        !["UNAVAILABLE", "INDETERMINATE"].includes(a.state) ||
        ![
          "OUTSIDE_PUBLIC_SCOPE",
          "LINK_EXCLUDED",
          "NOT_REGULAR_FILE",
          "ACQUISITION_LIMIT",
          "INVALID_UTF8",
          "NOT_FOUND_AT_CAPTURE",
          "READ_FAILED",
        ].includes(a.reason)
      )
        throw Error("CHECKPOINT_OBSERVATION");
      observation = { state: a.state, reason: a.reason };
    }
    return hito.artifact(ROOT, rel, dimension, authority, observation);
  });
  const expected = {
    subjectIdentity: SUBJECT,
    artifacts: expectedArtifacts,
    claims: expectedArtifacts.flatMap((a) => hito.claimsFor(a, SUBJECT)),
    unknowns: [...UNKNOWN],
    authority: { canonicalAuthority: false, executionAuthority: false },
    nextStep: { ...NEXT },
  };
  if (JSON.stringify(expected) !== JSON.stringify(o))
    throw Error("CHECKPOINT_DERIVED_SUPPORT");
  return expected;
}
function takeover(root, envelope) {
  const prior = reopen(envelope);
  const current = observe(root);
  const refreshed = hito.refresh(root, prior, (_root, rel, budget) => {
    const a = current.artifacts.find((x) => x.path === rel);
    if (a.state === "OBSERVED") {
      budget.files++;
      budget.bytes += a.bytes;
    }
    return a;
  });
  const contradictions = hito.assessAcquisitionContradictions(
    refreshed.claims,
    prior.artifacts,
    NEXT,
  );
  return {
    subjectIdentity: SUBJECT,
    continuity: "REOPENED_BOUNDED_HISTORICAL_EVIDENCE",
    checkpointSha256: envelope.sha256,
    historicalClaims: refreshed.claims,
    reobserved: refreshed.observations,
    changed: refreshed.changed,
    uncertain: refreshed.uncertain,
    current,
    unknowns: [...UNKNOWN],
    contradictions,
    nextStep: contradictions.nextStep,
    authority: { canonicalAuthority: false, executionAuthority: false },
    scope:
      "Three selected files only; current bytes do not verify behavior or authorize execution.",
  };
}
module.exports = {
  observe,
  checkpoint,
  reopen,
  takeover,
  reader,
  sha,
  SUBJECT,
  SELECTION,
  UNKNOWN,
};
