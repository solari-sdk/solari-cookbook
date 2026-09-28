// SPDX-License-Identifier: AGPL-3.0-only
//! nf_tables spoken to the kernel over netlink, from here: tables, base chains and rules written in one batch,
//! and the dumps that say what the kernel holds. No nft binary runs and none is needed; the messages are the
//! kernel's own, built and read in this file. The expressions are the ones nft itself emits for the same words,
//! so `nft list ruleset` renders what this file wrote in the words it was written for.

use std::fmt;
use std::io;

use netlink_sys::protocols::NETLINK_NETFILTER;
use netlink_sys::{Socket, SocketAddr};

const NLMSG_ERROR: u16 = 2;
const NLMSG_DONE: u16 = 3;
const NLM_F_REQUEST: u16 = 0x01;
const NLM_F_ACK: u16 = 0x04;
const NLM_F_DUMP: u16 = 0x300;
const NLM_F_CREATE: u16 = 0x400;
const NLM_F_APPEND: u16 = 0x800;
const NLA_F_NESTED: u16 = 0x8000;
const NLA_TYPE_MASK: u16 = 0x3fff;
const NLMSG_HEADER: usize = 16;
const NFGENMSG: usize = 4;

const NFNL_SUBSYS_NFTABLES: u16 = 10;
const NFNL_MSG_BATCH_BEGIN: u16 = 0x10;
const NFNL_MSG_BATCH_END: u16 = 0x11;
const NFNETLINK_V0: u8 = 0;

pub const NFPROTO_UNSPEC: u8 = 0;
pub const NFPROTO_INET: u8 = 1;
pub const NFPROTO_IPV4: u8 = 2;

const NFT_MSG_NEWTABLE: u16 = 0;
const NFT_MSG_GETTABLE: u16 = 1;
const NFT_MSG_DELTABLE: u16 = 2;
const NFT_MSG_NEWCHAIN: u16 = 3;
const NFT_MSG_GETCHAIN: u16 = 4;
const NFT_MSG_NEWRULE: u16 = 6;
const NFT_MSG_GETRULE: u16 = 7;
const NFT_MSG_DELRULE: u16 = 8;
const NFT_MSG_GETGEN: u16 = 16;

const NFTA_TABLE_NAME: u16 = 1;
const NFTA_CHAIN_TABLE: u16 = 1;
const NFTA_CHAIN_NAME: u16 = 3;
const NFTA_CHAIN_HOOK: u16 = 4;
const NFTA_CHAIN_POLICY: u16 = 5;
const NFTA_CHAIN_TYPE: u16 = 7;
const NFTA_HOOK_HOOKNUM: u16 = 1;
const NFTA_HOOK_PRIORITY: u16 = 2;
const NFTA_RULE_TABLE: u16 = 1;
const NFTA_RULE_CHAIN: u16 = 2;
const NFTA_RULE_HANDLE: u16 = 3;
const NFTA_RULE_EXPRESSIONS: u16 = 4;
const NFTA_RULE_USERDATA: u16 = 7;
const NFTA_LIST_ELEM: u16 = 1;
const NFTA_EXPR_NAME: u16 = 1;
const NFTA_EXPR_DATA: u16 = 2;
const NFTA_DATA_VALUE: u16 = 1;
const NFTA_DATA_VERDICT: u16 = 2;
const NFTA_VERDICT_CODE: u16 = 1;
const NFTA_IMMEDIATE_DREG: u16 = 1;
const NFTA_IMMEDIATE_DATA: u16 = 2;
const NFTA_META_DREG: u16 = 1;
const NFTA_META_KEY: u16 = 2;
const NFTA_CMP_SREG: u16 = 1;
const NFTA_CMP_OP: u16 = 2;
const NFTA_CMP_DATA: u16 = 3;
const NFTA_PAYLOAD_DREG: u16 = 1;
const NFTA_PAYLOAD_BASE: u16 = 2;
const NFTA_PAYLOAD_OFFSET: u16 = 3;
const NFTA_PAYLOAD_LEN: u16 = 4;
const NFTA_BITWISE_SREG: u16 = 1;
const NFTA_BITWISE_DREG: u16 = 2;
const NFTA_BITWISE_LEN: u16 = 3;
const NFTA_BITWISE_MASK: u16 = 4;
const NFTA_BITWISE_XOR: u16 = 5;
const NFTA_CT_DREG: u16 = 1;
const NFTA_CT_KEY: u16 = 2;
const NFTA_MATCH_NAME: u16 = 1;
const NFTA_MATCH_REV: u16 = 2;
const NFTA_MATCH_INFO: u16 = 3;
const NFTA_REJECT_TYPE: u16 = 1;
const NFTA_REJECT_ICMP_CODE: u16 = 2;
const NFT_REJECT_ICMPX_UNREACH: u32 = 2;
const NFT_REJECT_ICMPX_ADMIN_PROHIBITED: u8 = 3;
/// An interface name in a register: IFNAMSIZ bytes, the name NUL padded, which is how nft compares a whole name.
const IFNAMSIZ: usize = 16;

const NFT_REG_VERDICT: u32 = 0;
const NFT_REG_1: u32 = 1;
const NFT_META_IIFNAME: u32 = 6;
const NFT_META_OIFNAME: u32 = 7;
const NFT_META_NFPROTO: u32 = 15;
const NFT_CMP_EQ: u32 = 0;
const NFT_CMP_NEQ: u32 = 1;
const NFT_PAYLOAD_NETWORK_HEADER: u32 = 1;
const NFT_PAYLOAD_TRANSPORT_HEADER: u32 = 2;
const NFT_META_L4PROTO: u32 = 16;
const IPPROTO_TCP: u8 = 6;
const NFT_CT_STATE: u32 = 0;
/// The conntrack state bits as the kernel keeps them in the register: established is bit 1, related bit 2.
const CT_ESTABLISHED_OR_RELATED: u32 = 0b110;
/// The same two states as the conntrack match of the iptables extensions keeps them, in its own field.
const XT_CONNTRACK_STATE_ESTABLISHED_OR_RELATED: u16 = 0b110;
/// That match reads the state field at all.
const XT_CONNTRACK_STATE: u16 = 1;
/// The revision of `xt_conntrack`'s info struct iptables writes, and the size of that struct with its padding.
const XT_CONNTRACK_REVISION: u32 = 3;
const XT_CONNTRACK_INFO: usize = 164;
/// Where the fields this rule sets sit in that struct: eight address and mask unions, two expiry counts, the
/// protocol and four ports come first.
const XT_CONNTRACK_MATCH_FLAGS: usize = 146;
const XT_CONNTRACK_STATE_MASK: usize = 150;
/// The comment type in nft's rule userdata, which is how nft shows a rule's comment back.
const UDATA_RULE_COMMENT: u8 = 0;

pub const NF_DROP: u32 = 0;
pub const NF_ACCEPT: u32 = 1;
pub const NF_INET_LOCAL_IN: u32 = 1;
pub const NF_INET_FORWARD: u32 = 2;
pub const NF_INET_POST_ROUTING: u32 = 4;

/// Where an error came from and the errno the kernel answered, or the io error under the socket.
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

fn at(what: impl Into<String>) -> impl FnOnce(io::Error) -> Error {
    move |source| Error { what: what.into(), source }
}

/// One nf_tables message of a batch or a request: its type, its flags, the family in its nfgenmsg and its attributes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Msg {
    kind: u16,
    flags: u16,
    family: u8,
    attrs: Vec<u8>,
}

impl Msg {
    fn encode(&self, seq: u32) -> Vec<u8> {
        let len = NLMSG_HEADER + NFGENMSG + self.attrs.len();
        let mut out = Vec::with_capacity(len);
        out.extend((len as u32).to_ne_bytes());
        out.extend(((NFNL_SUBSYS_NFTABLES << 8) | self.kind).to_ne_bytes());
        out.extend(self.flags.to_ne_bytes());
        out.extend(seq.to_ne_bytes());
        out.extend(0u32.to_ne_bytes());
        out.push(self.family);
        out.push(NFNETLINK_V0);
        out.extend(0u16.to_be_bytes());
        out.extend(&self.attrs);
        out
    }
}

/// The batch bracket messages, which name the subsystem in the resource id and carry no attributes.
fn bracket(kind: u16, seq: u32) -> Vec<u8> {
    let len = NLMSG_HEADER + NFGENMSG;
    let mut out = Vec::with_capacity(len);
    out.extend((len as u32).to_ne_bytes());
    out.extend(kind.to_ne_bytes());
    out.extend(NLM_F_REQUEST.to_ne_bytes());
    out.extend(seq.to_ne_bytes());
    out.extend(0u32.to_ne_bytes());
    out.push(NFPROTO_UNSPEC);
    out.push(NFNETLINK_V0);
    out.extend(NFNL_SUBSYS_NFTABLES.to_be_bytes());
    out
}

fn align(len: usize) -> usize {
    (len + 3) & !3
}

fn nla(out: &mut Vec<u8>, kind: u16, value: &[u8]) {
    let len = 4 + value.len();
    out.extend((len as u16).to_ne_bytes());
    out.extend(kind.to_ne_bytes());
    out.extend(value);
    out.resize(out.len() + align(len) - len, 0);
}

fn nla_str(out: &mut Vec<u8>, kind: u16, value: &str) {
    let mut bytes = value.as_bytes().to_vec();
    bytes.push(0);
    nla(out, kind, &bytes);
}

fn nla_be32(out: &mut Vec<u8>, kind: u16, value: u32) {
    nla(out, kind, &value.to_be_bytes());
}

fn nla_be64(out: &mut Vec<u8>, kind: u16, value: u64) {
    nla(out, kind, &value.to_be_bytes());
}

fn nested(out: &mut Vec<u8>, kind: u16, fill: impl FnOnce(&mut Vec<u8>)) {
    let mut inner = Vec::new();
    fill(&mut inner);
    nla(out, kind | NLA_F_NESTED, &inner);
}

/// One expression of a rule: the kernel's name for it and its attributes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expr {
    name: &'static str,
    data: Vec<u8>,
}

fn expr(name: &'static str, fill: impl FnOnce(&mut Vec<u8>)) -> Expr {
    let mut data = Vec::new();
    fill(&mut data);
    Expr { name, data }
}

fn value(out: &mut Vec<u8>, kind: u16, bytes: &[u8]) {
    nested(out, kind, |o| nla(o, NFTA_DATA_VALUE, bytes));
}

fn meta(key: u32) -> Expr {
    expr("meta", |o| {
        nla_be32(o, NFTA_META_KEY, key);
        nla_be32(o, NFTA_META_DREG, NFT_REG_1);
    })
}

fn cmp(op: u32, bytes: &[u8]) -> Expr {
    expr("cmp", |o| {
        nla_be32(o, NFTA_CMP_SREG, NFT_REG_1);
        nla_be32(o, NFTA_CMP_OP, op);
        value(o, NFTA_CMP_DATA, bytes);
    })
}

/// `iifname "<prefix>*"`: the interface name compared on the prefix's bytes alone, which is how nft spells a wildcard.
pub fn iifname_starts(prefix: &str) -> [Expr; 2] {
    [meta(NFT_META_IIFNAME), cmp(NFT_CMP_EQ, prefix.as_bytes())]
}

pub fn oifname_starts(prefix: &str) -> [Expr; 2] {
    [meta(NFT_META_OIFNAME), cmp(NFT_CMP_EQ, prefix.as_bytes())]
}

pub fn oifname_not_starts(prefix: &str) -> [Expr; 2] {
    [meta(NFT_META_OIFNAME), cmp(NFT_CMP_NEQ, prefix.as_bytes())]
}

pub fn iifname_not_starts(prefix: &str) -> [Expr; 2] {
    [meta(NFT_META_IIFNAME), cmp(NFT_CMP_NEQ, prefix.as_bytes())]
}

fn whole_name(name: &str) -> Vec<u8> {
    let mut bytes = name.as_bytes()[..name.len().min(IFNAMSIZ - 1)].to_vec();
    bytes.resize(IFNAMSIZ, 0);
    bytes
}

/// `iifname "<name>"`: the whole name, so `eth0` is not `eth01`.
pub fn iifname_is(name: &str) -> [Expr; 2] {
    [meta(NFT_META_IIFNAME), cmp(NFT_CMP_EQ, &whole_name(name))]
}

/// `oifname "<name>"`.
pub fn oifname_is(name: &str) -> [Expr; 2] {
    [meta(NFT_META_OIFNAME), cmp(NFT_CMP_EQ, &whole_name(name))]
}

/// `oifname != "<name>"`.
pub fn oifname_is_not(name: &str) -> [Expr; 2] {
    [meta(NFT_META_OIFNAME), cmp(NFT_CMP_NEQ, &whole_name(name))]
}

/// `reject with icmpx admin-prohibited`, the refusal firewalld ends its chains with.
pub fn reject() -> Expr {
    expr("reject", |o| {
        nla_be32(o, NFTA_REJECT_TYPE, NFT_REJECT_ICMPX_UNREACH);
        nla(o, NFTA_REJECT_ICMP_CODE, &[NFT_REJECT_ICMPX_ADMIN_PROHIBITED]);
    })
}

/// `meta nfproto ipv4`, which an inet chain wants before it reads an IPv4 header.
pub fn nfproto_ipv4() -> [Expr; 2] {
    [meta(NFT_META_NFPROTO), cmp(NFT_CMP_EQ, &[NFPROTO_IPV4])]
}

/// `meta l4proto tcp`, which a port compare wants before it reads a transport header.
pub fn l4proto_tcp() -> [Expr; 2] {
    [meta(NFT_META_L4PROTO), cmp(NFT_CMP_EQ, &[IPPROTO_TCP])]
}

/// `tcp dport <port>`: the two bytes at the transport header's second offset, which is where both TCP and UDP
/// keep the destination port.
pub fn tcp_dport_is(port: u16) -> [Expr; 2] {
    let load = expr("payload", |o| {
        nla_be32(o, NFTA_PAYLOAD_DREG, NFT_REG_1);
        nla_be32(o, NFTA_PAYLOAD_BASE, NFT_PAYLOAD_TRANSPORT_HEADER);
        nla_be32(o, NFTA_PAYLOAD_OFFSET, 2);
        nla_be32(o, NFTA_PAYLOAD_LEN, 2);
    });
    [load, cmp(NFT_CMP_EQ, &port.to_be_bytes())]
}

/// `ct state established,related` written as the conntrack match of the iptables extensions, which is the form
/// iptables-nft itself writes: the kernel takes it in a native chain through its compat module, and a chain
/// holding one still renders under `iptables -L`, which a chain holding the native expression below does not.
pub fn xt_ct_established_or_related() -> Expr {
    let mut info = vec![0u8; XT_CONNTRACK_INFO];
    info[XT_CONNTRACK_MATCH_FLAGS..XT_CONNTRACK_MATCH_FLAGS + 2].copy_from_slice(&XT_CONNTRACK_STATE.to_ne_bytes());
    info[XT_CONNTRACK_STATE_MASK..XT_CONNTRACK_STATE_MASK + 2].copy_from_slice(&XT_CONNTRACK_STATE_ESTABLISHED_OR_RELATED.to_ne_bytes());
    expr("match", move |o| {
        nla_str(o, NFTA_MATCH_NAME, "conntrack");
        nla_be32(o, NFTA_MATCH_REV, XT_CONNTRACK_REVISION);
        nla(o, NFTA_MATCH_INFO, &info);
    })
}

/// `ct state established,related`.
pub fn ct_established_or_related() -> [Expr; 3] {
    let ct = expr("ct", |o| {
        nla_be32(o, NFTA_CT_KEY, NFT_CT_STATE);
        nla_be32(o, NFTA_CT_DREG, NFT_REG_1);
    });
    let masked = expr("bitwise", |o| {
        nla_be32(o, NFTA_BITWISE_SREG, NFT_REG_1);
        nla_be32(o, NFTA_BITWISE_DREG, NFT_REG_1);
        nla_be32(o, NFTA_BITWISE_LEN, 4);
        value(o, NFTA_BITWISE_MASK, &CT_ESTABLISHED_OR_RELATED.to_ne_bytes());
        value(o, NFTA_BITWISE_XOR, &0u32.to_ne_bytes());
    });
    [ct, masked, cmp(NFT_CMP_NEQ, &0u32.to_ne_bytes())]
}

/// `ip saddr <range>/<prefix>` or `ip daddr`, negated where asked.
pub fn ip_addr_in(destination: bool, range: std::net::Ipv4Addr, prefix: u8, negate: bool) -> [Expr; 3] {
    let load = expr("payload", |o| {
        nla_be32(o, NFTA_PAYLOAD_DREG, NFT_REG_1);
        nla_be32(o, NFTA_PAYLOAD_BASE, NFT_PAYLOAD_NETWORK_HEADER);
        nla_be32(o, NFTA_PAYLOAD_OFFSET, if destination { 16 } else { 12 });
        nla_be32(o, NFTA_PAYLOAD_LEN, 4);
    });
    let mask: u32 = if prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(prefix)) };
    let masked = expr("bitwise", |o| {
        nla_be32(o, NFTA_BITWISE_SREG, NFT_REG_1);
        nla_be32(o, NFTA_BITWISE_DREG, NFT_REG_1);
        nla_be32(o, NFTA_BITWISE_LEN, 4);
        value(o, NFTA_BITWISE_MASK, &mask.to_be_bytes());
        value(o, NFTA_BITWISE_XOR, &0u32.to_ne_bytes());
    });
    let network = u32::from(range) & mask;
    [load, masked, cmp(if negate { NFT_CMP_NEQ } else { NFT_CMP_EQ }, &network.to_be_bytes())]
}

pub fn verdict(code: u32) -> Expr {
    expr("immediate", |o| {
        nla_be32(o, NFTA_IMMEDIATE_DREG, NFT_REG_VERDICT);
        nested(o, NFTA_IMMEDIATE_DATA, |d| nested(d, NFTA_DATA_VERDICT, |v| nla_be32(v, NFTA_VERDICT_CODE, code)));
    })
}

pub fn masquerade() -> Expr {
    expr("masq", |_| {})
}

/// A base chain as the kernel takes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseChain<'a> {
    pub family: u8,
    pub table: &'a str,
    pub name: &'a str,
    /// "filter" or "nat".
    pub kind: &'a str,
    pub hook: u32,
    pub priority: i32,
    pub policy: u32,
}

pub fn new_table(family: u8, name: &str) -> Msg {
    let mut attrs = Vec::new();
    nla_str(&mut attrs, NFTA_TABLE_NAME, name);
    Msg { kind: NFT_MSG_NEWTABLE, flags: NLM_F_CREATE, family, attrs }
}

pub fn del_table(family: u8, name: &str) -> Msg {
    let mut attrs = Vec::new();
    nla_str(&mut attrs, NFTA_TABLE_NAME, name);
    Msg { kind: NFT_MSG_DELTABLE, flags: 0, family, attrs }
}

pub fn new_chain(chain: &BaseChain) -> Msg {
    let mut attrs = Vec::new();
    nla_str(&mut attrs, NFTA_CHAIN_TABLE, chain.table);
    nla_str(&mut attrs, NFTA_CHAIN_NAME, chain.name);
    nested(&mut attrs, NFTA_CHAIN_HOOK, |o| {
        nla_be32(o, NFTA_HOOK_HOOKNUM, chain.hook);
        nla_be32(o, NFTA_HOOK_PRIORITY, chain.priority as u32);
    });
    nla_be32(&mut attrs, NFTA_CHAIN_POLICY, chain.policy);
    nla_str(&mut attrs, NFTA_CHAIN_TYPE, chain.kind);
    Msg { kind: NFT_MSG_NEWCHAIN, flags: NLM_F_CREATE, family: chain.family, attrs }
}

/// A rule appended to the chain, or put at its head, with a comment nft shows back.
pub fn new_rule(family: u8, table: &str, chain: &str, exprs: &[Expr], comment: &str, at_head: bool) -> Msg {
    let mut attrs = Vec::new();
    nla_str(&mut attrs, NFTA_RULE_TABLE, table);
    nla_str(&mut attrs, NFTA_RULE_CHAIN, chain);
    nested(&mut attrs, NFTA_RULE_EXPRESSIONS, |list| {
        for e in exprs {
            nested(list, NFTA_LIST_ELEM, |o| {
                nla_str(o, NFTA_EXPR_NAME, e.name);
                nla(o, NFTA_EXPR_DATA | NLA_F_NESTED, &e.data);
            });
        }
    });
    nla(&mut attrs, NFTA_RULE_USERDATA, &comment_udata(comment));
    let flags = if at_head { NLM_F_CREATE } else { NLM_F_CREATE | NLM_F_APPEND };
    Msg { kind: NFT_MSG_NEWRULE, flags, family, attrs }
}

pub fn del_rule(family: u8, table: &str, chain: &str, handle: u64) -> Msg {
    let mut attrs = Vec::new();
    nla_str(&mut attrs, NFTA_RULE_TABLE, table);
    nla_str(&mut attrs, NFTA_RULE_CHAIN, chain);
    nla_be64(&mut attrs, NFTA_RULE_HANDLE, handle);
    Msg { kind: NFT_MSG_DELRULE, flags: 0, family, attrs }
}

/// nft's userdata for a comment: one type, length, value entry with the string and its NUL.
fn comment_udata(comment: &str) -> Vec<u8> {
    let mut out = vec![UDATA_RULE_COMMENT, (comment.len() + 1) as u8];
    out.extend(comment.as_bytes());
    out.push(0);
    out
}

fn comment_of_udata(udata: &[u8]) -> Option<String> {
    let mut rest = udata;
    while rest.len() >= 2 {
        let (kind, len) = (rest[0], rest[1] as usize);
        let body = rest.get(2..2 + len)?;
        if kind == UDATA_RULE_COMMENT {
            let text = body.strip_suffix(&[0]).unwrap_or(body);
            return Some(String::from_utf8_lossy(text).into_owned());
        }
        rest = &rest[2 + len..];
    }
    None
}

/// The chain a rule message names, the names of its expressions and its comment, read back off the message the
/// same way a dump of the kernel's own rule reads them: what a comparison of the rules this daemon would write
/// against the rules the kernel holds is made of. `None` for a message that is not a rule.
pub fn shape_of(msg: &Msg) -> Option<(String, Vec<String>, Option<String>)> {
    if msg.kind != NFT_MSG_NEWRULE {
        return None;
    }
    let top = attrs(&msg.attrs);
    let chain = top.iter().find(|(k, _)| *k == NFTA_RULE_CHAIN).map(|(_, v)| text(v))?;
    let (exprs, _) = top.iter().find(|(k, _)| *k == NFTA_RULE_EXPRESSIONS).map(|(_, v)| exprs_of(v)).unwrap_or_default();
    let comment = top.iter().find(|(k, _)| *k == NFTA_RULE_USERDATA).and_then(|(_, v)| comment_of_udata(v));
    Some((chain, exprs, comment))
}

/// A base chain the kernel holds, as a dump lists it; a chain with no hook is a regular chain and reads `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainRow {
    pub family: u8,
    pub table: String,
    pub name: String,
    pub kind: Option<String>,
    pub hook: Option<u32>,
    pub policy: Option<u32>,
}

/// One rule as a dump lists it: its handle, its comment, the names of its expressions in order, and the code of
/// its verdict where one of them is an immediate verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleRow {
    pub handle: u64,
    pub comment: Option<String>,
    pub exprs: Vec<String>,
    pub verdict: Option<u32>,
}

impl RuleRow {
    /// Whether the rule refuses every packet that reaches it: nothing but a refusal, with counters or logs beside it.
    pub fn refuses_all(&self) -> bool {
        let refusal =
            self.exprs.iter().any(|e| e == "reject") || (self.exprs.iter().any(|e| e == "immediate") && self.verdict == Some(NF_DROP));
        refusal && self.exprs.iter().all(|e| matches!(e.as_str(), "reject" | "immediate" | "counter" | "log"))
    }
}

/// The expression names of a rule's expression list, and the code of its immediate verdict if it has one.
fn exprs_of(list: &[u8]) -> (Vec<String>, Option<u32>) {
    let mut names = Vec::new();
    let mut verdict = None;
    for (_, elem) in attrs(list) {
        let fields = attrs(elem);
        let Some(name) = fields.iter().find(|(k, _)| *k == NFTA_EXPR_NAME).map(|(_, v)| text(v)) else { continue };
        if name == "immediate" {
            if let Some(data) = fields.iter().find(|(k, _)| *k == NFTA_EXPR_DATA).map(|(_, v)| *v) {
                verdict = attrs(data)
                    .into_iter()
                    .find(|(k, _)| *k == NFTA_IMMEDIATE_DATA)
                    .and_then(|(_, d)| attrs(d).into_iter().find(|(k, _)| *k == NFTA_DATA_VERDICT))
                    .and_then(|(_, v)| attrs(v).into_iter().find(|(k, _)| *k == NFTA_VERDICT_CODE))
                    .and_then(|(_, c)| be32(c));
            }
        }
        names.push(name);
    }
    (names, verdict)
}

/// Attributes of one message, in order.
fn attrs(bytes: &[u8]) -> Vec<(u16, &[u8])> {
    let mut out = Vec::new();
    let mut rest = bytes;
    while rest.len() >= 4 {
        let len = u16::from_ne_bytes([rest[0], rest[1]]) as usize;
        let kind = u16::from_ne_bytes([rest[2], rest[3]]) & NLA_TYPE_MASK;
        if len < 4 || len > rest.len() {
            break;
        }
        out.push((kind, &rest[4..len]));
        rest = &rest[align(len).min(rest.len())..];
    }
    out
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes.strip_suffix(&[0]).unwrap_or(bytes)).into_owned()
}

fn be32(bytes: &[u8]) -> Option<u32> {
    bytes.try_into().ok().map(u32::from_be_bytes)
}

fn be64(bytes: &[u8]) -> Option<u64> {
    bytes.try_into().ok().map(u64::from_be_bytes)
}

/// One received netlink message: its type, its sequence and its body past the header.
struct Received<'a> {
    kind: u16,
    seq: u32,
    body: &'a [u8],
}

fn messages(datagram: &[u8]) -> Vec<Received<'_>> {
    let mut out = Vec::new();
    let mut rest = datagram;
    while rest.len() >= NLMSG_HEADER {
        let len = u32::from_ne_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        let kind = u16::from_ne_bytes([rest[4], rest[5]]);
        let seq = u32::from_ne_bytes([rest[8], rest[9], rest[10], rest[11]]);
        if len < NLMSG_HEADER || len > rest.len() {
            break;
        }
        out.push(Received { kind, seq, body: &rest[NLMSG_HEADER..len] });
        rest = &rest[align(len).min(rest.len())..];
    }
    out
}

/// The errno an NLMSG_ERROR carries: zero is an acknowledgement.
fn errno_of(body: &[u8]) -> i32 {
    body.get(..4).and_then(|b| b.try_into().ok()).map_or(0, i32::from_ne_bytes)
}

/// One netlink socket to the kernel's nf_tables.
pub struct Conn {
    socket: Socket,
    seq: u32,
}

impl Conn {
    pub fn open() -> Result<Conn, Error> {
        let mut socket = Socket::new(NETLINK_NETFILTER).map_err(at("opening the nftables socket"))?;
        socket.bind_auto().map_err(at("binding the nftables socket"))?;
        Ok(Conn { socket, seq: 1 })
    }

    fn next_seq(&mut self) -> u32 {
        self.seq = self.seq.wrapping_add(1);
        self.seq
    }

    fn send(&self, bytes: &[u8], what: &str) -> Result<(), Error> {
        self.socket.send_to(bytes, &SocketAddr::new(0, 0), 0).map_err(at(what))?;
        Ok(())
    }

    /// Whether the kernel has nf_tables at all: it answers the generation, or refuses by name.
    pub fn generation(&mut self) -> Result<(), Error> {
        let seq = self.next_seq();
        let msg = Msg { kind: NFT_MSG_GETGEN, flags: NLM_F_REQUEST, family: NFPROTO_UNSPEC, attrs: Vec::new() };
        self.send(&msg.encode(seq), "asking nftables for its generation")?;
        let (datagram, _) = self.socket.recv_from_full().map_err(at("reading the nftables generation"))?;
        for m in messages(&datagram) {
            if m.kind == NLMSG_ERROR && errno_of(m.body) != 0 {
                return Err(at("asking nftables for its generation")(io::Error::from_raw_os_error(-errno_of(m.body))));
            }
        }
        Ok(())
    }

    /// Every message a dump answers: the family of its nfgenmsg and its attributes.
    fn dump(&mut self, request: Msg, what: &str) -> Result<Vec<Row>, Error> {
        let seq = self.next_seq();
        self.send(&request.encode(seq), what)?;
        let mut rows = Vec::new();
        loop {
            let (datagram, _) = self.socket.recv_from_full().map_err(at(what.to_owned()))?;
            for m in messages(&datagram) {
                if m.seq != seq {
                    continue;
                }
                match m.kind {
                    NLMSG_DONE => return Ok(rows),
                    NLMSG_ERROR => {
                        let errno = errno_of(m.body);
                        if errno != 0 {
                            return Err(at(what.to_owned())(io::Error::from_raw_os_error(-errno)));
                        }
                        return Ok(rows);
                    }
                    _ => {
                        let body = m.body.get(NFGENMSG..).unwrap_or(&[]);
                        let family = m.body.first().copied().unwrap_or(NFPROTO_UNSPEC);
                        rows.push(Row { family, attrs: attrs(body).into_iter().map(|(k, v)| (k, v.to_vec())).collect() });
                    }
                }
            }
        }
    }

    /// Every table the kernel holds, as (family, name).
    pub fn tables(&mut self) -> Result<Vec<(u8, String)>, Error> {
        let request = Msg { kind: NFT_MSG_GETTABLE, flags: NLM_F_REQUEST | NLM_F_DUMP, family: NFPROTO_UNSPEC, attrs: Vec::new() };
        let rows = self.dump(request, "listing the nftables tables")?;
        Ok(rows.iter().filter_map(|row| Some((row.family, text(row.find(NFTA_TABLE_NAME)?)))).collect())
    }

    /// Every chain the kernel holds, in every family.
    pub fn chains(&mut self) -> Result<Vec<ChainRow>, Error> {
        let request = Msg { kind: NFT_MSG_GETCHAIN, flags: NLM_F_REQUEST | NLM_F_DUMP, family: NFPROTO_UNSPEC, attrs: Vec::new() };
        let rows = self.dump(request, "listing the nftables chains")?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let hook = row
                    .find(NFTA_CHAIN_HOOK)
                    .and_then(|h| attrs(h).into_iter().find(|(k, _)| *k == NFTA_HOOK_HOOKNUM).and_then(|(_, v)| be32(v)));
                Some(ChainRow {
                    family: row.family,
                    table: text(row.find(NFTA_CHAIN_TABLE)?),
                    name: text(row.find(NFTA_CHAIN_NAME)?),
                    kind: row.find(NFTA_CHAIN_TYPE).map(text),
                    hook,
                    policy: row.find(NFTA_CHAIN_POLICY).and_then(be32),
                })
            })
            .collect())
    }

    /// The rules of one chain: their handles and comments.
    pub fn rules(&mut self, family: u8, table: &str, chain: &str) -> Result<Vec<RuleRow>, Error> {
        let mut attrs_out = Vec::new();
        nla_str(&mut attrs_out, NFTA_RULE_TABLE, table);
        nla_str(&mut attrs_out, NFTA_RULE_CHAIN, chain);
        let request = Msg { kind: NFT_MSG_GETRULE, flags: NLM_F_REQUEST | NLM_F_DUMP, family, attrs: attrs_out };
        let rows = self.dump(request, &format!("listing the rules of {table} {chain}"))?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let (exprs, verdict) = row.find(NFTA_RULE_EXPRESSIONS).map(exprs_of).unwrap_or_default();
                Some(RuleRow {
                    handle: row.find(NFTA_RULE_HANDLE).and_then(be64)?,
                    comment: row.find(NFTA_RULE_USERDATA).and_then(comment_of_udata),
                    exprs,
                    verdict,
                })
            })
            .collect())
    }

    /// The messages as one transaction: all of them land or none does. The first refusal names its errno, and a
    /// refusal of the batch itself, which the kernel answers on a bracket's sequence, ends the wait the same way.
    pub fn batch(&mut self, msgs: &[Msg], what: &str) -> Result<(), Error> {
        if msgs.is_empty() {
            return Ok(());
        }
        let begin = self.next_seq();
        let mut bytes = bracket(NFNL_MSG_BATCH_BEGIN, begin);
        let mut seqs = Vec::with_capacity(msgs.len());
        for msg in msgs {
            let seq = self.next_seq();
            seqs.push(seq);
            let mut m = msg.clone();
            m.flags |= NLM_F_REQUEST | NLM_F_ACK;
            bytes.extend(m.encode(seq));
        }
        let end = self.next_seq();
        bytes.extend(bracket(NFNL_MSG_BATCH_END, end));
        self.send(&bytes, what)?;
        let mut acked = 0;
        while acked < seqs.len() {
            let (datagram, _) = self.socket.recv_from_full().map_err(at(what.to_owned()))?;
            acked += batch_answers(&datagram, &seqs, [begin, end]).map_err(|e| Error { what: what.to_owned(), source: e })?;
        }
        Ok(())
    }
}

/// The acknowledgements one datagram of a batch's answer carries, or the first refusal in it: an errno on a
/// message's sequence names that message, one on a bracket's sequence is the batch itself refused.
fn batch_answers(datagram: &[u8], seqs: &[u32], brackets: [u32; 2]) -> io::Result<usize> {
    let mut acked = 0;
    for m in messages(datagram) {
        if m.kind != NLMSG_ERROR {
            continue;
        }
        let errno = errno_of(m.body);
        if let Some(which) = seqs.iter().position(|s| *s == m.seq) {
            if errno != 0 {
                return Err(io::Error::new(
                    io::Error::from_raw_os_error(-errno).kind(),
                    format!("message {} of {}: {}", which + 1, seqs.len(), io::Error::from_raw_os_error(-errno)),
                ));
            }
            acked += 1;
        } else if brackets.contains(&m.seq) && errno != 0 {
            return Err(io::Error::new(
                io::Error::from_raw_os_error(-errno).kind(),
                format!("the batch itself: {}", io::Error::from_raw_os_error(-errno)),
            ));
        }
    }
    Ok(acked)
}

/// One row of a dump: the family of its nfgenmsg and its attributes.
struct Row {
    family: u8,
    attrs: Vec<(u16, Vec<u8>)>,
}

impl Row {
    fn find(&self, kind: u16) -> Option<&[u8]> {
        self.attrs.iter().find(|(k, _)| *k == kind).map(|(_, v)| v.as_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes_are_four_byte_aligned_and_read_back() {
        let mut out = Vec::new();
        nla_str(&mut out, NFTA_TABLE_NAME, "wsp");
        nla_be32(&mut out, NFTA_CHAIN_POLICY, NF_ACCEPT);
        assert_eq!(out.len(), 8 + 8);
        let read = attrs(&out);
        assert_eq!(read.len(), 2);
        assert_eq!((read[0].0, text(read[0].1)), (NFTA_TABLE_NAME, "wsp".to_owned()));
        assert_eq!((read[1].0, be32(read[1].1)), (NFTA_CHAIN_POLICY, Some(1)));
    }

    #[test]
    fn a_message_carries_the_subsystem_the_family_and_its_attributes() {
        let bytes = new_table(NFPROTO_IPV4, "wsp").encode(7);
        assert_eq!(u32::from_ne_bytes(bytes[0..4].try_into().unwrap()) as usize, bytes.len());
        assert_eq!(u16::from_ne_bytes(bytes[4..6].try_into().unwrap()), (10 << 8) | NFT_MSG_NEWTABLE);
        assert_eq!(u16::from_ne_bytes(bytes[6..8].try_into().unwrap()), NLM_F_CREATE);
        assert_eq!(u32::from_ne_bytes(bytes[8..12].try_into().unwrap()), 7);
        assert_eq!(bytes[16], NFPROTO_IPV4);
        let read = messages(&bytes);
        assert_eq!((read.len(), read[0].seq), (1, 7));
        assert_eq!(text(attrs(&read[0].body[NFGENMSG..])[0].1), "wsp");
    }

    #[test]
    fn a_rule_lists_its_expressions_by_name_and_carries_a_comment_nft_reads() {
        let exprs: Vec<Expr> = iifname_starts("wsp-").into_iter().chain([verdict(NF_ACCEPT)]).collect();
        let msg = new_rule(NFPROTO_IPV4, "filter", "FORWARD", &exprs, "wsp workspaces", true);
        assert_eq!(msg.flags, NLM_F_CREATE, "at the head means no append flag");
        let top = attrs(&msg.attrs);
        let list = top.iter().find(|(k, _)| *k == NFTA_RULE_EXPRESSIONS).unwrap().1;
        let names: Vec<String> = attrs(list).iter().map(|(_, e)| text(attrs(e)[0].1)).collect();
        assert_eq!(names, ["meta", "cmp", "immediate"]);
        let udata = top.iter().find(|(k, _)| *k == NFTA_RULE_USERDATA).unwrap().1;
        assert_eq!(comment_of_udata(udata), Some("wsp workspaces".to_owned()));
        assert_eq!(new_rule(NFPROTO_IPV4, "wsp", "forward", &exprs, "x", false).flags, NLM_F_CREATE | NLM_F_APPEND);
    }

    #[test]
    fn the_prefix_compare_reads_the_prefix_bytes_and_the_range_compare_masks_the_network() {
        let [_, cmp] = iifname_starts("wsp-");
        let data = attrs(&cmp.data);
        assert_eq!(be32(data[1].1), Some(NFT_CMP_EQ));
        assert_eq!(attrs(data[2].1)[0].1, b"wsp-");
        let [_, mask, cmp] = ip_addr_in(false, std::net::Ipv4Addr::new(10, 65, 7, 9), 16, false);
        let mask_value = attrs(attrs(&mask.data).iter().find(|(k, _)| *k == NFTA_BITWISE_MASK).unwrap().1)[0].1.to_vec();
        assert_eq!(mask_value, [255, 255, 0, 0]);
        assert_eq!(attrs(attrs(&cmp.data)[2].1)[0].1, [10, 65, 0, 0], "the host bits are masked off");
        let [_, _, not] = ip_addr_in(true, std::net::Ipv4Addr::new(10, 65, 0, 0), 16, true);
        assert_eq!(be32(attrs(&not.data)[1].1), Some(NFT_CMP_NEQ));
    }

    #[test]
    fn the_verdict_nests_its_code_and_the_conntrack_mask_is_established_or_related() {
        let accept = verdict(NF_ACCEPT);
        let data = attrs(&accept.data);
        let inner = attrs(attrs(data[1].1)[0].1);
        assert_eq!((inner[0].0, be32(inner[0].1)), (NFTA_VERDICT_CODE, Some(NF_ACCEPT)));
        let [ct, masked, cmp] = ct_established_or_related();
        assert_eq!((ct.name, masked.name, cmp.name), ("ct", "bitwise", "cmp"));
        let mask = attrs(attrs(&masked.data).iter().find(|(k, _)| *k == NFTA_BITWISE_MASK).unwrap().1)[0].1.to_vec();
        assert_eq!(mask, 6u32.to_ne_bytes());
    }

    fn error_message(seq: u32, errno: i32) -> Vec<u8> {
        let mut body = (-errno).to_ne_bytes().to_vec();
        body.extend([0u8; 16]);
        let mut out = Vec::new();
        out.extend(((NLMSG_HEADER + body.len()) as u32).to_ne_bytes());
        out.extend(NLMSG_ERROR.to_ne_bytes());
        out.extend(0u16.to_ne_bytes());
        out.extend(seq.to_ne_bytes());
        out.extend(0u32.to_ne_bytes());
        out.extend(body);
        out
    }

    #[test]
    fn a_batch_counts_its_acks_and_a_refusal_on_a_bracket_ends_the_wait_by_name() {
        let mut datagram = error_message(11, 0);
        datagram.extend(error_message(12, 0));
        assert_eq!(batch_answers(&datagram, &[11, 12], [10, 13]).unwrap(), 2);
        let refused = batch_answers(&error_message(12, 1), &[11, 12], [10, 13]).unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::PermissionDenied);
        assert!(refused.to_string().starts_with("message 2 of 2: "), "{refused}");
        let bracket_refused = batch_answers(&error_message(10, 22), &[11, 12], [10, 13]).unwrap_err();
        assert!(bracket_refused.to_string().starts_with("the batch itself: "), "{bracket_refused}");
        assert_eq!(batch_answers(&error_message(99, 22), &[11, 12], [10, 13]).unwrap(), 0, "another socket's sequence is not ours");
    }

    #[test]
    fn a_rule_is_read_back_with_its_expression_names_and_its_verdict() {
        let exprs: Vec<Expr> = iifname_starts("wsp-").into_iter().chain([verdict(NF_DROP)]).collect();
        let msg = new_rule(NFPROTO_IPV4, "t", "c", &exprs, "x", false);
        let list = attrs(&msg.attrs).into_iter().find(|(k, _)| *k == NFTA_RULE_EXPRESSIONS).unwrap().1;
        assert_eq!(exprs_of(list), (vec!["meta".to_owned(), "cmp".to_owned(), "immediate".to_owned()], Some(NF_DROP)));
        let bare_reject = RuleRow { handle: 1, comment: None, exprs: vec!["counter".into(), "reject".into()], verdict: None };
        let bare_drop = RuleRow { handle: 2, comment: None, exprs: vec!["immediate".into()], verdict: Some(NF_DROP) };
        let matched_drop =
            RuleRow { handle: 3, comment: None, exprs: vec!["meta".into(), "cmp".into(), "immediate".into()], verdict: Some(NF_DROP) };
        let bare_accept = RuleRow { handle: 4, comment: None, exprs: vec!["immediate".into()], verdict: Some(NF_ACCEPT) };
        assert!(bare_reject.refuses_all() && bare_drop.refuses_all());
        assert!(!matched_drop.refuses_all() && !bare_accept.refuses_all());
        let [_, whole] = iifname_is("eth0");
        assert_eq!(attrs(attrs(&whole.data)[2].1)[0].1.len(), IFNAMSIZ);
        assert_eq!(attrs(attrs(&oifname_is("eth0")[1].data)[2].1)[0].1.len(), IFNAMSIZ);
        assert_eq!(attrs(&reject().data).len(), 2);
        // A rule reads back as the chain it names, its expressions and its comment, which is what a table this
        // daemon would write is compared to the kernel's by.
        let shape = shape_of(&new_rule(NFPROTO_IPV4, "wsp", "forward", &exprs, "wsp workspaces", false));
        assert_eq!(
            shape,
            Some((
                "forward".to_owned(),
                vec!["meta".to_owned(), "cmp".to_owned(), "immediate".to_owned()],
                Some("wsp workspaces".to_owned())
            ))
        );
        assert_eq!(shape_of(&new_table(NFPROTO_IPV4, "wsp")), None);
    }

    /// The two expressions a port drop is made of, and the conntrack match written the way iptables writes it.
    #[test]
    fn a_port_compare_reads_the_transport_header_and_the_conntrack_match_is_iptables_own() {
        let [proto, is_tcp] = l4proto_tcp();
        assert_eq!((proto.name, is_tcp.name), ("meta", "cmp"));
        assert_eq!(be32(attrs(&proto.data)[0].1), Some(NFT_META_L4PROTO));
        assert_eq!(attrs(attrs(&is_tcp.data)[2].1)[0].1, [IPPROTO_TCP]);
        let [load, is_port] = tcp_dport_is(7070);
        assert_eq!((load.name, is_port.name), ("payload", "cmp"));
        let fields = attrs(&load.data);
        assert_eq!(be32(fields[1].1), Some(NFT_PAYLOAD_TRANSPORT_HEADER));
        assert_eq!((be32(fields[2].1), be32(fields[3].1)), (Some(2), Some(2)));
        assert_eq!(attrs(attrs(&is_port.data)[2].1)[0].1, 7070u16.to_be_bytes());
        let xt = xt_ct_established_or_related();
        assert_eq!(xt.name, "match");
        let fields = attrs(&xt.data);
        assert_eq!(text(fields[0].1), "conntrack");
        assert_eq!(be32(fields[1].1), Some(XT_CONNTRACK_REVISION));
        let info = fields[2].1;
        assert_eq!(info.len(), XT_CONNTRACK_INFO);
        assert_eq!(info[XT_CONNTRACK_MATCH_FLAGS..XT_CONNTRACK_MATCH_FLAGS + 2], XT_CONNTRACK_STATE.to_ne_bytes());
        assert_eq!(info[XT_CONNTRACK_STATE_MASK..XT_CONNTRACK_STATE_MASK + 2], XT_CONNTRACK_STATE_ESTABLISHED_OR_RELATED.to_ne_bytes());
        assert!(info.iter().enumerate().all(|(at, byte)| *byte == 0
            || (XT_CONNTRACK_MATCH_FLAGS..XT_CONNTRACK_MATCH_FLAGS + 2).contains(&at)
            || (XT_CONNTRACK_STATE_MASK..XT_CONNTRACK_STATE_MASK + 2).contains(&at)));
    }

    #[test]
    fn an_error_message_reads_its_errno_and_a_batch_begins_and_ends_with_the_subsystem() {
        let mut body = (-1i32).to_ne_bytes().to_vec();
        body.extend([0u8; 16]);
        assert_eq!(errno_of(&body), -1);
        let begin = bracket(NFNL_MSG_BATCH_BEGIN, 3);
        assert_eq!(begin.len(), 20);
        assert_eq!(u16::from_be_bytes([begin[18], begin[19]]), NFNL_SUBSYS_NFTABLES);
    }
}
