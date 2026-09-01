from app.workflows import Playbook, PriorityWorkflowQueue, StepCondition, WorkflowEngine, WorkflowStep, diff_workflow_runs


def test_workflow_parallel_conditions_retries_fallback_and_review():
    attempts = {"flaky": 0}

    def seed(context):
        return {"enabled": True, "value": 3}

    def double(context):
        return context["dependencies"]["seed"]["value"] * 2

    def flaky(context):
        attempts["flaky"] += 1
        raise RuntimeError("temporary")

    engine = WorkflowEngine({"seed": seed, "double": double, "flaky": flaky, "fallback": lambda context: "recovered", "reviewed": lambda context: "approved"}, max_workers=3)
    playbook = Playbook(id="demo", name="Demo", steps=[
        WorkflowStep(id="seed", action="seed"),
        WorkflowStep(id="double", action="double", depends_on=["seed"], condition=StepCondition(step_id="seed", key="enabled", operator="truthy")),
        WorkflowStep(id="flaky", action="flaky", depends_on=["seed"], retries=1, fallback_action="fallback"),
        WorkflowStep(id="review", action="reviewed", depends_on=["double", "flaky"], requires_review=True),
    ])

    waiting = engine.run(playbook, {"case": "public"})
    assert waiting.status == "waiting_review"
    assert waiting.waiting_for_review == ["review"]
    assert waiting.outputs["double"] == 6
    assert waiting.outputs["flaky"] == "recovered"

    completed = engine.run(playbook, {"case": "public"}, approvals={"review"})
    assert completed.status == "success"
    assert completed.outputs["review"] == "approved"
    assert attempts["flaky"] == 4


def test_workflow_batch_rerun_diff_and_priority_queue():
    engine = WorkflowEngine({"target": lambda context: context["inputs"]["target"]})
    playbook = Playbook(id="targets", name="Targets", steps=[WorkflowStep(id="target", action="target")])
    runs = engine.run_batch(playbook, ["a", "b"])
    assert [run.outputs["target"] for run in runs] == ["a", "b"]
    rerun = engine.rerun(playbook, runs[0])
    assert diff_workflow_runs(runs[0], rerun)["changed"] is False

    queue = PriorityWorkflowQueue()
    queue.push("low", {}, priority=100)
    queue.push("high", {}, priority=1)
    assert len(queue) == 2
    assert queue.pop()["playbook_id"] == "high"
    assert queue.pop()["playbook_id"] == "low"
