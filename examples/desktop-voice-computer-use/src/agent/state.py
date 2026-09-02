from typing import List, Dict, Any, Optional, TypedDict


class ActionPayload(TypedDict, total=False):
    type: str  # "click", "type", "press_key", "scroll", "wait", "exec", "finish"
    x: Optional[int]
    y: Optional[int]
    button: Optional[str]
    click_type: Optional[str]
    text: Optional[str]
    key: Optional[str]
    direction: Optional[str]
    amount: Optional[int]
    seconds: Optional[float]
    command: Optional[str]
    summary: Optional[str]
    bounding_box: Optional[List[int]]


class AgentStepLog(TypedDict):
    step_num: int
    thought: str
    action: ActionPayload
    observation: str
    timestamp: str


class AgentState(TypedDict, total=False):
    # Core Task Info
    task_instruction: str
    plan: List[str]
    current_step: int
    max_steps: int

    # Vision & Perception State
    screenshot_bytes: Optional[bytes]
    annotated_screenshot_bytes: Optional[bytes]
    screenshot_b64: Optional[str]
    
    # Reasoning & Act
    thought: str
    action: ActionPayload
    action_history: List[AgentStepLog]
    
    # Final outcome
    task_completed: bool
    status: str  # "IDLE", "PLANNING", "PERCEIVING", "REASONING", "EXECUTING", "COMPLETED", "FAILED"
    summary: str
    audio_uri: str
    error: Optional[str]
