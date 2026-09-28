import type { Compute, Sandbox, Termination } from "./types.ts";
export async function terminate(
  client: Compute,
  sandbox: Sandbox,
): Promise<Termination> {
  await sandbox.kill();
  try {
    const state = await client.get(sandbox.id);
    if (state.state === "gone")
      return {
        terminated: true,
        id: sandbox.id,
        basis: "ACKNOWLEDGED_KILL_AND_GET_GONE",
      };
    throw Error("TERMINATION_UNCONFIRMED");
  } catch (e) {
    if (
      typeof e === "object" &&
      e !== null &&
      "status" in e &&
      e.status === 404
    )
      return {
        terminated: true,
        id: sandbox.id,
        basis: "ACKNOWLEDGED_KILL_AND_STRUCTURED_404",
      };
    throw Error("TERMINATION_UNCONFIRMED");
  }
}
export function boundedFetch(real: typeof fetch, max: number): typeof fetch {
  let count = 0;
  const keys = new Set<string>();
  return async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.pathname.includes("snapshot")) throw Error("SNAPSHOTS_NOT_USED");
    if (
      init?.method?.toUpperCase() === "POST" &&
      url.pathname === "/sandboxes"
    ) {
      const key = new Headers(init.headers).get("Idempotency-Key");
      if (count >= max || !key || keys.has(key))
        throw Error("CREATE_BUDGET_OR_RETRY");
      const body = JSON.parse(String(init.body));
      if (body.fromSnapshot) throw Error("SNAPSHOTS_NOT_USED");
      count++;
      keys.add(key);
    }
    return real(input, init);
  };
}
export async function liveClient(key: string, max: number): Promise<Compute> {
  const { SandboxClient } = await import("@solarisdk/sandbox");
  return new SandboxClient({
    apiKey: key,
    baseUrl: "https://api.getsolari.com",
    callTimeoutMs: 30000,
    fetch: boundedFetch(fetch, max),
  });
}
// Node is an execution runtime, not an additional remote compute provider.
// Fixed release; publisher checksum is verified inside the guest before use.
export const provision = `set -eu
mkdir -p /tmp/hito-semantic-checkpoint/project/src
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)'; then
 ln -s "$(command -v node)" /tmp/hito-semantic-checkpoint/node
else
 case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) exit 42;; esac
 cd /tmp/hito-semantic-checkpoint
 name="node-v22.18.0-linux-$arch.tar.xz"
 curl --fail --silent --show-error --location https://nodejs.org/dist/v22.18.0/SHASUMS256.txt -o SHASUMS256.txt
 curl --fail --silent --show-error --location "https://nodejs.org/dist/v22.18.0/$name" -o "$name"
 grep "  $name$" SHASUMS256.txt | sha256sum -c -
 mkdir node-dist
 tar -xJf "$name" -C node-dist --strip-components=1
 ln -s /tmp/hito-semantic-checkpoint/node-dist/bin/node /tmp/hito-semantic-checkpoint/node
fi
/tmp/hito-semantic-checkpoint/node --version
`;
