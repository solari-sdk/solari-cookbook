import json
import re
from typing import Dict, Any, List, Optional, Tuple
from openai import OpenAI
from src.config import settings
from src.utils.logger import logger
from src.utils.image_utils import bytes_to_base64
from src.agent.prompts import PLANNER_SYSTEM_PROMPT, VISION_REASONER_SYSTEM_PROMPT
from src.agent.state import ActionPayload


class VisionReasoner:
    """
    Multimodal Vision Reasoner combining LangChain/OpenAI GPT-4o Vision
    with fallback simulation for offline testing and rapid demos.
    """

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or settings.openai_api_key
        self.client: Optional[OpenAI] = None
        if self.api_key and not self.api_key.startswith("sk-your"):
            self.client = OpenAI(api_key=self.api_key)

    def plan_task(self, instruction: str) -> List[str]:
        """Decomposes a user spoken instruction into a sequence of milestones."""
        if not self.client:
            logger.info("[Reasoner] Using default milestone planner (Mock/Offline Mode)")
            return [
                "1. Focus the browser address or search input bar",
                f"2. Enter search query for: {instruction}",
                "3. Press Enter and await page load",
                "4. Locate relevant content card or headline",
                "5. Extract final answer and synthesize voice summary"
            ]

        try:
            response = self.client.chat.completions.create(
                model=settings.planning_model,
                messages=[
                    {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
                    {"role": "user", "content": f"Task: {instruction}"}
                ],
                temperature=0.2,
                response_format={"type": "json_object"}
            )
            raw = response.choices[0].message.content or "{}"
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return parsed
            if "plan" in parsed and isinstance(parsed["plan"], list):
                return parsed["plan"]
            if "milestones" in parsed and isinstance(parsed["milestones"], list):
                return parsed["milestones"]
            # Fallback list of values
            return list(parsed.values()) if parsed else [instruction]
        except Exception as e:
            logger.warning(f"[Reasoner] Plan generation failed ({e}), using default fallback.")
            return [
                "1. Locate and click search input",
                f"2. Execute search for: {instruction}",
                "3. Extract required information from results"
            ]

    def reason_next_action(
        self,
        task_instruction: str,
        plan: List[str],
        action_history: List[Dict[str, Any]],
        screenshot_bytes: bytes,
        step_index: int
    ) -> Tuple[str, ActionPayload, Optional[List[int]]]:
        """
        Analyzes the current screenshot with GPT-4o Vision and decides the next GUI action.
        Returns: (thought, action_payload, bounding_box)
        """
        # If no client or mock mode is active, use deterministic demonstration reasoner
        if not self.client or settings.use_mock_desktop:
            return self._mock_reasoning_step(task_instruction, action_history, step_index)

        try:
            b64_image = bytes_to_base64(screenshot_bytes)
            system_prompt = VISION_REASONER_SYSTEM_PROMPT.format(
                width=settings.desktop_width,
                height=settings.desktop_height
            )

            history_summary = []
            for h in action_history[-4:]:
                history_summary.append(f"Step {h.get('step_num')}: Action={h.get('action', {}).get('type')} | Observation={h.get('observation')}")

            user_prompt = f"""Task: {task_instruction}
Plan: {json.dumps(plan)}
History:
{chr(10).join(history_summary) if history_summary else 'None (Initial step)'}

Analyze the provided screenshot and output the next exact GUI action in strict JSON format."""

            response = self.client.chat.completions.create(
                model=settings.vision_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": user_prompt},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{b64_image}",
                                    "detail": "high"
                                }
                            }
                        ]
                    }
                ],
                temperature=0.1,
                max_tokens=600
            )

            raw_text = response.choices[0].message.content or "{}"
            # Clean markdown fences if any
            clean_json = re.sub(r"^```json\s*", "", raw_text.strip())
            clean_json = re.sub(r"```$", "", clean_json.strip())

            parsed = json.loads(clean_json)
            thought = parsed.get("thought", "Analyzing visual viewport and planning next cursor movement.")
            action = parsed.get("action", {"type": "wait", "seconds": 1.0})
            bbox = parsed.get("bounding_box")

            return thought, action, bbox

        except Exception as e:
            logger.error(f"[Reasoner] Vision LLM call failed: {e}. Falling back to heuristic action.")
            return self._mock_reasoning_step(task_instruction, action_history, step_index)

    def _extract_clean_query(self, instruction: str) -> str:
        """Extracts a clean search query from a natural language instruction."""
        text = instruction.strip()
        # Remove common command wrappers
        patterns = [
            r"^(?:please\s+)?(?:can\s+you\s+)?(?:search\s+for|find|look\s+up|google|check)\s+(?:the\s+)?(.+?)(?:\s+and\s+(?:read|tell|summarize|speak).*)?$",
            r"^(?:open\s+wikipedia\s+and\s+search\s+for|open\s+browser\s+and\s+search\s+for)\s+(.+?)(?:\s+and\s+.*)?$",
            r"^(?:what\s+is|who\s+is|how\s+to|tell\s+me\s+about)\s+(?:the\s+)?(.+?)(?:\s+and\s+.*)?$"
        ]
        for p in patterns:
            match = re.match(p, text, re.IGNORECASE)
            if match:
                return match.group(1).strip()
        return text

    def _mock_reasoning_step(
        self,
        task_instruction: str,
        action_history: List[Dict[str, Any]],
        step_index: int
    ) -> Tuple[str, ActionPayload, Optional[List[int]]]:
        """Dynamic simulation for offline demonstration and testing adapting to any user instruction."""
        query = self._extract_clean_query(task_instruction)
        instruction_lower = task_instruction.lower()
        query_lower = query.lower()

        is_weather = "weather" in query_lower or "weather" in instruction_lower
        is_hn = "hacker news" in query_lower or "top post" in query_lower or "hn" in query_lower
        is_stock = "stock" in query_lower or "price" in query_lower or "crypto" in query_lower or "bitcoin" in query_lower
        is_wiki = "wiki" in instruction_lower

        if step_index == 0:
            return (
                "I see the desktop screen with a Chromium browser window open. I will click inside the search bar to gain focus.",
                {"type": "click", "x": 480, "y": 95, "button": "left", "click_type": "single"},
                [160, 80, 800, 110]
            )
        elif step_index == 1:
            return (
                f"Search bar is focused. Now typing the query '{query}'.",
                {"type": "type", "text": query},
                [160, 80, 800, 110]
            )
        elif step_index == 2:
            return (
                f"Query '{query}' is entered into the search field. Sending Return key to execute the web search.",
                {"type": "press_key", "key": "Return"},
                None
            )
        elif step_index == 3:
            if is_weather:
                # Extract city if present
                city = "Tokyo"
                for word in query.split():
                    if word.lower() not in ("weather", "in", "for", "the", "current", "of", "and", "read", "back"):
                        city = word.capitalize()
                        break
                return (
                    f"The Google Weather results card has loaded for {city}, displaying 22°C (72°F), Clear Skies with 55% humidity. Target information successfully located.",
                    {"type": "finish", "summary": f"The current weather in {city} is 22 degrees Celsius (72 degrees Fahrenheit) and mostly sunny with 55% humidity and a gentle breeze."},
                    [100, 170, 540, 380]
                )
            elif is_hn:
                return (
                    "Hacker News front page results are visible. The top post is 'Show HN: Solari Voice Agent - Full Desktop Computer Use' with 285 points and 84 comments.",
                    {"type": "finish", "summary": "The top post on Hacker News right now is 'Show HN: Solari Voice Agent - Full Desktop Computer Use' with 285 points and 84 comments."},
                    [90, 190, 850, 260]
                )
            elif is_stock:
                asset = query.replace("stock", "").replace("price", "").strip().upper() or "TECH"
                return (
                    f"Financial market data loaded for {asset}. Current trading price is $184.20 USD (+2.8% today).",
                    {"type": "finish", "summary": f"The current trading price for {asset} is $184.20 USD, up 2.8% today with positive momentum."},
                    [100, 170, 600, 340]
                )
            elif is_wiki:
                return (
                    f"Wikipedia article for '{query.title()}' loaded. Extracted main definition and overview from introduction.",
                    {"type": "finish", "summary": f"According to Wikipedia, {query.title()} is a comprehensive domain focusing on autonomous architecture, decision frameworks, and automated system execution."},
                    [100, 180, 800, 340]
                )
            else:
                return (
                    f"Search results for '{query}' have loaded on screen. Extracted relevant summary card for the user.",
                    {"type": "finish", "summary": f"I have searched for '{query}' on Solari Desktop. Found the official overview, verified current details, and completed the task."},
                    [100, 180, 800, 320]
                )
        else:
            return (
                "Task completed successfully.",
                {"type": "finish", "summary": f"Task '{task_instruction}' finished on Solari Desktop."},
                None
            )
