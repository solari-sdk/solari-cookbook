# Delivery Proof (TypeScript)

Open a sandbox with a clean filesystem and process namespace, run an installer's own commands
against it exactly as written, then check what should now be true: a command exits zero, a file
exists with the right content, a port answers, and a whole directory tree matches what was
declared — nothing more. Every run leaves an offline evidence bundle behind: what ran, what was
observed, what failed.

Freshness, stated honestly: clean filesystem and process namespace per session; distinct machine
id; not a cold boot.

The installer here is a synthetic fixture — two inline shell scripts, one of them deliberately
broken — so the recipe has no server, no build step, nothing past the Solari SDK and a YAML
parser to install. Swap `fixtures/installer.sh` and `delivery.yaml` for your own installer and
contract.

## Run

```bash
cd examples/delivery-proof-ts
cp .env.example .env      # SOLARI_API_KEY
npm install
npm start
```

`DELIVERY_PROOF_BROKEN=1 npm start` swaps in the broken fixture, so the failure path is one env
var away. `npm start -- --spec other.yaml` points at a different delivery spec.

Exit code is the contract: `0` every probe passed, `1` a deliver step or a probe failed, `2` the
run could not provision, finish, or clean up. The sandbox is always torn down, even on failure.

This checks one reading of "delivered" — the declared commands ran and the declared checks pass.
A fuller tool would add a second substrate and an advisory diagnosis when a probe fails; neither
exists as a published tool yet.

Source: [`index.ts`](index.ts)
