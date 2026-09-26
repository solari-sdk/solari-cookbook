// SPDX-License-Identifier: AGPL-3.0-only
// The names of the variables wsp reads out of an environment. Their own module,
// with nothing under it, so the test configs can name them without loading the
// protocol's schemas: a root config that imports the index pays for zod on every
// config load, and a second copy of a name is what this file exists to prevent.

/** The one road that turns labs on: this variable in the host's environment, read once when the runtime starts. */
export const LABS_ENV = "WSP_LABS";

/** The variable a turn's launch environment carries so wsp run inside that turn can say which thread it is: one
 * turn's token, minted by the host at the launch and forgotten when the turn's process exits. The host is the only
 * thing that maps it to a thread, so a caller cannot name a thread it did not come from. */
export const TURN_TOKEN_ENV = "WSP_TURN";

/** The address a machine dials this host at, in the launch environment of every turn on a workspace whose agents
 * may spawn: the host's own reachable address, which is not loopback, since the turn runs on another computer. */
export const HOST_URL_ENV = "WSP_HOST_URL";

/** The token that turn presents there: a device of this host's, scoped to the thread, minted at the launch and
 * taken away when the turn's process exits. It never reaches a config file or an argument, only the environment. */
export const HOST_TOKEN_ENV = "WSP_HOST_TOKEN";

/** Set by the wsp command's forwarder on the one wsp it runs to ask where the host serving this line is: `door`
 * answers a host already serving and `start` brings one up first, as a verb would. That run prints the address and
 * the token the forwarder dials as one JSON line on a stdout that is not a terminal and serves nothing; a line with
 * no such host prints nothing and is left to the wsp the forwarder runs next. */
export const FORWARD_ENV = "WSP_FORWARD";

/** The word the host puts on the wsp tool server a scoped turn on this computer launches: an argument and not a
 * variable, since an agent that strips its servers' environment would strip a variable with the pair. A server
 * that carries it and finds no pair refuses rather than dialling the host on this computer's own token. */
export const SCOPED_MCP_ARG = "--scoped";

/** The fingerprint of the key that host proves, beside the two above: the turn pins it before it sends the token,
 * so a relay that carries the bytes or names another host at that address gets nothing. A launch that carries the
 * address and the token without it is refused rather than dialled, since nothing there says which host it is. */
export const HOST_KEY_ENV = "WSP_HOST_KEY";

/** The person's own home directory, for a host whose HOME is not theirs: a harness that serves a fixture state out
 * of a throwaway home still runs its turns on this computer, and macOS keys an agent's sign-in to the home the
 * person logs in to. A turn under any other home answers "Not logged in" whatever the store variables say: the
 * login keychain is listed out of $HOME/Library, and the harness moves its own lookup with the home too (measured
 * 2026-09-12). Unset everywhere else, where the process's home is the person's. */
export const PERSON_HOME_ENV = "WSP_PERSON_HOME";

/** The provider a stand-in serves in place of, for a harness serving a fixture of that cloud's machines: the rows
 * about those machines read this word rather than the stand-in's own, since a tester reads a row for which cloud
 * they are paying. Unset everywhere else, where a provider is the one it says it is. */
export const FAKE_AS_ENV = "WSP_FAKE_AS";

/** The folder a host serves the built app out of, for a harness that serves a copy of it: the lab copies the built
 * app into its own home and names it here, so a build landing on main mid-run cannot change the app under a tester.
 * Unset everywhere else, where the host serves the asset built beside it. */
export const WEB_DIR_ENV = "WSP_WEB_DIR";

/** The folder a stand-in provider keeps its own machines in, for a harness that wants a fixture's forks to behave
 * like machines: its records go there, so a second host on the same state file reads the same fleet, and each
 * machine gets a folder of its own there with a daemon rooted in it, which is what puts a terminal, a process list
 * and live readings on a fork that stands for nothing. Unset everywhere else, where the stand-in holds its
 * machines for one process and they have no guest at all. */
export const FAKE_ROOT_ENV = "WSP_FAKE_ROOT";

/** The file a stand-in provider keeps its records in, for a harness that seeds a fleet and wants no guest: the
 * machines a fixture names come up in the state that file gives them, and nothing runs on any of them. A harness
 * that names a folder above needs none of this, since the records go in that folder. Unset everywhere else, where
 * the stand-in holds its machines for one process. */
export const FAKE_RECORDS_ENV = "WSP_FAKE_RECORDS";

/** The switch that stops the host asking GitHub for the newest release: `0` here, or on a line of the .env beside
 * the state file, which is the one place the desktop app's host reads it from, since that app's environment is the
 * login's and not a shell's. */
export const UPDATE_CHECK_ENV = "WSP_UPDATE_CHECK";

/** The base the host asks for the newest release instead of GitHub's API, for a smoke serving a release of its
 * own. Unset everywhere else. */
export const RELEASE_API_ENV = "WSP_RELEASE_API";

/** Every variable a turn's launch hands its agent for reaching this host, the one list of them: an agent that hands
 * its servers only the variables it is told to pass is told these. */
export const LAUNCH_ENV = [HOST_URL_ENV, HOST_TOKEN_ENV, HOST_KEY_ENV, TURN_TOKEN_ENV] as const;
