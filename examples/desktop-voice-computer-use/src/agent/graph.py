import asyncio
from datetime import datetime
from typing import Callable, Optional, Dict, Any
from langgraph.graph import StateGraph, END
from src.agent.state import AgentState, AgentStepLog, ActionPayload
from src.agent.vision_reasoner import VisionReasoner
from src.desktop.interface import BaseDesktopClient
from src.voice.tts import VoiceSynthesizer
from src.utils.image_utils import bytes_to_base64, annotate_screenshot
from src.utils.logger import logger, log_action_card
from src.config import settings


class VoiceComputerUseGraph:
    """
    LangGraph agent workflow for Voice-Directed Computer-Use.
    Coordinates the Screenshot -> Vision Reasoning -> Solari Desktop Action -> TTS loop.
    """

    def __init__(
        self,
        desktop_client: BaseDesktopClient,
        reasoner: Optional[VisionReasoner] = None,
        synthesizer: Optional[VoiceSynthesizer] = None,
        on_event_callback: Optional[Callable[[str, Dict[str, Any]], Any]] = None
    ):
        self.desktop = desktop_client
        self.reasoner = reasoner or VisionReasoner()
        self.synthesizer = synthesizer or VoiceSynthesizer()
        self.on_event_callback = on_event_callback
        self.workflow = self._build_graph()

    async def _emit_event(self, event_type: str, data: Dict[str, Any]) -> None:
        """Emits an event to the observability War Room WebSocket."""
        if self.on_event_callback:
            try:
                res = self.on_event_callback(event_type, data)
                if asyncio.iscoroutine(res):
                    await res
            except Exception as e:
                logger.debug(f"[Graph] Event emit error: {e}")

    def _build_graph(self):
        builder = StateGraph(AgentState)

        # 1. Add Nodes
        builder.add_node("planner", self._planner_node)
        builder.add_node("perceive", self._perception_node)
        builder.add_node("reason", self._reasoning_node)
        builder.add_node("execute", self._execution_node)
        builder.add_node("synthesize", self._synthesize_node)

        # 2. Set Entry Point
        builder.set_entry_point("planner")

        # 3. Add Transitions
        builder.add_edge("planner", "perceive")
        builder.add_edge("perceive", "reason")

        # Conditional routing after reasoning
        builder.add_conditional_edges(
            "reason",
            self._route_after_reason,
            {
                "execute": "execute",
                "synthesize": "synthesize"
            }
        )

        # Conditional routing after execution
        builder.add_conditional_edges(
            "execute",
            self._route_after_execute,
            {
                "perceive": "perceive",
                "synthesize": "synthesize"
            }
        )

        builder.add_edge("synthesize", END)

        return builder.compile()

    # --- Node Implementations ---

    async def _planner_node(self, state: AgentState) -> Dict[str, Any]:
        """Plans high-level milestones for the voice instruction."""
        logger.info(f"[Graph] 🧠 Planning task for instruction: \"{state['task_instruction']}\"")
        await self._emit_event("status_update", {"status": "PLANNING", "instruction": state["task_instruction"]})

        plan = self.reasoner.plan_task(state["task_instruction"])
        logger.info(f"[Graph] Generated {len(plan)} milestones:")
        for idx, item in enumerate(plan):
            logger.info(f"   {item}")

        await self._emit_event("plan_generated", {"plan": plan})
        return {
            "plan": plan,
            "current_step": 0,
            "max_steps": state.get("max_steps", settings.max_steps),
            "action_history": [],
            "status": "PERCEIVING"
        }

    async def _perception_node(self, state: AgentState) -> Dict[str, Any]:
        """Captures a screenshot from Solari Desktop."""
        logger.info("[Graph] 👁️ Perceiving screen from Solari Desktop...")
        await self._emit_event("status_update", {"status": "PERCEIVING", "step": state.get("current_step", 0)})

        screenshot_bytes = await self.desktop.screenshot()
        b64 = bytes_to_base64(screenshot_bytes)

        await self._emit_event("screenshot_update", {
            "step": state.get("current_step", 0),
            "screenshot_b64": b64
        })

        return {
            "screenshot_bytes": screenshot_bytes,
            "screenshot_b64": b64,
            "status": "REASONING"
        }

    async def _reasoning_node(self, state: AgentState) -> Dict[str, Any]:
        """Reasons over the screenshot with Vision LLM and decides the next action."""
        step_num = state.get("current_step", 0)
        logger.info(f"[Graph] 🤔 Step #{step_num} Reasoning over viewport...")
        await self._emit_event("status_update", {"status": "REASONING", "step": step_num})

        thought, action, bbox = self.reasoner.reason_next_action(
            task_instruction=state["task_instruction"],
            plan=state.get("plan", []),
            action_history=state.get("action_history", []),
            screenshot_bytes=state["screenshot_bytes"],
            step_index=step_num
        )

        log_action_card(
            step_num=step_num,
            thought=thought,
            action_type=action.get("type", "unknown"),
            action_details=str(action)
        )

        # Annotate screenshot with visual markers for the dashboard
        click_coords = (action["x"], action["y"]) if "x" in action and "y" in action else None
        annotated_bytes = annotate_screenshot(
            state["screenshot_bytes"],
            click_coords=click_coords,
            bounding_box=bbox or action.get("bounding_box"),
            action_label=f"{action.get('type')}"
        )
        annotated_b64 = bytes_to_base64(annotated_bytes)

        await self._emit_event("reasoning_update", {
            "step": step_num,
            "thought": thought,
            "action": action,
            "bounding_box": bbox,
            "annotated_screenshot_b64": annotated_b64
        })

        return {
            "thought": thought,
            "action": action,
            "annotated_screenshot_bytes": annotated_bytes,
            "status": "EXECUTING" if action.get("type") != "finish" else "COMPLETED"
        }

    async def _execution_node(self, state: AgentState) -> Dict[str, Any]:
        """Dispatches the action to Solari Desktop."""
        action = state["action"]
        action_type = action.get("type", "wait")
        step_num = state.get("current_step", 0)
        logger.info(f"[Graph] ⚡ Executing action: {action_type}")
        await self._emit_event("status_update", {"status": "EXECUTING", "step": step_num, "action": action_type})

        observation = "Action performed successfully"
        try:
            if action_type == "click":
                x = int(action.get("x", 0))
                y = int(action.get("y", 0))
                button = action.get("button", "left")
                click_type = action.get("click_type", "single")
                await self.desktop.mouse_click(x=x, y=y, button=button, click_type=click_type)
                observation = f"Clicked at ({x}, {y})"

            elif action_type == "type":
                text = action.get("text", "")
                await self.desktop.type_text(text=text)
                observation = f"Typed \"{text}\""

            elif action_type == "press_key":
                key = action.get("key", "Return")
                await self.desktop.press_key(key=key)
                observation = f"Pressed key '{key}'"

            elif action_type == "scroll":
                direction = action.get("direction", "down")
                amount = action.get("amount", 3)
                await self.desktop.scroll(direction=direction, amount=amount)
                observation = f"Scrolled {direction} by {amount}"

            elif action_type == "wait":
                secs = float(action.get("seconds", 1.0))
                await asyncio.sleep(secs)
                observation = f"Waited {secs} seconds"

            elif action_type == "exec":
                cmd = action.get("command", "")
                res = await self.desktop.exec_command(cmd)
                observation = f"Exec result: {res.get('stdout', '')[:100]}"

        except Exception as e:
            logger.error(f"[Graph] Action execution failed: {e}")
            observation = f"Error during execution: {str(e)}"

        # Record step log
        step_log: AgentStepLog = {
            "step_num": step_num,
            "thought": state.get("thought", ""),
            "action": action,
            "observation": observation,
            "timestamp": datetime.now().strftime("%H:%M:%S")
        }

        history = list(state.get("action_history", []))
        history.append(step_log)

        await self._emit_event("action_executed", {
            "step_num": step_num,
            "action": action,
            "observation": observation
        })

        return {
            "action_history": history,
            "current_step": step_num + 1,
            "status": "PERCEIVING"
        }

    async def _synthesize_node(self, state: AgentState) -> Dict[str, Any]:
        """Generates OpenAI TTS spoken summary of the task result."""
        summary = state.get("action", {}).get("summary") or state.get("summary") or f"Task '{state['task_instruction']}' finished."
        logger.info(f"[Graph] 🎙️ Synthesizing voice summary via OpenAI TTS: \"{summary}\"")
        await self._emit_event("status_update", {"status": "SYNTHESIZING_VOICE", "summary": summary})

        audio_uri = self.synthesizer.synthesize_to_data_uri(summary)
        
        # Also play locally if speaker is available
        audio_bytes = self.synthesizer.synthesize_to_bytes(summary)
        if audio_bytes:
            self.synthesizer.play_locally(audio_bytes)

        await self._emit_event("task_completed", {
            "summary": summary,
            "audio_uri": audio_uri,
            "total_steps": state.get("current_step", 0)
        })

        return {
            "summary": summary,
            "audio_uri": audio_uri,
            "task_completed": True,
            "status": "COMPLETED"
        }

    # --- Routing Conditionals ---

    def _route_after_reason(self, state: AgentState) -> str:
        if state.get("action", {}).get("type") == "finish":
            return "synthesize"
        return "execute"

    def _route_after_execute(self, state: AgentState) -> str:
        current_step = state.get("current_step", 0)
        max_steps = state.get("max_steps", settings.max_steps)
        if current_step >= max_steps:
            logger.warning(f"[Graph] Reached max step limit ({max_steps}). Finalizing.")
            return "synthesize"
        return "perceive"

    async def run(self, task_instruction: str) -> AgentState:
        """Executes the full LangGraph workflow for an instruction."""
        initial_state: AgentState = {
            "task_instruction": task_instruction,
            "plan": [],
            "current_step": 0,
            "max_steps": settings.max_steps,
            "screenshot_bytes": None,
            "annotated_screenshot_bytes": None,
            "screenshot_b64": None,
            "thought": "",
            "action": {},
            "action_history": [],
            "task_completed": False,
            "status": "PLANNING",
            "summary": "",
            "audio_uri": "",
            "error": None
        }

        final_state = await self.workflow.ainvoke(initial_state)
        return final_state
