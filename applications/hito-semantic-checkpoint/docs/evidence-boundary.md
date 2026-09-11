# Evidence boundary and final smoke

Three kinds of evidence must remain distinct:

1. Historical R1/R1C/R2 summaries: distilled recorded integration evidence, with source hashes and JSON pointers. These experiments used the earlier, larger runtime.
2. Current local tests: the public routines execute over real local files; transport and remote lifecycle are simulated. These are not new Solari results.
3. A future exact-candidate live smoke: still required after publication review. Do not mark it complete based on the first two categories.

The final authorized smoke command would be `npm run demo -- both`: **at most four new Solari sandboxes**, two sequential A→B cases. One case alone costs at most two creations but would not exercise both public modes. No snapshot, volume, model or agent provider is involved.

Each allocation requests 1 vCPU and 2,048 MiB. The idle timeout is 60 seconds with kill-on-timeout; it is rolling, not a billing cap. Each case checks a 240-second controller budget before guest commands, whose own timeout is 30 seconds. Network and cleanup failures can exceed those nominal times. Dollar cost requires the current Solari rate; none is invented here. [Solari SDK documentation](https://docs.getsolari.com/sdk/typescript/sandboxes)

The transport guard counts create dispatch attempts, not just successful returned handles, and blocks SDK create retries. An unknown create outcome is not silently replaced. A confirmed kill plus structured numeric 404 or state `gone` is required for termination; prose matching is never accepted. Cleanup failure is explicit. `close()` alone is not destruction.

Evidence JSON records the session lineage, checkpoint, takeover observations, errors, and cleanup. The receipt is a projection of the JSON. No whole-disk, arbitrary RAM, verified fixture behavior, general repository coverage, deployment permission, performance improvement or economic benefit is claimed.

Historical R1 timing did not favor HITO on its tiny fixture. R2 snapshot/checkpoint sizes cover different things and do not establish compression superiority. R2 complementarity is not a claim that one primitive should replace the other.

The exact current application has not yet passed a live smoke. Reviewers should keep that limitation when describing this release candidate.
