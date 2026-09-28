// SPDX-License-Identifier: AGPL-3.0-only
// Commands with a Linux build of their own, outside Homebrew, that the
// catalog's vendor road installs. Each carries the version wsp pinned and the
// sha256 of that version's download per arch, checked on the guest before
// anything the download carries runs and printed on the WSP_ROAD line the
// tools stage reads. Neither vendor is asked what its current version is: a
// bump is an edit of the two fields below, read the way uv's pin is read.
import { shellQuote } from "@wsp/protocol";

export interface LinuxCask {
  /** The command the install puts on PATH. */
  bin: string;
  /** Where the Linux build comes from, for the row's column. */
  from: string;
  /** The row's detail line, under 76 columns: what lands on the machine. */
  detail: string;
  /** The version wsp pinned, which the catalog's row carries too. */
  version: string;
  /** That version's download per arch, as the sums below were read. */
  sha256: { x86_64: string; aarch64: string };
  /** One bash script: the version this cask pins, downloaded and checked against the sum it pins for the arch. */
  install: string;
  uninstall: string;
}

/** The version the script installs, which is the cask's own: the two sums beside it are that version's downloads. */
const verLine = (version: string): string => `ver=${shellQuote(version)}`;

const PRELUDE = ["set -euo pipefail", 'arch="$(uname -m)"', 'tmp="$(mktemp -d /tmp/wsp-cask-XXXXXX)"', "trap 'rm -rf \"$tmp\"' EXIT"];
/** This vendor's own word for the arch, and the sum it pins for that arch's download, read together. */
const ARCH = (x86: string, arm: string, sha256: { x86_64: string; aarch64: string }): string =>
  `case "$arch" in x86_64) a=${x86} sha=${sha256.x86_64} ;; aarch64) a=${arm} sha=${sha256.aarch64} ;; *) echo "Error: unsupported arch: $arch" >&2; exit 1 ;; esac`;

const GCLOUD_HOME = "/opt/google-cloud-sdk";
const GCLOUD_BINS = ["gcloud", "gsutil", "bq"];

/** Google publishes the tarball per version and arch and no sum beside it, so the sums are the tarballs' own as read
 * on 2026-09-22 (https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/). */
const GCLOUD_PIN = {
  version: "586.0.0",
  sha256: {
    x86_64: "6c774c76793eedd501150b59da653610fbe3eaac169e822965b722de75a2f001",
    aarch64: "e50ea0141a027d5118d7dd011d2870e706466dc0fc437d95cae86a14e0d871bc",
  },
} as const;

/** The x86_64 tarball bundles a Python; the arm one runs on the machine's python3. */
export const GCLOUD: LinuxCask = {
  ...GCLOUD_PIN,
  bin: "gcloud",
  from: "Google's Linux release",
  detail: "from Google's Linux release, at the version and sum the catalog pins",
  install: [
    ...PRELUDE,
    ARCH("x86_64", "arm", GCLOUD_PIN.sha256),
    `[ "$a" != arm ] || command -v python3 >/dev/null || { echo "Error: gcloud on arm needs python3 on the machine; Google's arm tarball bundles none" >&2; exit 1; }`,
    verLine(GCLOUD_PIN.version),
    'pkg="google-cloud-cli-$ver-linux-$a.tar.gz"',
    'curl -o "$tmp/$pkg" "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/$pkg"',
    'echo "$sha  $tmp/$pkg" | sha256sum -c - >/dev/null',
    `rm -rf ${GCLOUD_HOME}`,
    'tar -xzf "$tmp/$pkg" -C /opt',
    ...GCLOUD_BINS.map(b => `ln -sf ${GCLOUD_HOME}/bin/${b} /usr/local/bin/${b}`),
    'echo "WSP_ROAD release $pkg $sha $ver"',
  ].join("\n"),
  uninstall: `rm -rf ${GCLOUD_HOME} ${GCLOUD_BINS.map(b => `/usr/local/bin/${b}`).join(" ")}`,
};

/** The static binary from the Kubernetes release, at the sums Kubernetes publishes beside it
 * (https://dl.k8s.io/release/v1.37.0/bin/linux/amd64/kubectl.sha256 and the arm64 one), read on 2026-09-22. */
const KUBECTL_PIN = {
  version: "v1.37.0",
  sha256: {
    x86_64: "6129359f4e1f3848a5572ccb0b26cf28b8ca08cef38c95a765b2f64a2c961a2f",
    aarch64: "922df28df248cc00a9e025f947704f1d1482de64ece54cfe57e61f19eaf1eef3",
  },
} as const;

export const KUBECTL: LinuxCask = {
  ...KUBECTL_PIN,
  bin: "kubectl",
  from: "Kubernetes release",
  detail: "kubectl only, from the Kubernetes release; Docker itself has no Linux build",
  install: [
    ...PRELUDE,
    ARCH("amd64", "arm64", KUBECTL_PIN.sha256),
    verLine(KUBECTL_PIN.version),
    'curl -o "$tmp/kubectl" "https://dl.k8s.io/release/$ver/bin/linux/$a/kubectl"',
    'echo "$sha  $tmp/kubectl" | sha256sum -c - >/dev/null',
    'install -m 0755 "$tmp/kubectl" /usr/local/bin/kubectl',
    'echo "WSP_ROAD release kubectl-$ver-linux-$a $sha $ver"',
  ].join("\n"),
  uninstall: "rm -f /usr/local/bin/kubectl",
};

export const LINUX_CASKS: readonly LinuxCask[] = [GCLOUD, KUBECTL];
