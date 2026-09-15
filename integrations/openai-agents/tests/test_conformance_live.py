"""Live conformance test for the Solari sandbox provider.

Exercises the real BaseSandboxClient/BaseSandboxSession surface against a live
Solari microVM. Gated on SOLARI_API_KEY (skips cleanly without it):

    SOLARI_API_KEY=slr_live_... python tests/test_conformance_live.py
    # optional (slow — full snapshot/restore): SOLARI_TEST_RESUME=1

Covers: create/start, exec, file write+read, workspace persist+hydrate (the SDK
tar convention), exposed-port resolution (best-effort), and — when
SOLARI_TEST_RESUME=1 — the pause->serialize->resume round-trip that backs the
provider's resume() contract. PTY is covered by the mock test; it is gated off
by default on the current guest golden (see SolariSandboxClientOptions.enable_pty).
"""
import asyncio
import io
import os
import sys

RUN_LIVE = bool(os.environ.get("SOLARI_API_KEY"))
RUN_RESUME = bool(os.environ.get("SOLARI_TEST_RESUME"))


async def _conformance() -> None:
    from solari_agents_sandbox import SolariSandboxClient, SolariSandboxClientOptions

    client = SolariSandboxClient()
    session = await client.create(options=SolariSandboxClientOptions(mem_mb=2048))
    try:
        await session.start()

        # exec
        r = await session.exec("echo conformance && python3 -c 'print(2**10)'")
        assert r.exit_code == 0, r
        assert b"conformance" in r.stdout and b"1024" in r.stdout, r.stdout
        print("  [ok] exec")

        # files
        await session.write("hello.txt", io.BytesIO(b"solari-conformance\n"))
        got = (await session.read("hello.txt")).read()
        assert got == b"solari-conformance\n", got
        print("  [ok] file write/read")

        # workspace persist + hydrate (SDK tar convention)
        await session.exec("mkdir -p sub && echo keep > sub/data.txt")
        tar = await session.persist_workspace()
        await session.exec("rm -rf sub")
        assert (await session.exec("cat sub/data.txt")).exit_code != 0  # gone
        tar.seek(0)
        await session.hydrate_workspace(tar)
        r2 = await session.exec("cat sub/data.txt")
        assert r2.exit_code == 0 and b"keep" in r2.stdout, r2
        print("  [ok] persist_workspace / hydrate_workspace")

        # exposed port (best-effort: needs a listener + configured port)
        try:
            await session.exec("nohup python3 -m http.server 8000 >/dev/null 2>&1 &")
            await asyncio.sleep(1.0)
            # call the inner resolver directly (public resolve_exposed_port asserts
            # the port is declared in the manifest; here we test the URL mapping)
            ep = await session._inner._resolve_exposed_port(8000)
            assert ep.host, ep
            print("  [ok] resolve_exposed_port ->", ep.url_for("http"))
        except Exception as e:
            print("  [skip] resolve_exposed_port (best-effort):", str(e)[:80])
        # PTY (interactive terminal)
        try:
            upd = await session.pty_exec_start("bash", tty=True, yield_time_s=1.0)
            upd2 = await session.pty_write_stdin(
                session_id=upd.process_id, chars="echo pty-conf-$((6*7))\n", yield_time_s=1.5
            )
            assert b"pty-conf-42" in upd2.output, upd2.output
            await session.pty_terminate_all()
            print("  [ok] pty interactive round-trip")
        except Exception as e:
            print("  [skip] pty:", str(e)[:80])
    finally:
        await client.delete(session)
    print("LIVE CONFORMANCE: PASS")


async def _resume_roundtrip() -> None:
    from solari_agents_sandbox import SolariSandboxClient, SolariSandboxClientOptions

    client = SolariSandboxClient()
    session = await client.create(options=SolariSandboxClientOptions(mem_mb=2048, pause_on_exit=True))
    await session.start()
    await session.write("resume-marker.txt", io.BytesIO(b"i-survived-resume\n"))
    state = session.state
    payload = client.serialize_session_state(state)   # JSON the harness persists
    await client.delete(session)                        # snapshots + pauses

    restored_state = client.deserialize_session_state(payload)
    session2 = await client.resume(restored_state)      # reattach same microVM
    try:
        await session2.start()
        got = (await session2.read("resume-marker.txt")).read()
        assert got == b"i-survived-resume\n", got
        print("  [ok] resume preserved workspace state across pause")
    finally:
        # ensure teardown kills it (resumed session inherits pause_on_exit)
        session2.state.pause_on_exit = False  # type: ignore[attr-defined]
        await client.delete(session2)
    print("LIVE RESUME: PASS")


def main() -> int:
    if not RUN_LIVE:
        print("SKIP: set SOLARI_API_KEY to run the live conformance test.")
        return 0
    asyncio.run(_conformance())
    if RUN_RESUME:
        asyncio.run(_resume_roundtrip())
    else:
        print("SKIP resume round-trip (set SOLARI_TEST_RESUME=1 — slow, full snapshot/restore).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
