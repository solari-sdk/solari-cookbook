// SPDX-License-Identifier: AGPL-3.0-only
//! A workspace's network, as root: a veth pair whose box end is `wsp-<k>` and whose other end is `eth0` inside
//! the namespace youki made, one /30 out of one private range per box, NAT for what leaves the box, the box's own
//! resolvers handed in, and `host.wsp.internal` naming the veth gateway. Published ports are this daemon's own
//! listeners on the box's loopback, each dialing the workspace's address. Everything is the kernel's rtnetlink and
//! nf_tables spoken from here; no ip, iptables or nft binary runs. Each published port's listener dials the
//! workspace from inside its own network namespace, so a service bound to 127.0.0.1 in there is reached as well
//! as one bound to the workspace's address, and every byte through one of them is what this computer can see of
//! the workspace doing something.
//!
//! What a workspace reaches: its box at `host.wsp.internal`, and the world through the interface of the box's
//! default route and the NAT. Not the box's cloud metadata, not the box's other interfaces or what lies behind
//! them, not another workspace. The rules, as `nft list ruleset` shows them on a box whose default route is eth0:
//!
//! ```text
//! table ip wsp {
//!     chain forward { type filter hook forward priority -10; policy accept;
//!         iifname "wsp-*" ip daddr 169.254.0.0/16 drop            the box's cloud metadata is the box's
//!         iifname "wsp-*" oifname != "eth0" drop                   the world through the default route alone
//!         oifname "wsp-*" ct state established,related accept   answers come back in
//!         oifname "wsp-*" drop                                  nothing else reaches a workspace, its neighbours included
//!         iifname "eth0" oifname != "wsp-*" drop                 only where this daemon turned eth0's forwarding on
//!     }
//!     chain input { type filter hook input priority -10; policy accept;
//!         iifname "wsp-*" ct state established,related accept   answers to what the box asked for come back
//!         iifname "wsp-*" tcp dport 7070 drop                   this daemon's own door, whatever address it bound
//!         iifname "wsp-*" tcp dport 2375 drop                   the engine's, where a box exposes it
//!         iifname "wsp-*" tcp dport 2376 drop
//!         iifname "wsp-*" ip daddr != 10.65.0.0/16 drop         a workspace reaches its box at host.wsp.internal alone
//!     }
//!     chain postrouting { type nat hook postrouting priority srcnat; policy accept;
//!         ip saddr 10.65.0.0/16 oifname != "wsp-*" masquerade
//!     }
//! }
//! ```
//!
//! A workspace that asked for the box's container engine gets its containers on bridges of its own, named by the
//! fence under the same `wsp-` prefix, so every rule above reads them as it reads the workspace: the box's cloud
//! metadata and a neighbour are as far out of a container's reach as out of the workspace's. Frames between two
//! containers of one workspace cross the forward hook under the bridge netfilter the engine turns on, and the
//! one-road-out drop would take them, so each such bridge gets one rule of its own at the head of the forward
//! chain, `iifname "<bridge>" oifname "<bridge>" accept`, marked with a comment naming the bridge and the
//! workspace; it goes when the network does and with the workspace.
//!
//! Forwarding is turned on per interface, never for the box as a whole: on each `wsp-<k>` for what a workspace
//! sends, and on the default route's interface for the answers that come back, which is where the last rule above
//! comes from, so a box that forwarded nothing before forwards nothing between its other interfaces after.
//!
//! A box whose own firewall ends its input or forward chain in a refusal (ufw's policy drop, firewalld's final
//! reject) refuses the workspaces' packets there too, since an accept in one chain does not carry to the next; so
//! each such chain gets accepts for the workspace interfaces at its head, marked with a comment, as Docker puts its
//! jump at the head of FORWARD: on forward `iifname "wsp-*" accept` and `oifname "wsp-*" accept`, and on input two,
//! `iifname "wsp-*" ip daddr 10.65.0.0/16 accept` for the way to the box at `host.wsp.internal`, which a workspace
//! reaches by design, and `iifname "wsp-*" ct state established,related accept` for the answers a container's
//! published port sends back. The ports a workspace holds no business with are closed ahead of both in our own
//! input chain, whose lower priority puts its drops before any of this and ends the packet there whatever a
//! foreign chain accepts. The conntrack accept is written as the match iptables itself writes rather than the
//! kernel's own expression, since iptables refuses to render a chain holding one of those and the box's own
//! tooling reads these chains; a kernel that will not take it gets the native expression instead. They go with
//! the last workspace.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use netlink_packet_core::{NetlinkMessage, NetlinkPayload, NLM_F_ACK, NLM_F_CREATE, NLM_F_DUMP, NLM_F_EXCL, NLM_F_REQUEST};
use netlink_packet_route::address::{AddressAttribute, AddressMessage};
use netlink_packet_route::link::{InfoData, InfoKind, InfoVeth, LinkAttribute, LinkFlags, LinkInfo, LinkMessage};
use netlink_packet_route::route::{RouteAddress, RouteAttribute, RouteHeader, RouteMessage, RouteProtocol, RouteScope, RouteType};
use netlink_packet_route::{AddressFamily, RouteNetlinkMessage};
use netlink_sys::protocols::NETLINK_ROUTE;
use netlink_sys::{Socket, SocketAddr};
use nix::sched::{setns, CloneFlags};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::bundle::{self, Layout};
use crate::nft::{self, BaseChain, Conn, Expr};

/// The one private range every workspace on a box draws from.
pub const RANGE: Ipv4Addr = Ipv4Addr::new(10, 65, 0, 0);
pub const RANGE_PREFIX: u8 = 16;
/// Each workspace gets a /30: the network, the gateway on the box, the workspace, broadcast.
const BLOCK_PREFIX: u8 = 30;
const FIRST_INDEX: u16 = 1;
const LAST_INDEX: u16 = 16382;
/// The box end of every pair, which is also what the rules match on.
pub const LINK_PREFIX: &str = "wsp-";
/// What a workspace calls its own end.
pub const INSIDE_LINK: &str = "eth0";
/// The name a turn inside dials the box at.
pub const HOST_NAME: &str = "host.wsp.internal";
pub const TABLE: &str = "wsp";
/// The comment on every rule this daemon writes into a chain that is not its own, which is how it finds them again.
pub const RULE_COMMENT: &str = "wsp workspaces";
/// What the comment on one engine bridge's rule begins with; the bridge and the workspace follow, so the rule
/// goes with its own network and a workspace's remove takes every one of them.
const BRIDGE_COMMENT: &str = "wsp workspaces: engine bridge ";
/// The pair the self check makes and removes, named outside the prefix so no sweep takes it for a workspace's.
const CHECK_LINK: &str = "wspcheck0";
const CHECK_PEER: &str = "wspcheck1";
/// The cloud metadata services live here (169.254.169.254 on every provider), and the range is link local: nothing
/// a workspace has business with.
pub const METADATA_RANGE: Ipv4Addr = Ipv4Addr::new(169, 254, 0, 0);
pub const METADATA_PREFIX: u8 = 16;
/// The comment on the guard rule, naming the interface whose forwarding this daemon turned on, so the teardown
/// turns it back off.
const FORWARDING_COMMENT: &str = "wsp workspaces: forwarding turned on for ";
/// What the comment on one gateway port's drop begins with; the port follows, so a daemon that bound another one
/// reads its own table as no longer the table it writes.
const GATEWAY_COMMENT: &str = "wsp workspaces: gateway port ";
/// The engine's own TCP ports, which a box exposing either would be exposing to every workspace on it.
const ENGINE_PORTS: [u16; 2] = [2375, 2376];
/// IFALIASZ less the NUL: the most an alias holds.
const ALIAS_MAX: usize = 255;
const NF_IP_PRI_NAT_SRC: i32 = 100;
const OUR_PRIORITY: i32 = -10;
const ENODEV: i32 = 19;

/// What a workspace's network is, kept beside its record so a daemon restart finds it and its forwards again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub link: String,
    pub address: Ipv4Addr,
    pub gateway: Ipv4Addr,
    pub prefix: u8,
    /// Workspace port to the port on the box's loopback that dials it.
    #[serde(default)]
    pub forwards: BTreeMap<u16, u16>,
}

#[derive(Debug)]
pub struct Error {
    pub what: String,
    pub source: io::Error,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.what, self.source)
    }
}

impl std::error::Error for Error {}

impl From<nft::Error> for Error {
    fn from(e: nft::Error) -> Error {
        Error { what: e.what, source: e.source }
    }
}

impl From<bundle::Error> for Error {
    fn from(e: bundle::Error) -> Error {
        Error { what: e.path.display().to_string(), source: e.source }
    }
}

fn at(what: impl Into<String>) -> impl FnOnce(io::Error) -> Error {
    move |source| Error { what: what.into(), source }
}

fn nix_at(what: impl Into<String>) -> impl FnOnce(nix::Error) -> Error {
    move |e| Error { what: what.into(), source: io::Error::from(e) }
}

/// The gateway and the workspace address of block k.
pub fn block(index: u16) -> (Ipv4Addr, Ipv4Addr) {
    let base = u32::from(RANGE) + 4 * u32::from(index);
    (Ipv4Addr::from(base + 1), Ipv4Addr::from(base + 2))
}

pub fn link_name(index: u16) -> String {
    format!("{LINK_PREFIX}{index}")
}

fn index_of_link(name: &str) -> Option<u16> {
    name.strip_prefix(LINK_PREFIX)?.parse().ok()
}

/// The lowest block no link on the box holds.
fn free_index(taken: impl Iterator<Item = u16>) -> Option<u16> {
    let held: std::collections::BTreeSet<u16> = taken.collect();
    (FIRST_INDEX..=LAST_INDEX).find(|k| !held.contains(k))
}

/// What the sweep at open took away.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Swept {
    pub links: Vec<String>,
    pub rules: bool,
}

/// One link on the box as rtnetlink lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub index: u32,
    pub name: String,
    pub alias: Option<String>,
}

/// One rtnetlink socket, in whatever network namespace the thread that opened it was in.
pub struct Route {
    socket: Socket,
    seq: u32,
}

impl Route {
    pub fn open() -> Result<Route, Error> {
        let mut socket = Socket::new(NETLINK_ROUTE).map_err(at("opening the route socket"))?;
        socket.bind_auto().map_err(at("binding the route socket"))?;
        Ok(Route { socket, seq: 1 })
    }

    /// One request and everything it answers; an ack or a done ends it, an error names its errno.
    fn request(&mut self, message: RouteNetlinkMessage, flags: u16, what: &str) -> Result<Vec<RouteNetlinkMessage>, Error> {
        self.seq = self.seq.wrapping_add(1);
        let mut packet = NetlinkMessage::from(message);
        packet.header.flags = flags;
        packet.header.sequence_number = self.seq;
        packet.finalize();
        let mut bytes = vec![0u8; packet.header.length as usize];
        packet.serialize(&mut bytes);
        self.socket.send_to(&bytes, &SocketAddr::new(0, 0), 0).map_err(at(what.to_owned()))?;
        let mut out = Vec::new();
        loop {
            let (datagram, _) = self.socket.recv_from_full().map_err(at(what.to_owned()))?;
            let mut offset = 0;
            while offset < datagram.len() {
                let packet = NetlinkMessage::<RouteNetlinkMessage>::deserialize(&datagram[offset..])
                    .map_err(|e| Error { what: what.to_owned(), source: io::Error::other(e.to_string()) })?;
                let length = packet.header.length as usize;
                if length == 0 {
                    break;
                }
                offset += length;
                if packet.header.sequence_number != self.seq {
                    continue;
                }
                match packet.payload {
                    NetlinkPayload::Error(e) => {
                        return match e.code {
                            Some(code) => Err(Error { what: what.to_owned(), source: io::Error::from_raw_os_error(-code.get()) }),
                            None => Ok(out),
                        };
                    }
                    NetlinkPayload::Done(_) => return Ok(out),
                    NetlinkPayload::InnerMessage(m) => out.push(m),
                    _ => {}
                }
            }
        }
    }

    pub fn links(&mut self) -> Result<Vec<Link>, Error> {
        let rows = self.request(RouteNetlinkMessage::GetLink(LinkMessage::default()), NLM_F_REQUEST | NLM_F_DUMP, "listing the links")?;
        Ok(rows
            .into_iter()
            .filter_map(|row| match row {
                RouteNetlinkMessage::NewLink(m) => {
                    let mut link = Link { index: m.header.index, name: String::new(), alias: None };
                    for a in m.attributes {
                        match a {
                            LinkAttribute::IfName(name) => link.name = name,
                            LinkAttribute::IfAlias(alias) => link.alias = Some(alias),
                            _ => {}
                        }
                    }
                    Some(link)
                }
                _ => None,
            })
            .collect())
    }

    pub fn index_of(&mut self, name: &str) -> Result<u32, Error> {
        self.links()?
            .into_iter()
            .find(|l| l.name == name)
            .map(|l| l.index)
            .ok_or_else(|| Error { what: format!("link {name}"), source: io::Error::from(io::ErrorKind::NotFound) })
    }

    /// A veth pair: `name` here, `peer` in the namespace the fd names, or here too when none is given.
    pub fn add_veth(&mut self, name: &str, peer: &str, peer_ns: Option<i32>) -> Result<(), Error> {
        let mut other = LinkMessage::default();
        other.attributes.push(LinkAttribute::IfName(peer.to_owned()));
        if let Some(fd) = peer_ns {
            other.attributes.push(LinkAttribute::NetNsFd(fd));
        }
        let mut message = LinkMessage::default();
        message.attributes.push(LinkAttribute::IfName(name.to_owned()));
        message
            .attributes
            .push(LinkAttribute::LinkInfo(vec![LinkInfo::Kind(InfoKind::Veth), LinkInfo::Data(InfoData::Veth(InfoVeth::Peer(other)))]));
        self.request(
            RouteNetlinkMessage::NewLink(message),
            NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL,
            &format!("making the veth pair {name}"),
        )?;
        Ok(())
    }

    pub fn set_alias(&mut self, index: u32, alias: &str) -> Result<(), Error> {
        if alias.len() > ALIAS_MAX {
            return Err(Error {
                what: format!("naming link {index}"),
                source: io::Error::other(format!("{alias} is {} bytes, and a link alias holds {ALIAS_MAX}", alias.len())),
            });
        }
        let mut message = LinkMessage::default();
        message.header.index = index;
        message.attributes.push(LinkAttribute::IfAlias(alias.to_owned()));
        self.request(RouteNetlinkMessage::SetLink(message), NLM_F_REQUEST | NLM_F_ACK, &format!("naming link {index} for {alias}"))?;
        Ok(())
    }

    pub fn set_up(&mut self, index: u32) -> Result<(), Error> {
        let mut message = LinkMessage::default();
        message.header.index = index;
        message.header.flags = LinkFlags::Up;
        message.header.change_mask = LinkFlags::Up;
        self.request(RouteNetlinkMessage::SetLink(message), NLM_F_REQUEST | NLM_F_ACK, &format!("bringing link {index} up"))?;
        Ok(())
    }

    pub fn add_address(&mut self, index: u32, address: Ipv4Addr, prefix: u8) -> Result<(), Error> {
        let mut message = AddressMessage::default();
        message.header.family = AddressFamily::Inet;
        message.header.prefix_len = prefix;
        message.header.index = index;
        message.attributes.push(AddressAttribute::Local(address.into()));
        message.attributes.push(AddressAttribute::Address(address.into()));
        self.request(
            RouteNetlinkMessage::NewAddress(message),
            NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL,
            &format!("giving link {index} the address {address}/{prefix}"),
        )?;
        Ok(())
    }

    /// The interface of the box's default route, the one with the lowest metric where there are several; none on a
    /// box with no way out.
    pub fn default_interface(&mut self) -> Result<Option<String>, Error> {
        let mut request = RouteMessage::default();
        request.header.address_family = AddressFamily::Inet;
        let rows = self.request(RouteNetlinkMessage::GetRoute(request), NLM_F_REQUEST | NLM_F_DUMP, "listing the routes")?;
        let mut best: Option<(u32, u32)> = None;
        for row in rows {
            let RouteNetlinkMessage::NewRoute(route) = row else { continue };
            if route.header.destination_prefix_length != 0
                || route.header.table != RouteHeader::RT_TABLE_MAIN
                || route.header.kind != RouteType::Unicast
            {
                continue;
            }
            let mut oif = None;
            let mut metric = 0;
            for a in &route.attributes {
                match a {
                    RouteAttribute::Oif(index) => oif = Some(*index),
                    RouteAttribute::Priority(p) => metric = *p,
                    _ => {}
                }
            }
            if let Some(index) = oif {
                if best.is_none_or(|(m, _)| metric < m) {
                    best = Some((metric, index));
                }
            }
        }
        let Some((_, index)) = best else { return Ok(None) };
        Ok(self.links()?.into_iter().find(|l| l.index == index).map(|l| l.name))
    }

    pub fn add_default_route(&mut self, gateway: Ipv4Addr) -> Result<(), Error> {
        let mut message = RouteMessage::default();
        message.header.address_family = AddressFamily::Inet;
        message.header.table = RouteHeader::RT_TABLE_MAIN;
        message.header.protocol = RouteProtocol::Boot;
        message.header.scope = RouteScope::Universe;
        message.header.kind = RouteType::Unicast;
        message.attributes.push(RouteAttribute::Gateway(RouteAddress::Inet(gateway)));
        self.request(
            RouteNetlinkMessage::NewRoute(message),
            NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL,
            &format!("routing through {gateway}"),
        )?;
        Ok(())
    }

    /// Removes the link; one that went between the listing and this call (a namespace dying takes its pair with
    /// it a moment after its last process) is what was asked for, and reads false.
    pub fn delete(&mut self, index: u32) -> Result<bool, Error> {
        let mut message = LinkMessage::default();
        message.header.index = index;
        match self.request(RouteNetlinkMessage::DelLink(message), NLM_F_REQUEST | NLM_F_ACK, &format!("removing link {index}")) {
            Ok(_) => Ok(true),
            Err(e) if e.source.raw_os_error() == Some(ENODEV) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Removes the link by name; one that is already gone is what was asked for.
    pub fn delete_named(&mut self, name: &str) -> Result<bool, Error> {
        match self.links()?.into_iter().find(|l| l.name == name) {
            Some(link) => self.delete(link.index),
            None => Ok(false),
        }
    }
}

/// Runs the work on a thread that has entered the network namespace, so this process's own threads never leave
/// theirs. A namespace is a thread's, and the thread ends with the work.
pub fn inside(ns: fs::File, work: impl FnOnce(&mut Route) -> Result<(), Error> + Send + 'static) -> Result<(), Error> {
    inside_with(ns, move || work(&mut Route::open()?))
}

/// The same, for work that answers something: a socket bound inside stays in that namespace whichever thread
/// serves it afterwards.
pub fn inside_with<T: Send + 'static>(ns: fs::File, work: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Result<T, Error> {
    let handle = std::thread::Builder::new()
        .name("wsp-netns".into())
        .spawn(move || -> Result<T, Error> {
            setns(&ns, CloneFlags::CLONE_NEWNET).map_err(nix_at("entering the workspace's network namespace"))?;
            work()
        })
        .map_err(at("starting the namespace thread"))?;
    handle.join().map_err(|_| Error { what: "the namespace thread".into(), source: io::Error::other("ended without an answer") })?
}

fn is_root() -> bool {
    nix::unistd::geteuid().is_root()
}

fn forwarding_file(iface: &str) -> String {
    format!("/proc/sys/net/ipv4/conf/{iface}/forwarding")
}

/// Turns forwarding on for one interface, and answers whether it was off: a box's own setting is left as found,
/// what this daemon turned on is its to turn off.
fn turn_forwarding_on(iface: &str) -> Result<bool, Error> {
    let file = forwarding_file(iface);
    if fs::read_to_string(&file).map_err(at(file.clone()))?.trim() == "1" {
        return Ok(false);
    }
    fs::write(&file, "1").map_err(at(file))?;
    Ok(true)
}

/// The interface a guard rule's comment names.
fn guarded_interface(comment: &str) -> Option<&str> {
    comment.strip_prefix(FORWARDING_COMMENT)
}

/// The TCP ports a workspace reaches at its gateway on no address: this daemon's own door, which it binds on the
/// wildcard address on a fork and which a workspace holds no token for, and the engine's two, which a box that
/// exposes either exposes to every workspace on it. A daemon that bound no port names none.
pub fn gateway_drops(daemon_port: u16) -> Vec<u16> {
    let mut ports: Vec<u16> = std::iter::once(daemon_port).filter(|port| *port != 0).collect();
    for port in ENGINE_PORTS {
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    ports
}

/// The rules of our own table, appended in order. `default` is the interface of the box's default route, the one
/// road out; `guard` is that interface where this daemon turned its forwarding on, so nothing arriving on it is
/// forwarded anywhere but into a workspace; `daemon_port` is the port this daemon bound, which no workspace
/// reaches at the gateway.
fn own_rules(default: Option<&str>, guard: Option<&str>, daemon_port: u16) -> Vec<nft::Msg> {
    let table = TABLE;
    let rule = |chain: &str, exprs: Vec<Expr>, comment: &str| nft::new_rule(nft::NFPROTO_IPV4, table, chain, &exprs, comment, false);
    let mut rules = Vec::new();
    let mut metadata: Vec<Expr> = nft::iifname_starts(LINK_PREFIX).into();
    metadata.extend(nft::ip_addr_in(true, METADATA_RANGE, METADATA_PREFIX, false));
    metadata.push(nft::verdict(nft::NF_DROP));
    rules.push(rule("forward", metadata, RULE_COMMENT));
    let mut one_road: Vec<Expr> = nft::iifname_starts(LINK_PREFIX).into();
    if let Some(default) = default {
        one_road.extend(nft::oifname_is_not(default));
    }
    one_road.push(nft::verdict(nft::NF_DROP));
    rules.push(rule("forward", one_road, RULE_COMMENT));
    let mut answers: Vec<Expr> = nft::oifname_starts(LINK_PREFIX).into();
    answers.extend(nft::ct_established_or_related());
    answers.push(nft::verdict(nft::NF_ACCEPT));
    rules.push(rule("forward", answers, RULE_COMMENT));
    let mut nothing_else: Vec<Expr> = nft::oifname_starts(LINK_PREFIX).into();
    nothing_else.push(nft::verdict(nft::NF_DROP));
    rules.push(rule("forward", nothing_else, RULE_COMMENT));
    if let Some(guard) = guard {
        let mut only_into: Vec<Expr> = nft::iifname_is(guard).into();
        only_into.extend(nft::oifname_not_starts(LINK_PREFIX));
        only_into.push(nft::verdict(nft::NF_DROP));
        rules.push(rule("forward", only_into, &format!("{FORWARDING_COMMENT}{guard}")));
    }
    // Ahead of the drops below: a container of a workspace's own publishes a port the engine binds out on the
    // box's loopback, and the answer it sends back crosses this hook from a bridge under the same prefix.
    let mut answers_in: Vec<Expr> = nft::iifname_starts(LINK_PREFIX).into();
    answers_in.extend(nft::ct_established_or_related());
    answers_in.push(nft::verdict(nft::NF_ACCEPT));
    rules.push(rule("input", answers_in, RULE_COMMENT));
    // Ahead of the reach the threat model names: the box at host.wsp.internal answers a workspace, less the
    // ports its own daemon and its own engine serve, which a workspace holds no business with and no token for.
    for port in gateway_drops(daemon_port) {
        let mut closed: Vec<Expr> = nft::iifname_starts(LINK_PREFIX).into();
        closed.extend(nft::l4proto_tcp());
        closed.extend(nft::tcp_dport_is(port));
        closed.push(nft::verdict(nft::NF_DROP));
        rules.push(rule("input", closed, &format!("{GATEWAY_COMMENT}{port}")));
    }
    let mut gateway_only: Vec<Expr> = nft::iifname_starts(LINK_PREFIX).into();
    gateway_only.extend(nft::ip_addr_in(true, RANGE, RANGE_PREFIX, true));
    gateway_only.push(nft::verdict(nft::NF_DROP));
    rules.push(rule("input", gateway_only, RULE_COMMENT));
    let mut nat: Vec<Expr> = nft::ip_addr_in(false, RANGE, RANGE_PREFIX, false).into();
    nat.extend(nft::oifname_not_starts(LINK_PREFIX));
    nat.push(nft::masquerade());
    rules.push(rule("postrouting", nat, RULE_COMMENT));
    rules
}

/// The comment on one engine bridge's rule: the bridge, so the rule goes with its own network, and the
/// workspace, so a remove takes every one of them.
fn bridge_comment(bridge: &str, id: &str) -> String {
    format!("{BRIDGE_COMMENT}{bridge} of {id}")
}

/// The bridge and the workspace such a comment names.
fn bridged(comment: &str) -> Option<(&str, &str)> {
    comment.strip_prefix(BRIDGE_COMMENT)?.split_once(" of ")
}

/// The rule one engine bridge gets at the head of our own forward chain: two containers of one workspace reach
/// each other across it, and the one-road-out drop below takes everything else it carries.
fn bridge_rule(bridge: &str, id: &str) -> nft::Msg {
    let mut exprs: Vec<Expr> = nft::iifname_is(bridge).into();
    exprs.extend(nft::oifname_is(bridge));
    exprs.push(nft::verdict(nft::NF_ACCEPT));
    nft::new_rule(nft::NFPROTO_IPV4, TABLE, "forward", &exprs, &bridge_comment(bridge, id), true)
}

fn own_table(default: Option<&str>, guard: Option<&str>, daemon_port: u16) -> Vec<nft::Msg> {
    let chain = |name, kind, hook, priority| BaseChain {
        family: nft::NFPROTO_IPV4,
        table: TABLE,
        name,
        kind,
        hook,
        priority,
        policy: nft::NF_ACCEPT,
    };
    let mut msgs = vec![
        nft::new_table(nft::NFPROTO_IPV4, TABLE),
        nft::new_chain(&chain("forward", "filter", nft::NF_INET_FORWARD, OUR_PRIORITY)),
        nft::new_chain(&chain("input", "filter", nft::NF_INET_LOCAL_IN, OUR_PRIORITY)),
        nft::new_chain(&chain("postrouting", "nat", nft::NF_INET_POST_ROUTING, NF_IP_PRI_NAT_SRC)),
    ];
    msgs.extend(own_rules(default, guard, daemon_port));
    msgs
}

/// Whether a chain is another firewall's base chain on a hook the workspaces' packets cross.
fn is_a_foreign_filter(chain: &nft::ChainRow) -> bool {
    chain.table != TABLE
        && (chain.family == nft::NFPROTO_IPV4 || chain.family == nft::NFPROTO_INET)
        && chain.kind.as_deref() == Some("filter")
        && matches!(chain.hook, Some(nft::NF_INET_LOCAL_IN | nft::NF_INET_FORWARD))
}

/// Whether such a chain refuses what reaches its end: a drop policy (ufw), or a last rule that refuses everything
/// (firewalld's `reject with icmpx admin-prohibited` under a policy of accept).
fn refuses_at_its_end(chain: &nft::ChainRow, rules: &[nft::RuleRow]) -> bool {
    is_a_foreign_filter(chain) && (chain.policy == Some(nft::NF_DROP) || rules.last().is_some_and(nft::RuleRow::refuses_all))
}

/// The accepts a refusing chain gets at its head, for its hook. On input two: the way a workspace's own packets
/// to its gateway take, which is the reach a workspace has by design, and the return path the answers of a
/// published port take, addressed to the box's loopback and not to the range. `as_iptables_writes_it` picks the
/// encoding of the conntrack match, the one iptables renders or the kernel's own, which a box whose kernel
/// refuses the first gets instead.
fn accepts_for(chain: &nft::ChainRow, as_iptables_writes_it: bool) -> Vec<nft::Msg> {
    let rule = |exprs: Vec<Expr>| nft::new_rule(chain.family, &chain.table, &chain.name, &exprs, RULE_COMMENT, true);
    if chain.hook == Some(nft::NF_INET_LOCAL_IN) {
        let from_a_workspace = || {
            let mut exprs: Vec<Expr> = Vec::new();
            if chain.family == nft::NFPROTO_INET {
                exprs.extend(nft::nfproto_ipv4());
            }
            exprs.extend(nft::iifname_starts(LINK_PREFIX));
            exprs
        };
        let mut to_the_gateway = from_a_workspace();
        to_the_gateway.extend(nft::ip_addr_in(true, RANGE, RANGE_PREFIX, false));
        to_the_gateway.push(nft::verdict(nft::NF_ACCEPT));
        let mut answers = from_a_workspace();
        if as_iptables_writes_it {
            answers.push(nft::xt_ct_established_or_related());
        } else {
            answers.extend(nft::ct_established_or_related());
        }
        answers.push(nft::verdict(nft::NF_ACCEPT));
        return vec![rule(to_the_gateway), rule(answers)];
    }
    // Plain interface matches alone: iptables renders those and refuses a chain holding a native conntrack rule,
    // and what reaches a workspace here already passed our own chain, which lets answers through and nothing else.
    let mut out: Vec<Expr> = nft::iifname_starts(LINK_PREFIX).into();
    out.push(nft::verdict(nft::NF_ACCEPT));
    let mut back: Vec<Expr> = nft::oifname_starts(LINK_PREFIX).into();
    back.push(nft::verdict(nft::NF_ACCEPT));
    vec![rule(out), rule(back)]
}

/// Whether the table the kernel holds is the table this daemon would write now: the rules of each of our chains
/// by their expressions and their comments, in the order they are appended, less the engine bridge rules, which
/// come and go with the networks they were written for. A daemon that landed new rules replaces the table rather
/// than leaving a box whose workspaces are running on the rules of the daemon before it.
fn table_differs(conn: &mut Conn, default: Option<&str>, guard: Option<&str>, daemon_port: u16) -> Result<bool, Error> {
    let wanted: Vec<(String, Vec<String>, Option<String>)> =
        own_rules(default, guard, daemon_port).iter().filter_map(nft::shape_of).collect();
    let mut held = Vec::new();
    for chain in ["forward", "input", "postrouting"] {
        for rule in conn.rules(nft::NFPROTO_IPV4, TABLE, chain)? {
            if rule.comment.as_deref().and_then(bridged).is_some() {
                continue;
            }
            held.push((chain.to_owned(), rule.exprs, rule.comment));
        }
    }
    Ok(held != wanted)
}

/// Whether the marked rules a refusing chain already holds are the accepts this daemon writes for it, in either
/// encoding of the conntrack match, in whatever order the head insertion left them. A chain holding accepts of
/// an older shape has them replaced rather than kept: the rules of the daemon before this one would otherwise
/// stand until the box's last workspace stops.
fn accepts_stand(chain: &nft::ChainRow, held: &[nft::RuleRow]) -> bool {
    let mut ours: Vec<Vec<String>> = held.iter().filter(|r| r.comment.as_deref() == Some(RULE_COMMENT)).map(|r| r.exprs.clone()).collect();
    ours.sort();
    [true, false].into_iter().any(|as_iptables_writes_it| {
        let mut wanted: Vec<Vec<String>> =
            accepts_for(chain, as_iptables_writes_it).iter().filter_map(nft::shape_of).map(|(_, exprs, _)| exprs).collect();
        wanted.sort();
        ours == wanted
    })
}

/// Puts the table and the accepts in place where they are not, and replaces the table where its rules are not
/// the ones this daemon writes. The table is written with the default route as it is at that moment, and
/// forwarding on its interface turned on where it was off; a replacement keeps the guard the standing table
/// named, since the forwarding it turned on is still on, and writes every engine bridge rule again.
pub fn rules_up(daemon_port: u16) -> Result<(), Error> {
    let mut conn = Conn::open()?;
    let mut table = Vec::new();
    if conn.tables()?.contains(&(nft::NFPROTO_IPV4, TABLE.to_owned())) {
        let standing = conn.rules(nft::NFPROTO_IPV4, TABLE, "forward")?;
        let guard = standing.iter().find_map(|r| r.comment.as_deref().and_then(guarded_interface).map(str::to_owned));
        let default = Route::open()?.default_interface()?;
        if table_differs(&mut conn, default.as_deref(), guard.as_deref(), daemon_port)? {
            table.push(nft::del_table(nft::NFPROTO_IPV4, TABLE));
            table.extend(own_table(default.as_deref(), guard.as_deref(), daemon_port));
            for rule in &standing {
                if let Some((bridge, id)) = rule.comment.as_deref().and_then(bridged) {
                    table.push(bridge_rule(bridge, id));
                }
            }
        }
    } else {
        let default = Route::open()?.default_interface()?;
        let guard = match &default {
            Some(iface) => turn_forwarding_on(iface)?.then_some(iface.as_str()),
            None => None,
        };
        table.extend(own_table(default.as_deref(), guard, daemon_port));
    }
    let mut refusing = Vec::new();
    for chain in conn.chains()? {
        if !is_a_foreign_filter(&chain) {
            continue;
        }
        let rules = conn.rules(chain.family, &chain.table, &chain.name)?;
        if !refuses_at_its_end(&chain, &rules) || accepts_stand(&chain, &rules) {
            continue;
        }
        let older: Vec<nft::Msg> = rules
            .iter()
            .filter(|r| r.comment.as_deref() == Some(RULE_COMMENT))
            .map(|r| nft::del_rule(chain.family, &chain.table, &chain.name, r.handle))
            .collect();
        refusing.push((chain, older));
    }
    let batch = |as_iptables_writes_it: bool| {
        let mut all = table.clone();
        for (chain, older) in &refusing {
            all.extend(older.iter().cloned());
            all.extend(accepts_for(chain, as_iptables_writes_it));
        }
        all
    };
    match conn.batch(&batch(true), "writing the workspace rules") {
        Ok(()) => Ok(()),
        // A kernel with no compat module for the conntrack match iptables writes refuses the whole batch; the
        // native expression it always takes goes in instead, and iptables stops rendering that one chain.
        Err(refused) if !refusing.is_empty() => conn.batch(&batch(false), "writing the workspace rules").map_err(|_| Error::from(refused)),
        Err(refused) => Err(refused.into()),
    }
}

/// Takes the table and every marked accept away, and turns forwarding back off where this daemon turned it on.
/// The removal is one batch, so a kernel that refuses it lands none of it; where a teardown racing this one took
/// the same rules away first, its handles are gone and the batch is refused for that alone, and the goal, wsp's
/// rules off this box, is reached all the same. So a refusal is read against the ruleset rather than reported as
/// it comes: it is an error only where something of ours still stands.
pub fn rules_down() -> Result<(), Error> {
    let mut conn = Conn::open()?;
    let mut batch = Vec::new();
    for chain in conn.chains()? {
        if chain.table == TABLE {
            continue;
        }
        for rule in conn.rules(chain.family, &chain.table, &chain.name)? {
            if rule.comment.as_deref() == Some(RULE_COMMENT) {
                batch.push(nft::del_rule(chain.family, &chain.table, &chain.name, rule.handle));
            }
        }
    }
    let mut turned_on = Vec::new();
    if conn.tables()?.contains(&(nft::NFPROTO_IPV4, TABLE.to_owned())) {
        for rule in conn.rules(nft::NFPROTO_IPV4, TABLE, "forward")? {
            if let Some(iface) = rule.comment.as_deref().and_then(guarded_interface) {
                turned_on.push(iface.to_owned());
            }
        }
        batch.push(nft::del_table(nft::NFPROTO_IPV4, TABLE));
    }
    if let Err(refused) = conn.batch(&batch, "removing the workspace rules") {
        if rules_present()? {
            return Err(refused.into());
        }
    }
    for iface in turned_on {
        let file = forwarding_file(&iface);
        match fs::write(&file, "0") {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(at(file)(e)),
        }
    }
    Ok(())
}

/// Whether anything of ours is in the kernel's ruleset: the table, or a marked accept in another chain.
pub fn rules_present() -> Result<bool, Error> {
    let mut conn = Conn::open()?;
    if conn.tables()?.contains(&(nft::NFPROTO_IPV4, TABLE.to_owned())) {
        return Ok(true);
    }
    for chain in conn.chains()? {
        if conn.rules(chain.family, &chain.table, &chain.name)?.iter().any(|r| r.comment.as_deref() == Some(RULE_COMMENT)) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The kernel facts a workspace's network needs, each refusal one sentence for the doctor.
pub fn check() -> Result<(), String> {
    if !is_root() {
        return Err(format!("this daemon runs as uid {}; wsp runs workspaces on a computer as root", nix::unistd::geteuid()));
    }
    Conn::open()
        .and_then(|mut c| c.generation())
        .map_err(|e| format!("this computer's kernel has no nftables, which wsp needs to give a workspace a network: {e}"))?;
    let pair = (|| -> Result<(), Error> {
        let mut route = Route::open()?;
        route.add_veth(CHECK_LINK, CHECK_PEER, None)?;
        route.delete_named(CHECK_LINK)?;
        Ok(())
    })();
    pair.map_err(|e| format!("this computer's kernel makes no veth pair, which wsp needs to give a workspace a network: {e}"))
}

/// How long a workspace has been quiet by what the computer running it can see: the last byte through one of its
/// published ports, or the last command run in it. Nothing else is in it, since nothing else of a workspace is
/// this computer's to see: a turn's own work reaches the host as the turn's own events.
///
/// Counted off a monotonic clock, so the box's own wall clock being set while a workspace runs never moves the
/// figure, and counted from the moment the clock was made, which is the workspace's boot: one nothing has asked
/// anything of since it came up reads its whole life as quiet, which is what makes a workspace booted and left
/// alone stop at its first window.
pub struct Quiet {
    since: Instant,
    /// Milliseconds after `since` of the last thing this computer saw.
    seen_ms: AtomicU64,
}

impl Quiet {
    fn new() -> Quiet {
        Quiet { since: Instant::now(), seen_ms: AtomicU64::new(0) }
    }

    /// The workspace did something: the clock starts over. Taken as the later of what two readers write, since
    /// two bytes on two connections are read in whatever order the runtime gets to them.
    pub fn touch(&self) {
        self.seen_ms.fetch_max(self.since.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    pub fn quiet_for(&self) -> Duration {
        let now = self.since.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.seen_ms.load(Ordering::Relaxed)))
    }
}

/// A stream every byte of which is a byte through a published port: each read and each write starts the
/// workspace's quiet clock over. Wrapped around the connection on the box's side of the copy, so both directions
/// go through it.
struct Counted<S> {
    inner: S,
    quiet: Arc<Quiet>,
}

impl<S: AsyncRead + Unpin> AsyncRead for Counted<S> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        let held = buf.filled().len();
        let polled = Pin::new(&mut me.inner).poll_read(cx, buf);
        if buf.filled().len() > held {
            me.quiet.touch();
        }
        polled
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Counted<S> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let me = self.get_mut();
        let polled = Pin::new(&mut me.inner).poll_write(cx, buf);
        if matches!(polled, Poll::Ready(Ok(written)) if written > 0) {
            me.quiet.touch();
        }
        polled
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// Where a listener sends what it accepts.
enum Dial {
    /// A port inside the workspace, dialled from inside its own network namespace: a service bound to 127.0.0.1
    /// in there is reached, which is what a dev server started with no address of its own binds, and so is one
    /// bound to the workspace's own address. The namespace is the init's, and a stop takes every listener with
    /// it, so the pid here is the live one for as long as the listener holding it is bound.
    Inside { pid: i32, port: u16 },
    /// A port on the box's own loopback, dialled from here: how a workspace reaches a port its own containers
    /// published, which the engine bound out here.
    Box(SocketAddrV4),
    /// Nowhere yet: a port published while its workspace was stopped. The box port is held so nothing else on the
    /// box takes it before the wake, and a connection to it is taken and closed with no byte, since a stopped
    /// workspace has no namespace to dial. The wake's own restore is what gives it one.
    Nowhere,
}

impl Dial {
    async fn connect(&self) -> io::Result<TcpStream> {
        match *self {
            Dial::Nowhere => {
                Err(io::Error::new(io::ErrorKind::NotConnected, "this workspace is stopped, so its published port dials nothing"))
            }
            Dial::Box(addr) => TcpStream::connect(addr).await,
            Dial::Inside { pid, port } => {
                let ns_path = format!("/proc/{pid}/ns/net");
                let dialled = tokio::task::spawn_blocking(move || -> io::Result<std::net::TcpStream> {
                    let ns = fs::File::open(&ns_path)?;
                    inside_with(ns, move || {
                        std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).map_err(at(format!("dialling 127.0.0.1:{port} inside")))
                    })
                    .map_err(|e| io::Error::other(e.to_string()))
                })
                .await
                .map_err(io::Error::other)??;
                dialled.set_nonblocking(true)?;
                TcpStream::from_std(dialled)
            }
        }
    }
}

struct Listener {
    box_port: u16,
    task: JoinHandle<()>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The networks of every workspace under one root.
pub struct Net {
    layout: Layout,
    /// The port this computer's own daemon bound, which no workspace reaches at its gateway.
    daemon_port: u16,
    /// One turn at a time on the kernel's tables and links, since a block is picked by reading what is there.
    turn: Mutex<()>,
    listeners: Mutex<BTreeMap<String, BTreeMap<u16, Listener>>>,
    /// Listeners on every address a workspace has, inside its namespace, each dialing a port on the box's loopback:
    /// how its containers' published ports are reached at the port it asked for. Keyed by the port inside; not
    /// recorded, since a wake and a daemon restart read them off the engine again.
    inward: Mutex<BTreeMap<String, BTreeMap<u16, Listener>>>,
    /// The quiet clock of every workspace this daemon booted or found running, one each. A plain lock: every turn
    /// on it is a lookup, and the reading a client asks for is answered off the runtime thread.
    quiet: std::sync::Mutex<BTreeMap<String, Arc<Quiet>>>,
}

impl Net {
    /// Opens the networks under the root and, as root, sweeps what belongs to no running workspace: a link whose
    /// alias names a workspace dir under this root that is not running goes, and once no workspace link is left on
    /// the box the rules go too. Not root: nothing here was made, so nothing is touched.
    pub fn open(layout: Layout, running: &[String], daemon_port: u16) -> Result<(Net, Swept), Error> {
        let net = Net {
            layout,
            daemon_port,
            turn: Mutex::new(()),
            listeners: Mutex::new(BTreeMap::new()),
            inward: Mutex::new(BTreeMap::new()),
            quiet: std::sync::Mutex::new(BTreeMap::new()),
        };
        let mut swept = Swept::default();
        if !is_root() {
            return Ok((net, swept));
        }
        let mut route = Route::open()?;
        for link in route.links()? {
            match link.alias.as_deref().and_then(|alias| net.workspace_of(alias)) {
                Some(id) if link.name.starts_with(LINK_PREFIX) && !running.contains(&id) => {
                    route.delete(link.index)?;
                    swept.links.push(link.name);
                }
                _ => {}
            }
        }
        // Listed again: a pair goes as one, so the peer of a link removed above is gone with it.
        if !route.links()?.iter().any(|l| l.name.starts_with(LINK_PREFIX)) {
            if rules_present()? {
                rules_down()?;
                swept.rules = true;
            }
        } else {
            rules_up(net.daemon_port)?;
        }
        Ok((net, swept))
    }

    /// The workspace an alias names, when it is a workspace dir under this root.
    fn workspace_of(&self, alias: &str) -> Option<String> {
        let path = Path::new(alias);
        if path.parent()? != self.layout.run() {
            return None;
        }
        Some(path.file_name()?.to_string_lossy().into_owned())
    }

    fn alias_of(&self, id: &str) -> String {
        self.layout.workspace(id).display().to_string()
    }

    /// The workspace's quiet clock, started at this moment where this daemon has none for it: a boot starts one,
    /// and so does the open of a daemon that found the workspace already running, since a figure counted from a
    /// moment nothing remembers is not a figure. A workspace idle across a daemon restart therefore lives one
    /// more window.
    pub fn quiet_of(&self, id: &str) -> Arc<Quiet> {
        let mut clocks = self.quiet.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(clocks.entry(id.to_owned()).or_insert_with(|| Arc::new(Quiet::new())))
    }

    /// The workspace did something this computer can see, which is a command run in it: the clock starts over.
    /// A workspace this daemon has no clock for gets one, so the first thing seen is the figure's own start.
    pub fn touched(&self, id: &str) {
        self.quiet_of(id).touch();
    }

    /// How long it has been quiet, in milliseconds, where this daemon has a clock for it.
    pub fn quiet_for_ms(&self, id: &str) -> Option<u64> {
        let clocks = self.quiet.lock().unwrap_or_else(|e| e.into_inner());
        clocks.get(id).map(|quiet| quiet.quiet_for().as_millis() as u64)
    }

    pub fn record(&self, id: &str) -> Result<Option<Network>, Error> {
        let path = self.layout.net(id);
        match fs::read(&path) {
            Ok(text) => {
                serde_json::from_slice(&text).map(Some).map_err(|e| Error { what: path.display().to_string(), source: io::Error::other(e) })
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error { what: path.display().to_string(), source: e }),
        }
    }

    /// The listeners of every running workspace, bound again on the ports their records name and dialling the
    /// namespace of the init their record names now; a port somebody else took meanwhile moves and the record says
    /// where.
    ///
    /// Every published port, held or not. A port published while the workspace was stopped is held on nothing at
    /// all, and a port held from before the last boot dials a namespace that is gone: this is the one place a
    /// forward is given the live init to dial, so a wake answers at the box ports the record already carries.
    pub async fn restore(&self, running: &[String]) -> Result<(), Error> {
        for id in running {
            let Some(mut network) = self.record(id)? else { continue };
            // The init its record names now, read once before any port is bound: a workspace whose init is not
            // the process its record names has no namespace for any of them to dial, and nothing here holds a
            // listener that dials nowhere while calling it restored.
            let Some(pid) = self.init_pid(id)? else { continue };
            // A workspace this daemon has just found running gets a clock counted from now, as a boot does.
            let quiet = self.quiet_of(id);
            let mut moved = false;
            for (port, box_port) in network.forwards.clone() {
                // Whatever was held for this port goes first, and its task with it: the socket has to be free
                // before this binds it again, and what it dialled is not this boot's namespace.
                if let Some(held) = self.listeners.lock().await.get_mut(id) {
                    held.remove(&port);
                }
                // The dropped listener's task ends at the next turn of the runtime, and its port with it.
                tokio::task::yield_now().await;
                let bound = match bind(box_port).await {
                    Ok(listener) => listener,
                    Err(e) if e.kind() == io::ErrorKind::AddrInUse => bind(0).await.map_err(at("binding a forward"))?,
                    Err(e) => return Err(at(format!("binding 127.0.0.1:{box_port} for {id}"))(e)),
                };
                let got = bound.local_addr().map_err(at("reading a forward's port"))?.port();
                if got != box_port {
                    network.forwards.insert(port, got);
                    moved = true;
                }
                self.hold(id, port, bound, Dial::Inside { pid, port }, Some(Arc::clone(&quiet))).await;
            }
            if moved {
                bundle::write_json(&self.layout.net(id), &network)?;
            }
        }
        Ok(())
    }

    /// The pair, the addresses, the route inside, the rules: the workspace whose init is `pid` gets its network. A
    /// workspace that had one before, and was stopped, gets the same block and keeps its forwards where that block
    /// is still free; the forwards themselves come back with `restore`.
    pub async fn up(&self, id: &str, pid: i32) -> Result<Network, Error> {
        let _turn = self.turn.lock().await;
        // The quiet clock starts with the boot, so a workspace nobody asks anything of is quiet from the moment
        // it came up.
        self.quiet_of(id).touch();
        let layout = Layout::new(self.layout.root());
        let alias = self.alias_of(id);
        let before = self.record(id)?;
        let daemon_port = self.daemon_port;
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            let ns_path = format!("/proc/{pid}/ns/net");
            let ns = fs::File::open(&ns_path).map_err(at(ns_path))?;
            let mut route = Route::open()?;
            let taken: Vec<u16> = route.links()?.iter().filter_map(|l| index_of_link(&l.name)).collect();
            let wanted = before.as_ref().and_then(|n| index_of_link(&n.link)).filter(|k| !taken.contains(k));
            let index = wanted
                .or_else(|| free_index(taken.into_iter()))
                .ok_or_else(|| Error { what: format!("{RANGE}/{RANGE_PREFIX}"), source: io::Error::other("every block is taken") })?;
            let forwards = before.map(|n| n.forwards).unwrap_or_default();
            let (gateway, address) = block(index);
            let name = link_name(index);
            route.add_veth(&name, INSIDE_LINK, Some(ns.as_raw_fd()))?;
            let built = (|| -> Result<(), Error> {
                let box_end = route.index_of(&name)?;
                route.set_alias(box_end, &alias)?;
                route.add_address(box_end, gateway, BLOCK_PREFIX)?;
                route.set_up(box_end)?;
                let forwarding = forwarding_file(&name);
                fs::write(&forwarding, "1").map_err(at(forwarding))?;
                inside(ns, move |r| {
                    let eth = r.index_of(INSIDE_LINK)?;
                    let lo = r.index_of("lo")?;
                    r.add_address(eth, address, BLOCK_PREFIX)?;
                    r.set_up(lo)?;
                    r.set_up(eth)?;
                    r.add_default_route(gateway)
                })?;
                rules_up(daemon_port)
            })();
            if let Err(e) = built {
                let _ = route.delete_named(&name);
                return Err(e);
            }
            let network = Network { link: name, address, gateway, prefix: BLOCK_PREFIX, forwards };
            bundle::write_json(&layout.net(&id), &network)?;
            Ok(network)
        })
        .await
        .map_err(|e| Error { what: "the network task".into(), source: io::Error::other(e.to_string()) })?
    }

    /// The listeners, the link and the record go; with the last workspace link on the box the rules go too. A
    /// workspace whose namespace already died took its pair with it, which is what was asked for.
    pub async fn down(&self, id: &str) -> Result<(), Error> {
        self.take_down(id, false).await
    }

    /// A stopped workspace's network: the listeners and the link go as on a delete, the record stays with its
    /// block and its forwards, so the wake brings the same address and the same ports back.
    pub async fn stop(&self, id: &str) -> Result<(), Error> {
        self.take_down(id, true).await
    }

    async fn take_down(&self, id: &str, keep_record: bool) -> Result<(), Error> {
        let _turn = self.turn.lock().await;
        self.listeners.lock().await.remove(id);
        self.inward.lock().await.remove(id);
        // A stopped workspace has nothing to be quiet about, and its pid is not its pid any more: the wake starts
        // a clock of its own.
        self.quiet.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        // The listeners' tasks end at the next turn of the runtime; taking it here means none is bound when this
        // returns.
        tokio::task::yield_now().await;
        let record = self.record(id)?;
        let alias = self.alias_of(id);
        let path = self.layout.net(id);
        tokio::task::spawn_blocking(move || {
            let mut route = Route::open()?;
            let named = record.as_ref().map(|n| n.link.clone());
            for link in route.links()? {
                if Some(&link.name) == named.as_ref() || link.alias.as_deref() == Some(alias.as_str()) {
                    route.delete(link.index)?;
                }
            }
            if !keep_record {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(at(path.display().to_string())(e)),
                }
            }
            if !route.links()?.iter().any(|l| l.name.starts_with(LINK_PREFIX)) && rules_present()? {
                rules_down()?;
            }
            Ok(())
        })
        .await
        .map_err(|e| Error { what: "the network task".into(), source: io::Error::other(e.to_string()) })?
    }

    /// The port on the box's loopback that dials the workspace's port: the one already open for it, else a new one.
    /// The record is written whatever the workspace is doing, so a port published while it is stopped is one the
    /// wake gives a namespace to dial; until then the box port is held on nothing and answers nothing.
    pub async fn publish(&self, id: &str, port: u16) -> Result<u16, Error> {
        if let Some(held) = self.listeners.lock().await.get(id).and_then(|m| m.get(&port)) {
            return Ok(held.box_port);
        }
        let mut network =
            self.record(id)?.ok_or_else(|| Error { what: format!("workspace {id}"), source: io::Error::other("has no network") })?;
        let bound = bind(0).await.map_err(at("binding a forward"))?;
        let box_port = bound.local_addr().map_err(at("reading a forward's port"))?.port();
        network.forwards.insert(port, box_port);
        bundle::write_json(&self.layout.net(id), &network)?;
        // Held whatever the workspace is doing, which keeps the box port from being taken by something else
        // before the wake, and dialled only where there is a namespace to dial: a pid that is not the process the
        // record names is not a namespace, and a listener holding one would go on dialling it for the life of the
        // daemon, since a wake makes a new one. The wake's restore is what turns this into the dial.
        let dial = match self.init_pid(id)? {
            Some(pid) => Dial::Inside { pid, port },
            None => Dial::Nowhere,
        };
        let quiet = self.quiet_of(id);
        self.hold(id, port, bound, dial, Some(quiet)).await;
        Ok(box_port)
    }

    /// The pid of the workspace's init as its record names it, where that pid is still that process: what a
    /// listener dials the workspace's own namespace through.
    fn init_pid(&self, id: &str) -> Result<Option<i32>, Error> {
        let record = bundle::read_record(&self.layout.record(id))?;
        Ok(record.filter(|record| crate::runtime::alive(&record.init)).map(|record| record.init.pid))
    }

    /// A listener on every address the workspace has at `inside`, in the namespace of the init `pid`, dialing the
    /// box's loopback at `box_port`: the workspace reaches a container's published port at the port it asked for.
    /// One already held on that port inside is replaced.
    ///
    /// Every address and not the loopback alone: a container of the workspace's own dials a sibling at the
    /// workspace's own address as often as at localhost, and on a loopback-only listener that dial was refused
    /// (measured through the fence on a box). These bytes are the workspace talking to its own containers, so
    /// none of them is on the quiet clock: what keeps a workspace awake is somebody asking it for something.
    pub async fn forward_inward(&self, id: &str, pid: i32, inside_port: u16, box_port: u16) -> Result<(), Error> {
        if let Some(held) = self.inward.lock().await.get_mut(id) {
            held.remove(&inside_port);
        }
        // The replaced listener's task ends at the next turn of the runtime, and its port with it.
        tokio::task::yield_now().await;
        let ns_path = format!("/proc/{pid}/ns/net");
        let bound = tokio::task::spawn_blocking(move || -> Result<std::net::TcpListener, Error> {
            let ns = fs::File::open(&ns_path).map_err(at(ns_path.clone()))?;
            inside_with(ns, move || {
                let listener = std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, inside_port))
                    .map_err(at(format!("binding 0.0.0.0:{inside_port} inside the workspace")))?;
                listener.set_nonblocking(true).map_err(at("a listener inside the workspace"))?;
                Ok(listener)
            })
        })
        .await
        .map_err(|e| Error { what: "the namespace task".into(), source: io::Error::other(e.to_string()) })??;
        let listener = TcpListener::from_std(bound).map_err(at("a listener inside the workspace"))?;
        let task = tokio::spawn(serve(listener, Arc::new(Dial::Box(SocketAddrV4::new(Ipv4Addr::LOCALHOST, box_port))), None));
        self.inward.lock().await.entry(id.to_owned()).or_default().insert(inside_port, Listener { box_port, task });
        Ok(())
    }

    /// The rule for one bridge the engine made for a workspace's network, where the box holds a link by that
    /// name: two containers of the workspace reach each other across it and nothing else does. False where the
    /// engine made no such bridge, which is the fence's word to take the network away again.
    pub fn bridge_up(&self, id: &str, bridge: &str) -> Result<bool, Error> {
        if !Route::open()?.links()?.iter().any(|link| link.name == bridge) {
            return Ok(false);
        }
        rules_up(self.daemon_port)?;
        Conn::open()?.batch(&[bridge_rule(bridge, id)], "writing an engine bridge rule")?;
        Ok(true)
    }

    /// That rule taken off, by the comment naming the bridge and the workspace.
    pub fn bridge_down(&self, id: &str, bridge: &str) -> Result<(), Error> {
        self.sweep_bridges(|named, workspace| named == bridge && workspace == id)
    }

    /// Every one of a workspace's engine bridge rules taken off, as its remove takes its containers.
    pub fn bridges_down(&self, id: &str) -> Result<(), Error> {
        self.sweep_bridges(|_, workspace| workspace == id)
    }

    fn sweep_bridges(&self, wanted: impl Fn(&str, &str) -> bool) -> Result<(), Error> {
        let mut conn = Conn::open()?;
        if !conn.tables()?.contains(&(nft::NFPROTO_IPV4, TABLE.to_owned())) {
            return Ok(());
        }
        let mut batch = Vec::new();
        for rule in conn.rules(nft::NFPROTO_IPV4, TABLE, "forward")? {
            if rule.comment.as_deref().and_then(bridged).is_some_and(|(bridge, id)| wanted(bridge, id)) {
                batch.push(nft::del_rule(nft::NFPROTO_IPV4, TABLE, "forward", rule.handle));
            }
        }
        conn.batch(&batch, "removing the engine bridge rules")?;
        Ok(())
    }

    async fn hold(&self, id: &str, port: u16, bound: TcpListener, dial: Dial, quiet: Option<Arc<Quiet>>) {
        let box_port = bound.local_addr().map(|a| a.port()).unwrap_or(0);
        let task = tokio::spawn(serve(bound, Arc::new(dial), quiet));
        self.listeners.lock().await.entry(id.to_owned()).or_default().insert(port, Listener { box_port, task });
    }
}

async fn bind(port: u16) -> io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await
}

/// Every connection accepted is one connection to where the dial leads, bytes both ways until either side
/// closes. Where a quiet clock came with it, every byte of every one of them starts that clock over: the
/// connection on this side is the one wrapped, so both directions count.
async fn serve(listener: TcpListener, dial: Arc<Dial>, quiet: Option<Arc<Quiet>>) {
    loop {
        let (mut inbound, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let dial = Arc::clone(&dial);
        let quiet = quiet.clone();
        tokio::spawn(async move {
            let Ok(mut outbound) = dial.connect().await else { return };
            match quiet {
                Some(quiet) => {
                    let mut counted = Counted { inner: inbound, quiet };
                    let _ = tokio::io::copy_bidirectional(&mut counted, &mut outbound).await;
                }
                None => {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_are_thirties_out_of_the_range_and_links_carry_their_index() {
        assert_eq!(block(1), (Ipv4Addr::new(10, 65, 0, 5), Ipv4Addr::new(10, 65, 0, 6)));
        assert_eq!(block(64), (Ipv4Addr::new(10, 65, 1, 1), Ipv4Addr::new(10, 65, 1, 2)));
        assert_eq!(block(LAST_INDEX), (Ipv4Addr::new(10, 65, 255, 249), Ipv4Addr::new(10, 65, 255, 250)));
        assert_eq!(link_name(7), "wsp-7");
        assert_eq!(index_of_link("wsp-7"), Some(7));
        assert_eq!(index_of_link("wsp-x"), None);
        assert_eq!(index_of_link("eth0"), None);
        assert_eq!(free_index([1u16, 2, 4].into_iter()), Some(3));
        assert_eq!(free_index(std::iter::empty()), Some(FIRST_INDEX));
        assert_eq!(free_index(FIRST_INDEX..=LAST_INDEX), None);
    }

    #[test]
    fn a_network_record_reads_back_with_its_forwards() {
        let network = Network {
            link: "wsp-3".into(),
            address: Ipv4Addr::new(10, 65, 0, 14),
            gateway: Ipv4Addr::new(10, 65, 0, 13),
            prefix: 30,
            forwards: BTreeMap::from([(7070, 41234)]),
        };
        let text = serde_json::to_string(&network).unwrap();
        assert!(text.contains("\"forwards\":{\"7070\":41234}"), "{text}");
        assert_eq!(serde_json::from_str::<Network>(&text).unwrap(), network);
    }

    #[test]
    fn a_foreign_filter_chain_gets_an_accept_when_its_policy_or_its_last_rule_refuses() {
        let chain = |table: &str, family, kind: &str, hook, policy| nft::ChainRow {
            family,
            table: table.into(),
            name: "x".into(),
            kind: Some(kind.into()),
            hook: Some(hook),
            policy: Some(policy),
        };
        let rule = |exprs: &[&str], verdict| nft::RuleRow {
            handle: 1,
            comment: None,
            exprs: exprs.iter().map(|e| (*e).to_owned()).collect(),
            verdict,
        };
        let ufw = chain("filter", nft::NFPROTO_IPV4, "filter", nft::NF_INET_FORWARD, nft::NF_DROP);
        assert!(refuses_at_its_end(&ufw, &[]));
        assert!(refuses_at_its_end(&chain("filter", nft::NFPROTO_IPV4, "filter", nft::NF_INET_LOCAL_IN, nft::NF_DROP), &[]));
        // firewalld: policy accept, the last rule a bare reject.
        let firewalld = chain("firewalld", nft::NFPROTO_INET, "filter", nft::NF_INET_LOCAL_IN, nft::NF_ACCEPT);
        assert!(refuses_at_its_end(&firewalld, &[rule(&["meta", "cmp", "immediate"], Some(nft::NF_ACCEPT)), rule(&["reject"], None)]));
        assert!(refuses_at_its_end(&firewalld, &[rule(&["counter", "immediate"], Some(nft::NF_DROP))]));
        assert!(!refuses_at_its_end(&firewalld, &[]), "policy accept and no rule refuses nothing");
        assert!(
            !refuses_at_its_end(&firewalld, &[rule(&["meta", "cmp", "reject"], None)]),
            "a reject behind a match is not the chain's end"
        );
        assert!(!refuses_at_its_end(&chain("filter", nft::NFPROTO_IPV4, "filter", nft::NF_INET_POST_ROUTING, nft::NF_DROP), &[]));
        assert!(!refuses_at_its_end(&chain("nat", nft::NFPROTO_IPV4, "nat", nft::NF_INET_FORWARD, nft::NF_DROP), &[]));
        assert!(!refuses_at_its_end(&chain(TABLE, nft::NFPROTO_IPV4, "filter", nft::NF_INET_FORWARD, nft::NF_DROP), &[]));
        assert!(
            !refuses_at_its_end(&chain("filter", 10, "filter", nft::NF_INET_FORWARD, nft::NF_DROP), &[]),
            "ip6 carries none of our packets"
        );
        assert_eq!(accepts_for(&ufw, true).len(), 2);
        let refusing_input = chain("filter", nft::NFPROTO_IPV4, "filter", nft::NF_INET_LOCAL_IN, nft::NF_DROP);
        let written = accepts_for(&refusing_input, true);
        assert_eq!(written.len(), 2);
        // The way to the gateway, then the return path; the conntrack match is the one iptables writes, so the
        // box's own tooling still renders the chain.
        let (_, to_the_gateway, comment) = nft::shape_of(&written[0]).unwrap();
        assert_eq!(to_the_gateway, ["meta", "cmp", "payload", "bitwise", "cmp", "immediate"]);
        assert_eq!(comment.as_deref(), Some(RULE_COMMENT));
        let (_, answers, comment) = nft::shape_of(&written[1]).unwrap();
        assert_eq!(answers, ["meta", "cmp", "match", "immediate"]);
        assert_eq!(comment.as_deref(), Some(RULE_COMMENT));
        let (_, native, _) = nft::shape_of(&accepts_for(&refusing_input, false)[1]).unwrap();
        assert_eq!(native, ["meta", "cmp", "ct", "bitwise", "cmp", "immediate"]);
        let inet_input = chain("firewalld", nft::NFPROTO_INET, "filter", nft::NF_INET_LOCAL_IN, nft::NF_DROP);
        let (_, on_inet, _) = nft::shape_of(&accepts_for(&inet_input, true)[0]).unwrap();
        assert_eq!(on_inet, ["meta", "cmp", "meta", "cmp", "payload", "bitwise", "cmp", "immediate"], "the family match rides ahead");
        let drops = 2 + usize::from(wsp_frames::numbers::DEFAULT_PORT != 0);
        assert_eq!(own_table(Some("eth0"), None, wsp_frames::numbers::DEFAULT_PORT).len(), 4 + 7 + drops);
        assert_eq!(
            own_table(Some("eth0"), Some("eth0"), wsp_frames::numbers::DEFAULT_PORT).len(),
            4 + 8 + drops,
            "the guard rides along where this daemon turned forwarding on"
        );
        assert_eq!(own_table(None, None, 0).len(), 4 + 9, "no default route: the one road rule drops everything a workspace forwards");
        // This daemon's own door first, then the engine's two; a daemon that bound nothing names none of its own.
        assert_eq!(gateway_drops(7070), vec![7070, 2375, 2376]);
        assert_eq!(gateway_drops(0), vec![2375, 2376]);
        assert_eq!(gateway_drops(2375), vec![2375, 2376], "the engine's own port named twice is one rule");
        assert_eq!(gateway_drops(2376), vec![2376, 2375], "and the same wherever it sits in the list");
        assert_eq!(guarded_interface("wsp workspaces: forwarding turned on for eth0"), Some("eth0"));
        assert_eq!(guarded_interface(RULE_COMMENT), None);
        assert_eq!(forwarding_file("wsp-3"), "/proc/sys/net/ipv4/conf/wsp-3/forwarding");
    }

    /// A refusing chain keeps the accepts it holds only where they are the ones this daemon writes; the shape an
    /// earlier daemon left is replaced instead of passed over.
    #[test]
    fn a_refusing_chain_keeps_only_the_accepts_this_daemon_writes() {
        let chain = nft::ChainRow {
            family: nft::NFPROTO_IPV4,
            table: "filter".into(),
            name: "INPUT".into(),
            kind: Some("filter".into()),
            hook: Some(nft::NF_INET_LOCAL_IN),
            policy: Some(nft::NF_DROP),
        };
        let held = |written: Vec<nft::Msg>| -> Vec<nft::RuleRow> {
            written
                .iter()
                .filter_map(nft::shape_of)
                .enumerate()
                .map(|(at, (_, exprs, comment))| nft::RuleRow { handle: at as u64 + 1, comment, exprs, verdict: Some(nft::NF_ACCEPT) })
                .collect()
        };
        assert!(accepts_stand(&chain, &held(accepts_for(&chain, true))));
        assert!(accepts_stand(&chain, &held(accepts_for(&chain, false))), "the native encoding of the conntrack match reads as ours");
        let mut as_the_head_insertion_leaves_them = held(accepts_for(&chain, true));
        as_the_head_insertion_leaves_them.reverse();
        assert!(accepts_stand(&chain, &as_the_head_insertion_leaves_them));
        assert!(!accepts_stand(&chain, &[]), "a chain holding none of ours gets both");
        assert!(!accepts_stand(&chain, &held(accepts_for(&chain, true))[1..]), "the return path alone is the older shape");
        assert!(!accepts_stand(&chain, &held(accepts_for(&chain, true))[..1]), "the way in alone is not the pair either");
        let mut beside_a_rule_of_the_boxs = held(accepts_for(&chain, true));
        beside_a_rule_of_the_boxs.push(nft::RuleRow { handle: 9, comment: None, exprs: vec!["counter".into()], verdict: None });
        assert!(accepts_stand(&chain, &beside_a_rule_of_the_boxs), "a rule that is not ours says nothing about ours");
    }

    /// The rules as a person reads them off the box, in the order they are appended: what a container of a
    /// workspace's own engine bridge meets is what the workspace meets, and a bridge's own rule stands ahead of
    /// the drop that would take frames between two containers of one workspace.
    #[test]
    fn the_rules_read_in_order_and_an_engine_bridge_carries_one_of_its_own() {
        let shapes = |rules: Vec<nft::Msg>| -> Vec<(String, Option<String>)> {
            rules.iter().filter_map(nft::shape_of).map(|(chain, _, comment)| (chain, comment)).collect()
        };
        let chains: Vec<String> = shapes(own_rules(Some("eth0"), Some("eth0"), 0)).into_iter().map(|(chain, _)| chain).collect();
        assert_eq!(chains, ["forward", "forward", "forward", "forward", "forward", "input", "input", "input", "input", "postrouting"]);
        // On input, in order: the established accept, one drop per gateway port with this daemon's own first,
        // then the drop of every destination outside the workspaces' range.
        let input: Vec<(Vec<String>, Option<String>)> = own_rules(None, None, 7070)
            .iter()
            .filter_map(nft::shape_of)
            .filter(|(chain, _, _)| chain == "input")
            .map(|(_, exprs, comment)| (exprs, comment))
            .collect();
        assert_eq!(input[0].0, ["meta", "cmp", "ct", "bitwise", "cmp", "immediate"]);
        for (at, port) in gateway_drops(7070).into_iter().enumerate() {
            assert_eq!(input[at + 1].0, ["meta", "cmp", "meta", "cmp", "payload", "cmp", "immediate"], "{port}");
            assert_eq!(input[at + 1].1.as_deref(), Some(format!("wsp workspaces: gateway port {port}").as_str()));
        }
        assert_eq!(input[4].0, ["meta", "cmp", "payload", "bitwise", "cmp", "immediate"]);
        // One bridge, one rule, marked so it goes with its own network and with the workspace that made it.
        let (chain, exprs, comment) = nft::shape_of(&bridge_rule("wsp-e0000002a", "wsp-a")).unwrap();
        assert_eq!(
            (chain.as_str(), exprs),
            ("forward", vec!["meta", "cmp", "meta", "cmp", "immediate"].into_iter().map(str::to_owned).collect())
        );
        assert_eq!(comment.as_deref(), Some("wsp workspaces: engine bridge wsp-e0000002a of wsp-a"));
        assert_eq!(bridged(&comment.unwrap()), Some(("wsp-e0000002a", "wsp-a")));
        assert_eq!(bridged(RULE_COMMENT), None);
        assert_eq!(bridged("wsp workspaces: forwarding turned on for eth0"), None);
        // An engine bridge wears the workspaces' prefix and is no workspace's block, so the sweep leaves it and
        // the open counts it as a link standing on the box.
        assert!("wsp-e0000002a".starts_with(LINK_PREFIX));
        assert_eq!(index_of_link("wsp-e0000002a"), None);
    }

    /// The clock the host's idle firing reads: nothing since the last byte or the last command, growing while
    /// nothing happens. Every figure here is held against fifty milliseconds, which is a runtime turn and not a
    /// wall clock: the window this feeds is twenty minutes long.
    #[tokio::test]
    async fn the_quiet_clock_starts_over_on_every_byte_and_grows_while_nothing_happens() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let quiet = Arc::new(Quiet::new());
        quiet.touch();
        assert!(quiet.quiet_for() < Duration::from_millis(50), "{:?}", quiet.quiet_for());
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(quiet.quiet_for() >= Duration::from_millis(50), "{:?}", quiet.quiet_for());

        // A byte read off the connection on the box's side is somebody asking the workspace for something.
        let (mut asking, answering) = tokio::io::duplex(64);
        let mut counted = Counted { inner: answering, quiet: Arc::clone(&quiet) };
        asking.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        let mut held = [0u8; 16];
        counted.read_exact(&mut held).await.unwrap();
        assert!(quiet.quiet_for() < Duration::from_millis(50), "a byte in did not start the clock over");

        // And a byte written back to them is the workspace answering.
        tokio::time::sleep(Duration::from_millis(80)).await;
        counted.write_all(b"HTTP/1.1 200 OK\r\n").await.unwrap();
        assert!(quiet.quiet_for() < Duration::from_millis(50), "a byte out did not start the clock over");

        // A connection closing is not a byte: the clock goes on growing, so a browser tab going away does not
        // read as the workspace doing something.
        tokio::time::sleep(Duration::from_millis(80)).await;
        drop(asking);
        assert_eq!(counted.read(&mut held).await.unwrap(), 0);
        assert!(quiet.quiet_for() >= Duration::from_millis(50), "the end of a stream started the clock over");
    }

    /// A port published while its workspace is stopped, which is a road `machine.previewUrl` leaves open: the
    /// record carries it so the wake binds the same box port, the port is held so nothing else on the box takes
    /// it meanwhile, and nothing is dialled for it, since a stopped workspace has no namespace to dial. What
    /// turns it into a dial is the wake's own restore, which the live case reads through.
    #[tokio::test]
    async fn a_port_published_while_the_workspace_is_stopped_is_recorded_and_held_on_nothing() {
        use tokio::io::AsyncReadExt;
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        let id = "wsp-stopped";
        fs::create_dir_all(layout.workspace(id)).unwrap();
        // What a stop leaves: the network record with its block, and a record whose init is a pid nothing holds.
        let network = Network {
            link: "wsp-3".into(),
            address: Ipv4Addr::new(10, 65, 0, 14),
            gateway: Ipv4Addr::new(10, 65, 0, 13),
            prefix: BLOCK_PREFIX,
            forwards: BTreeMap::new(),
        };
        bundle::write_json(&layout.net(id), &network).unwrap();
        bundle::write_json(&layout.record(id), &stopped_record(id)).unwrap();

        let (net, _) = Net::open(Layout::new(dir.path()), &[], wsp_frames::numbers::DEFAULT_PORT).unwrap();
        let box_port = net.publish(id, 7070).await.unwrap();
        // The record says which box port the port inside answers at, so the wake binds that one and the reach
        // the host already handed out still names it.
        assert_eq!(net.record(id).unwrap().unwrap().forwards, BTreeMap::from([(7070, box_port)]));
        // And the same port every time it is asked for, off the listener held for it.
        assert_eq!(net.publish(id, 7070).await.unwrap(), box_port);
        // Taken and closed with no byte, rather than refused: the port is ours until the wake, and nothing
        // inside is dialled for it.
        let mut asking = TcpStream::connect(SocketAddrV4::new(Ipv4Addr::LOCALHOST, box_port)).await.unwrap();
        let mut answered = Vec::new();
        asking.read_to_end(&mut answered).await.unwrap();
        assert!(answered.is_empty(), "{answered:?}");
    }

    /// A workspace as a stop leaves it: every field a record carries, and an init pid nothing holds.
    fn stopped_record(id: &str) -> crate::bundle::Workspace {
        crate::bundle::Workspace {
            id: id.to_owned(),
            hostname: id.to_owned(),
            labels: BTreeMap::new(),
            envs: BTreeMap::new(),
            cpu: Some(1.0),
            mem_mb: Some(1024),
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
            init: crate::bundle::Init { pid: i32::MAX, started: 0, boot_id: String::new() },
            engine: false,
            copy: None,
            shares: Vec::new(),
            binds: Vec::new(),
            made_points: Vec::new(),
        }
    }

    #[test]
    fn a_workspace_this_daemon_has_no_clock_for_answers_no_figure() {
        let net = Net {
            layout: Layout::new(Path::new("/var/lib/wsp")),
            daemon_port: 0,
            turn: Mutex::new(()),
            listeners: Mutex::new(BTreeMap::new()),
            inward: Mutex::new(BTreeMap::new()),
            quiet: std::sync::Mutex::new(BTreeMap::new()),
        };
        // Nothing of this workspace has been seen by this daemon at all, which is what a restart leaves.
        assert_eq!(net.quiet_for_ms("wsp-a"), None);
        net.touched("wsp-a");
        assert!(net.quiet_for_ms("wsp-a").is_some_and(|ms| ms < 50), "{:?}", net.quiet_for_ms("wsp-a"));
        // One clock per workspace, so reading a figure is not what resets it and two roads into one workspace
        // write the same clock.
        assert!(Arc::ptr_eq(&net.quiet_of("wsp-a"), &net.quiet_of("wsp-a")));
        assert!(!Arc::ptr_eq(&net.quiet_of("wsp-a"), &net.quiet_of("wsp-b")));
    }

    #[test]
    fn an_alias_names_a_workspace_under_this_root_alone() {
        let net = Net {
            layout: Layout::new(Path::new("/var/lib/wsp")),
            daemon_port: 0,
            turn: Mutex::new(()),
            listeners: Mutex::new(BTreeMap::new()),
            inward: Mutex::new(BTreeMap::new()),
            quiet: std::sync::Mutex::new(BTreeMap::new()),
        };
        assert_eq!(net.workspace_of("/var/lib/wsp/run/wsp-a"), Some("wsp-a".to_owned()));
        assert_eq!(net.workspace_of("/tmp/other/run/wsp-a"), None);
        assert_eq!(net.workspace_of("wsp-a"), None);
        assert_eq!(net.alias_of("wsp-a"), "/var/lib/wsp/run/wsp-a");
    }
}
