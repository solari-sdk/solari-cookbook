// SPDX-License-Identifier: AGPL-3.0-only
//! The TypeScript the protocol package reads is written from these types by `scripts/ts-types.sh`. The files are
//! held by a diff in CI; these cases hold the readings a wrong setting or a missing attribute would change without
//! any compile error on either side.

use ts_rs::{Config, TS};
use wsp_frames::{
    DaemonAuthRequest, DaemonErrorResponse, DaemonEvent, DaemonOp, FsListReply, ListeningPort, MachineOp, PlaceAuthRequest,
    PlaceProveRequest, DAEMON_OPS, MACHINE_OPS,
};

fn decl<T: TS>() -> String {
    T::decl(&Config::from_env())
}

#[test]
fn a_u64_is_a_number_since_json_never_carries_a_bigint() {
    assert_eq!(decl::<FsListReply>(), "type FsListReply = { entries: Array<FsEntry>, truncated: boolean, total: number, };");
}

#[test]
fn a_field_the_wire_leaves_out_is_optional_and_never_null() {
    let op = decl::<DaemonOp>();
    assert!(op.contains(r#"{ "op": "pty.create", cols?: number, rows?: number, shell?: string, "#), "{op}");
    assert!(!op.contains("| null"), "{op}");
    let event = decl::<DaemonEvent>();
    assert!(event.contains(r#"{ "type": "daemon.hello", root: string, version?: number, }"#), "{event}");
    assert!(!event.contains("| null"), "{event}");
}

#[test]
fn a_field_the_wire_carries_as_null_stays_required() {
    let port = decl::<ListeningPort>();
    assert!(port.contains("pid: number | null, inode?: number,"), "{port}");
    let refusal = decl::<DaemonErrorResponse>();
    assert!(
        refusal.starts_with("type DaemonErrorResponse = { id: RequestId | null, ok: false, error: string, code?: DaemonErrorCode,"),
        "{refusal}"
    );
}

#[test]
fn a_first_frame_names_its_op_as_the_literal_it_carries() {
    assert!(decl::<DaemonAuthRequest>().contains(r#"op: "auth""#));
    assert!(decl::<PlaceAuthRequest>().contains(r#"op: "place.auth""#));
    assert!(decl::<PlaceProveRequest>().contains(r#"op: "place.prove""#));
    let a = decl::<PlaceAuthRequest>();
    assert!(a.contains("nonce: string, ephemeral: string"), "{a}");
}

#[test]
fn every_op_the_daemon_knows_is_a_member_of_the_union_the_client_narrows_on() {
    let daemon = decl::<DaemonOp>();
    for op in DAEMON_OPS {
        assert!(daemon.contains(&format!(r#"{{ "op": "{op}""#)), "{op} is not in {daemon}");
    }
    assert_eq!(daemon.matches(r#"{ "op": "#).count(), DAEMON_OPS.len());
    let machine = decl::<MachineOp>();
    for op in MACHINE_OPS {
        assert!(machine.contains(&format!(r#"{{ "op": "{op}""#)), "{op} is not in {machine}");
    }
    assert_eq!(machine.matches(r#"{ "op": "#).count(), MACHINE_OPS.len());
}
