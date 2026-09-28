// SPDX-License-Identifier: AGPL-3.0-only
// Why a framed dev server shows white: the frame is on another origin, so
// the pane asks the host what one fetch of the route answered and names the
// host check that refused it. Vite reads the allowance the machine's
// environment sets on start; webpack-dev-server, Rails and Next.js have no
// environment route, only their config, so their sentence is the whole fix.
import { useEffect, useState } from "react";
import type { PortProbeView } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";
import { usePortReach, type PortReach } from "./reach.js";

export interface Refusal {
  readonly title: string;
  readonly detail: string;
  /** The answer may be the app's own page (a signed-out route, its own sign-in), so the sentence sits above the frame. */
  readonly keepsFrame: boolean;
}

const VITE_BLOCKED = /Blocked request\. This host \(.+\) is not allowed/;
const RAILS_BLOCKED = /Blocked hosts?:/;

export function explainRefusal(probe: PortProbeView, at: { port: number; host: string }): Refusal | null {
  if (probe.status === 401) {
    return {
      title: `:${at.port} answered 401 through the preview route`,
      detail: `The route refused a fresh token too: the host reminted it after the first 401 and reloaded once. If the server on :${at.port} asks for its own sign-in, this is its page; otherwise the preview edge is refusing this task.`,
      keepsFrame: true,
    };
  }
  if (probe.status !== 403) return null;
  const refused = `:${at.port} refused the preview host`;
  const body = probe.body.trim();
  if (VITE_BLOCKED.test(body)) {
    return {
      title: refused,
      detail: `Vite blocked the request because ${at.host} is not in server.allowedHosts. Restart the dev server so it picks up the allowance the task's environment already sets, or add the host to server.allowedHosts in vite.config.`,
      keepsFrame: false,
    };
  }
  if (body === "Invalid Host header") {
    return {
      title: refused,
      detail: `webpack-dev-server blocked the request because ${at.host} is not in devServer.allowedHosts. Add the host to devServer.allowedHosts in the webpack config, or start it with --allowed-hosts ${at.host}, and restart it.`,
      keepsFrame: false,
    };
  }
  if (RAILS_BLOCKED.test(body)) {
    return {
      title: refused,
      detail: `Rails blocked the request because ${at.host} is not in config.hosts. Add config.hosts << "${at.host}" to config/environments/development.rb and restart the server.`,
      keepsFrame: false,
    };
  }
  if (body === "Unauthorized") {
    return {
      title: refused,
      detail: `If this is Next.js, its dev server blocked a request from ${at.host}: add the host to allowedDevOrigins in next.config and restart it. Any server can answer 403 Unauthorized, so check the server's own log if that is not it.`,
      keepsFrame: false,
    };
  }
  return {
    title: `:${at.port} answered 403 through the preview route`,
    detail: `The server on :${at.port} refused ${at.host}. If it checks the Host header, allow that host in its config and restart it.`,
    keepsFrame: true,
  };
}

export interface ProbedRoute {
  readonly reach: PortReach;
  readonly refusal: Refusal | null;
}

/** The route for the port and what one fetch of it answered, asked once per route and per reload; a probe that fails
 * leaves the frame as the only truth. The first 401 of a load asks for a fresh route instead of a sentence, since the host
 * reminted it on that answer; the probe of the fresh route decides. */
export function useProbedRoute(workspaceId: string, port: number | null, reloadNonce: number): ProbedRoute {
  const api = useStore(s => s.api);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [reminted, setReminted] = useState<{ load: string; count: number } | null>(null);
  const load = `${port}:${reloadNonce}`;
  const remints = reminted?.load === load ? reminted.count : 0;
  const reach = usePortReach(workspaceId, port, remints);
  const url = reach.state === "ready" ? reach.reach.url : null;

  useEffect(() => {
    setRefusal(null);
    if (!api?.portProbe || port === null || url === null) return;
    let gone = false;
    api.portProbe(workspaceId, port).then(
      probe => {
        if (gone) return;
        if (probe.status === 401 && remints === 0) setReminted({ load, count: 1 });
        else setRefusal(explainRefusal(probe, { port, host: new URL(url).hostname }));
      },
      () => {},
    );
    return () => {
      gone = true;
    };
    // The reminted route arrives as a new url; asking again on the count too would probe the stale one once more.
  }, [api, workspaceId, port, url, reloadNonce]);

  return { reach, refusal };
}
