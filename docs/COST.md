# Cost and limits

Simulation, receipt replay and normal tests allocate no Solari resources. Live workflow requests one browser session and, only after successful acquisition/release, one sandbox (1 CPU, 2048 MiB, base template). Processing is sequential with no workflow retries.

Work budgets are 45 seconds each, with 10-second cleanup budgets. The sandbox requests a 60-second idle timeout with kill policy; that is not a hard wall-clock billing guarantee. SDK/network ambiguity may outlive a local deadline. Review provider usage when cleanup is uncertain.

Input is at most 100 rows per side and 256 KiB; selected capture fragments at most 64 KiB. Live serialized processor input is additionally limited to 90,000 bytes to fit the encoded command argument. Output is capped at 512 KiB. No LLM, database or hosted application costs. Local Python replay adds a small bounded CPU cost.

No dollar estimate is asserted: actual charges depend on the user's Solari plan, allocation/startup latency and provider billing rules. Consult current provider billing before running. This implementation is not evidence of customer savings or production demand.
