// SPDX-License-Identifier: AGPL-3.0-only
// The release every catalog row on the release road installs: its tag, and per
// arch the asset's name and the sha256 wsp recorded for it, so a machine checks
// the bytes against a sum that stood in the catalog before the download. One
// entry per repository the catalog names, and a row whose repository is missing
// fails when the catalog loads. A bump is one entry, printed to paste by
// `node packages/catalog/scripts/pin-release.mjs <repo> <tag>`; each comment
// names the release the entry was read from and the sums it publishes.
import type { InstallRoad, ReleaseAssets } from "./roads.js";

export interface ReleasePin {
  tag: string;
  assets: ReleaseAssets;
}

export const RELEASE_PINS: Readonly<Record<string, ReleasePin>> = {
  // https://github.com/cli/cli/releases/tag/v2.101.0, sums published at https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_checksums.txt
  "cli/cli": { tag: "v2.101.0", assets: { x86_64: { name: "gh_2.101.0_linux_amd64.tar.gz", sha256: "9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8" }, aarch64: { name: "gh_2.101.0_linux_arm64.tar.gz", sha256: "b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f" } } },
  // https://github.com/cloudflare/cloudflared/releases/tag/2026.9.1, which publishes no sums; the plain Linux build,
  // as packages/host/assets/cloudflared.json names it, since the release's first amd64 asset is the FIPS one.
  "cloudflare/cloudflared": { tag: "2026.9.1", assets: { x86_64: { name: "cloudflared-linux-amd64", sha256: "03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc" }, aarch64: { name: "cloudflared-linux-arm64", sha256: "3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3" } } },
  // https://github.com/superfly/flyctl/releases/tag/v0.4.105, sums published at https://github.com/superfly/flyctl/releases/download/v0.4.105/flyctl_0.4.105_checksums.txt
  "superfly/flyctl": { tag: "v0.4.105", assets: { x86_64: { name: "flyctl_0.4.105_Linux_x86_64.tar.gz", sha256: "6e78298d82503f2aff2c6f41ede1178463ed286ce910c6be946a4b994ee68f29" }, aarch64: { name: "flyctl_0.4.105_Linux_arm64.tar.gz", sha256: "6ec0dc3656ecbe281231994080ec00238cecaa11aa65a121f53c51e3d2a69940" } } },
  // https://github.com/supabase/cli/releases/tag/v2.117.0, sums published at https://github.com/supabase/cli/releases/download/v2.117.0/checksums.txt
  "supabase/cli": { tag: "v2.117.0", assets: { x86_64: { name: "supabase_2.117.0_linux_amd64.tar.gz", sha256: "69c05f85b9e47ee706d30f1a6ca8a526b4e337bfd12c7ef1ef522d24e7280d24" }, aarch64: { name: "supabase_2.117.0_linux_arm64.tar.gz", sha256: "598c56a936fdf179ea486717901e6e49bc5d777b3ad317eab02f41faf21a95cb" } } },
  // https://github.com/DopplerHQ/cli/releases/tag/3.76.6, sums published at https://github.com/DopplerHQ/cli/releases/download/3.76.6/checksums.txt
  "DopplerHQ/cli": { tag: "3.76.6", assets: { x86_64: { name: "doppler_3.76.6_linux_amd64.tar.gz", sha256: "67e4e020761adf3ffe5a030712d61721b4e2752182670bf90de5a2a88e4961e3" }, aarch64: { name: "doppler_3.76.6_linux_arm64.tar.gz", sha256: "621456ac08436c4037a72c8641e4bdcccd0e404ab43b79a61d449445bb02e6e5" } } },
  // https://github.com/mikefarah/yq/releases/tag/v4.53.6, sums published at https://github.com/mikefarah/yq/releases/download/v4.53.6/checksums
  "mikefarah/yq": { tag: "v4.53.6", assets: { x86_64: { name: "yq_linux_amd64", sha256: "c5f056448f973ae7d39b5401949648a78f2dc1947d6a8eb65be60d5c504b9385" }, aarch64: { name: "yq_linux_arm64", sha256: "88a1016bc1d657375a35864e4f44b6f333df8ff97b559f51bba0adcb2169df09" } } },
  // https://github.com/golangci/golangci-lint/releases/tag/v2.13.2, sums published at https://github.com/golangci/golangci-lint/releases/download/v2.13.2/golangci-lint-2.13.2-checksums.txt
  "golangci/golangci-lint": { tag: "v2.13.2", assets: { x86_64: { name: "golangci-lint-2.13.2-linux-amd64.tar.gz", sha256: "2277d43b98ec0054280f2ac26b53268bae97682444678a59a657dd565da021d6" }, aarch64: { name: "golangci-lint-2.13.2-linux-arm64.tar.gz", sha256: "a2a4e0065aa41be71f7c5ac90f271b61751331e5d04314e62afe4027855f0893" } } },
  // https://github.com/jdx/mise/releases/tag/v2026.9.12, which publishes no sums beside the binaries
  "jdx/mise": { tag: "v2026.9.12", assets: { x86_64: { name: "mise-v2026.9.12-linux-x64", sha256: "e79ae57945034903aee8aa2ea66b4c7ca9cd4f4edd5a8a78a589cbae6d0f428a" }, aarch64: { name: "mise-v2026.9.12-linux-arm64", sha256: "f344c6961190ed2f68e595ed7cb4f03c36c17812bd608886bec799a3082180ff" } } },
  // https://github.com/dandavison/delta/releases/tag/0.19.2, which publishes no sums beside the tarballs
  "dandavison/delta": { tag: "0.19.2", assets: { x86_64: { name: "delta-0.19.2-x86_64-unknown-linux-gnu.tar.gz", sha256: "8e695c5f586a8c53d6c3b01be0b4a422ed218bfed2a56191caebe373a1c18ab2" }, aarch64: { name: "delta-0.19.2-aarch64-unknown-linux-gnu.tar.gz", sha256: "0bfce159a5cddd5feb3d6db4a616d883ff51253ce08ac7ec11cb1d208cfaab9e" } } },
  // https://github.com/bazelbuild/bazelisk/releases/tag/v1.29.0, which publishes no sums beside the binaries
  "bazelbuild/bazelisk": { tag: "v1.29.0", assets: { x86_64: { name: "bazelisk-linux-amd64", sha256: "5a408715e932c0250d28bd84555f12edbf70117de42f9181691c736eacc4a992" }, aarch64: { name: "bazelisk-linux-arm64", sha256: "e20e8b0f4f240091b7a55bf17b9398bd4f40ee70ae0208dff95dd4c445fb4010" } } },
  // https://github.com/charmbracelet/crush/releases/tag/v0.96.1, sums published at https://github.com/charmbracelet/crush/releases/download/v0.96.1/checksums.txt
  "charmbracelet/crush": { tag: "v0.96.1", assets: { x86_64: { name: "crush_0.96.1_Linux_x86_64.tar.gz", sha256: "5411b0906a82162dcab4a99071d70accf1caad0eee69789416dd607943c6680d" }, aarch64: { name: "crush_0.96.1_Linux_arm64.tar.gz", sha256: "4bfe4a37aedeb4219d51eb7a25b837304084070378e77fd578999764b487f01f" } } },
  // https://github.com/aaif-goose/goose/releases/tag/v1.52.0, which publishes no sums beside the tarballs; the glibc build without vulkan
  "aaif-goose/goose": { tag: "v1.52.0", assets: { x86_64: { name: "goose-x86_64-unknown-linux-gnu.tar.gz", sha256: "4aee1f770b405c44194c0e9407df1fb06bda4c50eee935f0d8fd10731821cc5e" }, aarch64: { name: "goose-aarch64-unknown-linux-gnu.tar.gz", sha256: "ae602c4f6e9a785bf087da52c89908d4dc6aa605dcc17bf83293873f626d9c85" } } },
};

/** The release road at the tag and the per-arch assets this table recorded for the repository, so no row of the
 * catalog installs a release nobody read; `go` is the repository's main package for an arch the release has no asset
 * for, left off when it has none. */
export function pinnedRelease(repo: string, go?: string): InstallRoad {
  const pin = RELEASE_PINS[repo];
  if (pin === undefined) throw new Error(`the release pins table names no ${repo}`);
  return { road: "release", repo, version: pin.tag, assets: pin.assets, ...(go !== undefined ? { go } : {}) };
}
