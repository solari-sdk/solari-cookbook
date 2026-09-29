"""Unit tests for Real LLM Agent integration in Fault Line."""

from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from faultline.llm_agent import RealLLMAgent, CRM_TOOLS_SCHEMA
from faultline.checkpoint import CheckpointManager
from faultline.diff_engine import StateDiffEngine
from faultline.fault_injection import get_fault_scenario
from faultline.llm_provider import LLMProvider
from faultline.localization import FaultLocalizer
from faultline.repair import CounterfactualRepairEngine
from faultline.server import app
from faultline.solari_adapter import SolariSandboxAdapter


class TestRealAgentIntegration(unittest.TestCase):
    def setUp(self):
        self.adapter = SolariSandboxAdapter(backend_override="offline")
        self.mock_sequence = [
            # 1-5: create_lead
            {"action": "create_lead", "args": {"name": "Acme Corp Lead", "email": "contact@acme.com", "company": "  acme corp  ", "owner": "Unassigned", "status": "new"}},
            {"action": "create_lead", "args": {"name": "Stark Industries Lead", "email": "tony@stark.com", "company": "stark inc", "owner": "Unassigned", "status": "new"}},
            {"action": "create_lead", "args": {"name": "Cyberdyne Systems Lead", "email": "sarah@cyberdyne.io", "company": "cyberdyne  ", "owner": "Unassigned", "status": "new"}},
            {"action": "create_lead", "args": {"name": "Wayne Enterprises Lead", "email": "bruce@wayne.org", "company": "WAYNE ENT", "owner": "Unassigned", "status": "new"}},
            {"action": "create_lead", "args": {"name": "Sartorial Tech Lead", "email": "info@sartorial.co", "company": "Sartorial", "owner": "Unassigned", "status": "new"}},
            # 6-10: normalize_company
            {"action": "normalize_company", "args": {"lead_id": 1}},
            {"action": "normalize_company", "args": {"lead_id": 2}},
            {"action": "normalize_company", "args": {"lead_id": 3}},
            {"action": "normalize_company", "args": {"lead_id": 4}},
            {"action": "normalize_company", "args": {"lead_id": 5}},
            # 11-15: assign_owner & validate_email
            {"action": "assign_owner", "args": {"lead_id": 1, "owner": "Alice"}},
            {"action": "assign_owner", "args": {"lead_id": 2, "owner": "Alice"}},
            {"action": "assign_owner", "args": {"lead_id": 3, "owner": "Alice"}},
            {"action": "validate_email", "args": {"lead_id": 1}},
            {"action": "validate_email", "args": {"lead_id": 2}},
            # 16-18: qualify leads
            {"action": "change_status", "args": {"lead_id": 1, "status": "qualified"}},
            {"action": "assign_owner", "args": {"lead_id": 1, "owner": "Alice"}},  # Target Step 17
            {"action": "change_status", "args": {"lead_id": 2, "status": "qualified"}},
            # 19-21: outbound messages
            {"action": "create_outbound_message", "args": {"lead_id": 1, "recipient": "contact@acme.com", "subject": "Partnership Proposal", "body": "Hello Acme, let us discuss."}},
            {"action": "create_outbound_message", "args": {"lead_id": 2, "recipient": "tony@stark.com", "subject": "Tech Sync", "body": "Hi Tony, demo ready."}},
            {"action": "create_outbound_message", "args": {"lead_id": 3, "recipient": "sarah@cyberdyne.io", "subject": "Intro Call", "body": "Greetings Sarah."}},
            # 22-24: send messages
            {"action": "send_message", "args": {"message_id": 1}},
            {"action": "send_message", "args": {"message_id": 2}},
            {"action": "send_message", "args": {"message_id": 3}},
        ]

    def test_missing_api_key_raises_error(self):
        """Test that missing API key cleanly reports credentials required."""
        with patch.dict(os.environ, {}, clear=True):
            provider = LLMProvider()
            self.assertFalse(provider.has_credentials())
            agent = RealLLMAgent(self.adapter, provider=provider)
            with self.assertRaises(RuntimeError) as ctx:
                import asyncio
                asyncio.run(agent.run_workload("test-run-nokey"))
            self.assertIn("LLM API Key missing", str(ctx.exception))

    def test_mock_llm_provider_tool_selection_and_execution(self):
        """Test mock LLM provider tool selection, tool execution, recording, and checkpoints."""
        provider = LLMProvider(mock_responses=self.mock_sequence)
        self.assertTrue(provider.has_credentials())
        agent = RealLLMAgent(self.adapter, provider=provider)

        import asyncio
        run_rec = asyncio.run(agent.run_workload("test-real-001"))

        self.assertEqual(run_rec.run_id, "test-real-001")
        self.assertEqual(run_rec.agent_status, "DONE")
        self.assertEqual(run_rec.verifier_status, "PASSED")
        self.assertEqual(len(run_rec.checkpoints), 25)  # step 00 + 24 steps
        self.assertIn("Real LLM", run_rec.backend_name)

    def test_fault_injection_verifier_failure_and_localization(self):
        """Test controlled fault injection (wrong-owner) with RealLLMAgent and fault localization."""
        provider = LLMProvider(mock_responses=self.mock_sequence)
        agent = RealLLMAgent(self.adapter, provider=provider)
        scenario = get_fault_scenario("wrong-owner")

        import asyncio
        run_rec = asyncio.run(agent.run_workload("test-real-fault", scenario))

        # Verifier must detect wrong-owner fault
        self.assertEqual(run_rec.verifier_status, "FAILED")
        self.assertTrue(len(run_rec.verification.failed_invariants) > 0)
        failed_names = [inv.name for inv in run_rec.verification.failed_invariants]
        self.assertIn("lead_1_owner_matches_expected", failed_names)

        # Checkpoints & localization
        chk_mgr = CheckpointManager("test-real-fault")
        chk_mgr.checkpoints = run_rec.checkpoints
        for chk in run_rec.checkpoints:
            chk_mgr._by_id[chk.checkpoint_id] = chk

        localizer = FaultLocalizer(self.adapter)
        loc_res = asyncio.run(localizer.binary_search(chk_mgr, "sbx-test-diag"))
        self.assertEqual(loc_res.first_invalid_step, 17)

        # State diff between Step 16 and Step 17
        chk_good = chk_mgr.get_by_step(16)
        chk_bad = chk_mgr.get_by_step(17)
        self.assertIsNotNone(chk_good)
        self.assertIsNotNone(chk_bad)

        store_good = asyncio.run(self.adapter.revert_to_snapshot("sbx-diff", chk_good.snapshot_id))
        store_bad = asyncio.run(self.adapter.revert_to_snapshot("sbx-diff", chk_bad.snapshot_id))
        diff = StateDiffEngine.compare_stores(
            chk_good.checkpoint_id, chk_bad.checkpoint_id, store_good, store_bad
        )
        self.assertTrue(len(diff.changed_records) > 0)
        self.assertEqual(diff.changed_records[0].record_id, 1)

        # Counterfactual Repair & Replay
        repair_engine = CounterfactualRepairEngine(self.adapter)
        repair_act, rep_verifier, _ = asyncio.run(
            repair_engine.execute_repair(chk_mgr, chk_good, chk_bad, "wrong-owner")
        )
        self.assertTrue(rep_verifier.passed)
        self.assertIn("Alice", repair_act.description)

    def test_api_endpoints_real_agent(self):
        """Test API endpoints /api/run with agent_type='real' and /api/agent/run."""
        client = TestClient(app)

        # Without credentials -> 400 Bad Request
        with patch.dict(os.environ, {}, clear=True):
            res = client.post("/api/run", json={"scenario": "wrong-owner", "agent_type": "real"})
            self.assertEqual(res.status_code, 400)
            self.assertIn("LLM API Key missing", res.json()["detail"])

            res2 = client.post("/api/agent/run", json={"scenario": "wrong-owner"})
            self.assertEqual(res2.status_code, 400)
            self.assertIn("LLM API Key missing", res2.json()["detail"])

    @patch("httpx.Client.post")
    def test_gemini_api_request_payload_format(self, mock_post):
        """Test that _call_gemini_api constructs valid systemInstruction, contents, toolConfig, and parses response."""
        mock_response = unittest.mock.MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "functionCall": {
                                    "name": "assign_owner",
                                    "args": {"lead_id": 1, "owner": "Alice"},
                                }
                            }
                        ]
                    }
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 120,
                "candidatesTokenCount": 35,
                "totalTokenCount": 155,
            },
        }
        mock_post.return_value = mock_response

        provider = LLMProvider(api_key="test-key", model_name="gemini-3.5-flash-lite")
        tools_schema = [
            {
                "name": "assign_owner",
                "description": "Assign owner to lead",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "lead_id": {"type": "INTEGER"},
                        "owner": {"type": "STRING"},
                    },
                },
            }
        ]

        result = provider.generate_tool_call(
            system_prompt="Test system prompt",
            tools_schema=tools_schema,
            conversation_history=[{"role": "user", "content": "Step 1: assign owner"}],
            step_idx=1,
        )

        # 1. Verify HTTP call was made
        mock_post.assert_called_once()
        _, kwargs = mock_post.call_args
        payload = kwargs.get("json", {})

        # 2. Verify top-level systemInstruction
        self.assertIn("systemInstruction", payload)
        self.assertEqual(
            payload["systemInstruction"],
            {"parts": [{"text": "Test system prompt"}]},
        )

        # 3. Verify contents has no synthetic system prompt turns
        contents = payload.get("contents", [])
        self.assertEqual(len(contents), 1)
        self.assertEqual(contents[0]["role"], "user")
        self.assertEqual(contents[0]["parts"][0]["text"], "Step 1: assign owner")

        # 4. Verify toolConfig mode is ANY and allowedFunctionNames populated
        fc_config = payload.get("toolConfig", {}).get("functionCallingConfig", {})
        self.assertEqual(fc_config.get("mode"), "ANY")
        self.assertEqual(fc_config.get("allowedFunctionNames"), ["assign_owner"])

        # 5. Verify tools functionDeclarations present
        tools = payload.get("tools", [])
        self.assertEqual(len(tools), 1)
        self.assertIn("functionDeclarations", tools[0])

        # 6. Verify parsed tool call result & token counts
        self.assertEqual(result["action"], "assign_owner")
        self.assertEqual(result["args"], {"lead_id": 1, "owner": "Alice"})
        self.assertEqual(result["prompt_tokens"], 120)
        self.assertEqual(result["completion_tokens"], 35)
        self.assertEqual(result["total_tokens"], 155)
        self.assertEqual(result["token_status"], "MEASURED")

    @patch.object(LLMProvider, "generate_plan")
    def test_real_agent_generates_workload_prompt_and_system_instructions(self, mock_gen_plan):
        """Test that RealLLMAgent calls generate_plan with system instructions and workload spec."""
        mock_gen_plan.return_value = {
            "plan": [
                {"action": "create_lead", "args": {"name": "Acme Corp Lead", "email": "contact@acme.com", "company": "  acme corp  ", "owner": "Unassigned", "status": "new"}}
            ],
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "total_tokens": 120,
            "token_status": "MEASURED",
            "latency_ms": 50.0,
            "model": "gemini-3.5-flash-lite",
            "llm_calls_count": 1,
        }

        provider = LLMProvider(api_key="test-key")
        agent = RealLLMAgent(self.adapter, provider=provider)

        # Mock adapter to run only 1 step
        import asyncio
        with patch("faultline.llm_agent.get_default_workflow_steps", return_value=[
            {"action": "create_lead", "args": {"name": "Acme Corp Lead", "email": "contact@acme.com", "company": "  acme corp  ", "owner": "Unassigned", "status": "new"}}
        ]):
            run_rec = asyncio.run(agent.run_workload("test-prompt-check"))

        mock_gen_plan.assert_called_once()
        _, kwargs = mock_gen_plan.call_args
        system_prompt = kwargs.get("system_prompt", "")
        workload_spec = kwargs.get("workload_spec", [])

        # 1. System prompt asserts operating CRM agent & execute tool calls
        self.assertIn("automated AI GTM Sales Operations Agent", system_prompt)
        self.assertIn("Return a JSON array of tool call objects", system_prompt)

        # 2. Workload spec contains action and arguments
        self.assertEqual(len(workload_spec), 1)
        self.assertEqual(workload_spec[0]["action"], "create_lead")

        # 3. LLM calls count recorded
        self.assertEqual(len(run_rec.checkpoints), 2)  # step 00 + 1 step
        self.assertIn("1 LLM call", run_rec.backend_name)

    def test_plan_validation_and_safety(self):
        """Test that RealLLMAgent.validate_plan rejects unauthorized tool actions and malformed structures."""
        provider = LLMProvider(mock_responses=self.mock_sequence)
        agent = RealLLMAgent(self.adapter, provider=provider)
        default_steps = [{"action": "create_lead", "args": {"name": "Test", "email": "t@t.com", "company": "Co", "owner": "U", "status": "new"}}]

        # 1. Unauthorized tool name
        with self.assertRaises(ValueError) as ctx1:
            agent.validate_plan([{"action": "unauthorized_delete_db", "args": {}}], CRM_TOOLS_SCHEMA, default_steps)
        self.assertIn("Unauthorized or invalid CRM tool action", str(ctx1.exception))

        # 2. Non-list plan
        with self.assertRaises(ValueError) as ctx2:
            agent.validate_plan("not a list", CRM_TOOLS_SCHEMA, default_steps)
        self.assertIn("expected list", str(ctx2.exception))

        # 3. Valid plan passes
        valid_plan = agent.validate_plan([{"action": "create_lead", "args": {"name": "A", "email": "a@a.com", "company": "C", "owner": "O", "status": "new"}}], CRM_TOOLS_SCHEMA, default_steps)
        self.assertEqual(len(valid_plan), 1)
        self.assertEqual(valid_plan[0]["action"], "create_lead")

    @patch("httpx.Client.post")
    def test_gemini_api_plan_request_payload_format(self, mock_post):
        """Test that _call_gemini_api_plan constructs valid JSON generationConfig and parses plan array response."""
        mock_response = unittest.mock.MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps([
                                    {"action": "assign_owner", "args": {"lead_id": 1, "owner": "Alice"}}
                                ])
                            }
                        ]
                    }
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 120,
                "candidatesTokenCount": 35,
                "totalTokenCount": 155,
            },
        }
        mock_post.return_value = mock_response

        provider = LLMProvider(api_key="test-key", model_name="gemini-3.5-flash-lite")
        tools_schema = [
            {
                "name": "assign_owner",
                "description": "Assign owner to lead",
                "parameters": {"type": "OBJECT", "properties": {"lead_id": {"type": "INTEGER"}, "owner": {"type": "STRING"}}},
            }
        ]

        result = provider.generate_plan(
            system_prompt="Test plan prompt",
            tools_schema=tools_schema,
            workload_spec=[{"step": 1, "action": "assign_owner", "args": {"lead_id": 1, "owner": "Alice"}}],
        )

        mock_post.assert_called_once()
        _, kwargs = mock_post.call_args
        payload = kwargs.get("json", {})

        # Verify responseMimeType: application/json
        gen_config = payload.get("generationConfig", {})
        self.assertEqual(gen_config.get("responseMimeType"), "application/json")

        # Verify parsed plan array and metrics
        self.assertEqual(result["llm_calls_count"], 1)
        self.assertEqual(len(result["plan"]), 1)
        self.assertEqual(result["plan"][0]["action"], "assign_owner")

    @patch("faultline.solari_adapter.HAS_SOLARI_SDK", True)
    @patch("faultline.solari_adapter.SandboxClient")
    def test_live_solari_adapter_create_snapshot_timeout(self, mock_client_cls):
        """Test that LiveSolariAdapter.create_snapshot raises RuntimeError when sbx.snapshot times out."""
        mock_client = mock_client_cls.return_value
        mock_sbx = unittest.mock.AsyncMock()
        mock_sbx.sandboxId = "sbx-test-123"
        mock_sbx.connect = unittest.mock.AsyncMock()
        mock_sbx.files.write = unittest.mock.AsyncMock()
        mock_client.create = unittest.mock.AsyncMock(return_value=mock_sbx)

        from faultline.solari_adapter import LiveSolariAdapter
        adapter = LiveSolariAdapter(api_key="test-key")

        import asyncio

        async def run_test():
            sbx_id, store = await adapter.create_sandbox()
            # Force wait_for side effect to simulate TimeoutError
            with patch("asyncio.wait_for", side_effect=asyncio.TimeoutError):
                with self.assertRaises(RuntimeError) as ctx:
                    await adapter.create_snapshot(sbx_id, store, "test-snap")
                self.assertIn("Solari checkpoint timed out", str(ctx.exception))

        asyncio.run(run_test())

    def test_checkpoint_timeout_propagates_and_cleans_up(self):
        """Test that Solari checkpoint timeout propagates to HTTP 400 response and cleans up resources."""
        mock_adapter = unittest.mock.AsyncMock()
        mock_adapter.backend_name = "Solari"
        mock_adapter.create_sandbox.return_value = ("sbx-123", unittest.mock.MagicMock())
        mock_adapter.create_snapshot.side_effect = RuntimeError("Solari checkpoint timed out. Agent execution could not continue.")

        provider = LLMProvider(mock_responses=self.mock_sequence)
        agent = RealLLMAgent(mock_adapter, provider=provider)

        import asyncio
        with self.assertRaises(RuntimeError) as ctx:
            asyncio.run(agent.run_workload("test-timeout-cleanup"))

        self.assertIn("Solari checkpoint timed out", str(ctx.exception))
        mock_adapter.cleanup_all.assert_called_once()

    @patch("faultline.solari_adapter.HAS_SOLARI_SDK", True)
    def test_live_solari_adapter_initializes_bounded_http_timeout(self):
        """Test that LiveSolariAdapter initializes SandboxClient with bounded HTTP timeouts."""
        from faultline.solari_adapter import LiveSolariAdapter
        adapter = LiveSolariAdapter(api_key="test-key")

        self.assertIsNotNone(adapter.client)
        self.assertEqual(adapter.client._t._timeout, 30.0)
        self.assertIsNotNone(adapter.client._t._http)
        self.assertEqual(adapter.client._t._http.timeout.read, 30.0)

    @patch("faultline.server.RealLLMAgent")
    def test_ui_and_real_agent_model_selection_respects_env_var(self, mock_real_agent_cls):
        """Test that UI / FastAPI real-agent requests respect LLM_MODEL environment variable."""
        mock_run_rec = unittest.mock.MagicMock()
        mock_run_rec.to_dict.return_value = {"status": "ok"}
        mock_run_rec.checkpoints = []
        mock_run_rec.verification.passed = True

        mock_agent_instance = unittest.mock.AsyncMock()
        mock_agent_instance.run_workload.return_value = mock_run_rec
        mock_real_agent_cls.return_value = mock_agent_instance

        client = TestClient(app)

        # 1. When LLM_MODEL env var is set and request model is None -> uses LLM_MODEL
        with patch.dict(os.environ, {"LLM_API_KEY": "test-key", "LLM_MODEL": "gemini-3.5-flash-lite"}):
            res = client.post("/api/agent/run", json={"scenario": "wrong-owner"})
            self.assertEqual(res.status_code, 200)
            mock_real_agent_cls.assert_called_once()
            _, kwargs = mock_real_agent_cls.call_args
            provider = kwargs.get("provider")
            self.assertIsNotNone(provider)
            self.assertEqual(provider.model_name, "gemini-3.5-flash-lite")

        mock_real_agent_cls.reset_mock()

        # 2. When explicit model parameter is passed in request -> uses explicit model
        with patch.dict(os.environ, {"LLM_API_KEY": "test-key", "LLM_MODEL": "gemini-3.5-flash-lite"}):
            res = client.post("/api/agent/run", json={"scenario": "wrong-owner", "model": "gemini-1.5-pro"})
            self.assertEqual(res.status_code, 200)
            mock_real_agent_cls.assert_called_once()
            _, kwargs = mock_real_agent_cls.call_args
            provider = kwargs.get("provider")
            self.assertIsNotNone(provider)
            self.assertEqual(provider.model_name, "gemini-1.5-pro")

        mock_real_agent_cls.reset_mock()

        # 3. When neither is passed -> falls back to gemini-2.5-flash
        with patch.dict(os.environ, {"LLM_API_KEY": "test-key"}, clear=True):
            res = client.post("/api/agent/run", json={"scenario": "wrong-owner"})
            self.assertEqual(res.status_code, 200)
            mock_real_agent_cls.assert_called_once()
            _, kwargs = mock_real_agent_cls.call_args
            provider = kwargs.get("provider")
            self.assertIsNotNone(provider)
            self.assertEqual(provider.model_name, "gemini-2.5-flash")


if __name__ == "__main__":
    unittest.main()

