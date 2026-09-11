# Public HITO subset and licensing boundary

The contribution includes **four retained function bodies**, totaling **5,201 bytes**, from the earlier bounded HITO observation implementation:

| Routine | Purpose |
|---|---|
| `artifact` | Bind a selected supporting observation to an artifact identity |
| `claimsFor` | Produce provenance-bearing documentary, structural or physical claims |
| `refresh` | Reclassify supporting currentness after fresh observations |
| `assessAcquisitionContradictions` | Preserve bounded contradiction and blocking outcomes |

The retained bodies are in `src/hito-observation.cjs`. Their hash-bound origin and local parity verification are recorded in the release review packet. Helpers supply hashing, the restricted path predicate and a required explicit reader. The broader filesystem acquisition and private persistence dependencies are not copied.

`src/observation.cjs` is the public application wrapper. It supplies three fixed selections, conservative public scope limits, strict envelope validation and a logical demonstration subject. It does not pretend to implement the full canonical HITO protocol, adaptive discovery, governance, migration, agent memory, or a whole-project semantic model.

The receipt takes its claims and currentness from these structured results. It does not create an alternative semantic verdict or infer permissions from prose. Conservative scope notices describe what this bounded application does not observe; they do not upgrade private HITO unknowns into facts.

This application-specific contribution, including the selected routines and original fixtures, is prepared under MIT. That grant is scoped to this directory. **The full private HITO project is separate and is not licensed, copied, or made a runtime dependency by this contribution.** No unrelated research source, private schemas, project history, benchmark repository or unexecuted agent scaffold is included.
