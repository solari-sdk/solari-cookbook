// SPDX-License-Identifier: AGPL-3.0-only
export { ASSETS_DIR, ASSET_KINDS, REQUIRE_DAEMON_ENV, assetDir, assetProof, daemonBinaryHere, packedAsset, stageAsset, stageAssetOrSkip, stagedAsset, workspaceAsset, type AssetKind } from "./assets.js";
export { stateWriterHere, VERSION } from "./version.js";
export { RELEASE_BODY_MAX_BYTES, RELEASE_TIMEOUT_MS, cappedText, releaseAssetUrl, releaseTagUrl } from "./release.js";
export { type RestartingHost, type RestartRoad } from "./restart.js";
export {
  startHost,
  type HostOptions,
  type HostHandle,
  type ReachState,
  type ReachStatus,
  type WorkspaceStatus,
} from "./server.js";
export {
  cli,
  devCheckoutState,
  goldenRecipe,
  keySources,
  loadKeys,
  localWiring,
  localWorkFolder,
  makeRuntime,
  readOnce,
  serve,
  servesNothing,
  stopOnSignals,
  terminalIO,
  wspHome,
  HELP,
  type CliIO,
  type Keys,
  type KeySources,
  type LoadedKeys,
  type StopProcess,
} from "./cli.js";
export { LAUNCHD_PATH, adoptLoginPath, needsLoginPath, takeLoginPath, type LoginShellDeps } from "./login-path.js";
export { SECTION_BEGIN, SECTION_END, sectionText } from "./agents-md.js";
export { runBin } from "./entry.js";
export { type ProviderEnv } from "./providers.js";
export { shimPath } from "./shim.js";
export { agentsHere, type AgentHere } from "./agents-here.js";
export { installEach, mcpServerSpec, runningWsp, thisComputersPath, type InstallReport, type RunningWsp } from "./mcp-install.js";
export { dialAddress, hostLogPath, hostTokenFor, lockPathFor, ownPid, servingHost, type HostLock } from "./host-lock.js";
export { JoinRefused, joinCommand, placeHere, type JoinRefusalAbout } from "./places.js";
export { SERVING_HOME_SH, defaultHomeIn, homeNamed, servingHome } from "./serving-home.js";
export { accountAim, accountHosts, accountRecords, aimedAlias, aimedHost, aliasFrom, isUrl, listHosts, noSuchHostLine, readHost, removeHost, severalAccountHostsLine, writeHost, type AccountAim, type HostEntry, type HostRecord } from "./hosts.js";
export { addLines, hostNameHere, joinPlace, leavePlace, placeNameHere, placeStanding, placeWiring, type JoinPlaceOptions, type JoinedPlace } from "./places.js";
export { placeFilePath, placeKeyPath, placeReport, readPlaceFile, writePlaceFile, type PlaceSelfReport } from "./place-report.js";
export { DAEMON_BIN, DAEMON_TARGETS, GUEST_DAEMON_TARGETS, daemonArtifactName, daemonBinaryIn, daemonTargetHere, type DaemonTarget } from "./daemon-binary.js";
export { reachAddresses, type HereAt } from "./pairing.js";
export { dialHost, NO_PROJECT_YET } from "./verbs.js";
export {
  startCallbackRelay,
  systemOpener,
  RELAY_MIN_PORT,
  RELAY_WINDOW_MS,
  RELAY_CAP_MS,
  FORWARD_IDLE_MS,
  FORWARD_MAX_PER_TARGET,
  type CallbackRelay,
  type RelayOptions,
  type ForwardKind,
  type ForwardView,
  type UrlOpener,
} from "./relay.js";
export { GOLDEN_SETUP, GOLDEN_SMOKE } from "@wsp/catalog";
export { hostFolderRoots, hostFolders, importedProjectFolders, listHostFolders, type HostFolderPaths } from "./host-folders.js";
export { isCacheDir, isRepoFolder, packProject, packState, planProject, projectBundler, type BundleFile, type ProjectListing } from "./project-bundle.js";
export {
  doctor,
  deployDaemon,
  missingBundleFile,
  stageDaemonBundle,
  connectDaemonSocket,
  type DaemonSocket,
  type ConnectOptions,
  type DoctorOptions,
} from "./doctor.js";
