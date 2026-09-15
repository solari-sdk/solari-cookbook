"""Run an OpenAI Agents SDK SandboxAgent inside a Solari microVM.

Prerequisites:
    pip install "openai-agents"            # the Agents SDK (>=0.22)
    pip install solari-sandbox             # Solari Python SDK
    pip install -e ..                      # this provider (solari_agents_sandbox)
    export OPENAI_API_KEY="sk-..."
    export SOLARI_API_KEY="slr_live_..."

Then:
    python coding_agent.py
"""

import asyncio

from agents import Runner
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig

from solari_agents_sandbox import SolariSandboxClient, SolariSandboxClientOptions


def build_agent(model: str = "gpt-5.6-sol") -> SandboxAgent:
    # Default capabilities (Shell + Filesystem + Compaction) are what a coding
    # agent needs; pass an explicit list only to add Skills/Memory.
    return SandboxAgent(
        name="Solari sandbox engineer",
        model=model,
        instructions=(
            "You are working inside a fresh Linux sandbox. Use the shell to create "
            "and run code, verify with a command, and report exactly what you ran."
        ),
    )


async def main() -> None:
    client = SolariSandboxClient()  # reads SOLARI_API_KEY / SOLARI_BASE_URL
    result = await Runner.run(
        build_agent(),
        "Write a Python script fib.py that prints the first 15 Fibonacci numbers, "
        "run it, and show me the output.",
        run_config=RunConfig(
            sandbox=SandboxRunConfig(
                client=client,
                options=SolariSandboxClientOptions(
                    mem_mb=2048,
                    # keep the microVM warm so a follow-up run can `resume` it
                    pause_on_exit=True,
                ),
            ),
            workflow_name="Solari coding example",
        ),
    )
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
