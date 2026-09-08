import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("operator_audit", Path(__file__).with_name("operator-audit.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AuditQueryTests(unittest.TestCase):
    def span(self, session="scope", span_id="one", **attrs):
        return {"context":{"trace_id":"trace", "span_id":span_id}, "name":"mcp.exec_command",
                "status_code":"OK", "attributes":{"session.id":session, "zes.tool.outcome":"succeeded",
                "tool.name":"exec_command", "zes.observation.boundary":"nexus_mcp_only", **attrs}}

    def test_synthetic_exclusion_is_explicit(self):
        report=module.summarize([self.span(session="synthetic-test")],10)
        self.assertEqual(report["retrieved"],1)
        self.assertEqual(report["included_unique_spans"],0)

    def test_transport_success_is_not_process_success_or_task_acceptance(self):
        report=module.summarize([self.span(**{"zes.exitCode":7})],10)
        row=report["by_tool"]["exec_command"]
        self.assertEqual(row["mcp_errors"],0)
        self.assertEqual(row["nonzero_process_exits"],1)
        self.assertEqual(report["outcome_examples"][0]["task_outcome"],"not_assessed")

    def test_duplicates_and_invalid_identity_do_not_invent_extra_calls(self):
        report=module.summarize([self.span(),self.span(),{"attributes":{}}],10)
        self.assertEqual(report["included_unique_spans"],1)
        self.assertEqual(report["invalid_span_identities"],1)

    def test_sample_limit_is_not_full_population(self):
        report=module.summarize([self.span()],1)
        self.assertTrue(report["window_may_be_truncated"])

    def test_structural_codex_spans_are_not_tool_calls(self):
        structural={"context":{"trace_id":"native", "span_id":"parent"},
                    "name":"codex.native", "attributes":{"zes.observation.boundary":"codex_native_filtered"}}
        report=module.summarize([structural],10)
        self.assertEqual(report["included_unique_spans"],1)
        self.assertEqual(report["by_tool"],{})
        self.assertEqual(report["non_invocation_spans"],1)

    def test_codex_event_occurrences_do_not_claim_user_command_count(self):
        structural={"context":{"trace_id":"native", "span_id":"inner"},
                    "name":"codex.native", "attributes":{"zes.observation.boundary":"codex_native_filtered"},
                    "events":[{"attributes":{"event.name":"codex.tool_result", "tool_name":"exec_command", "success":True}},
                              {"attributes":{"event.name":"codex.tool_result", "tool_name":"exec", "success":True}}]}
        report=module.summarize([structural,structural],10)
        self.assertEqual(report["by_tool"],{})
        self.assertEqual(sum(v["event_occurrences"] for v in report["codex_tool_result_events"].values()),2)
        self.assertEqual(report["duplicate_span_records"],1)
        self.assertIn("not independent commands",report["codex_event_count_meaning"])

    def test_unknown_span_with_mcp_name_does_not_fabricate_invocation(self):
        report=module.summarize([{"context":{"trace_id":"trace", "span_id":"unattributed"},
                                 "name":"mcp.exec_command", "attributes":{}}],10)
        self.assertEqual(report["by_tool"],{})

    def test_conflicting_duplicate_is_visible_and_not_scored(self):
        report=module.summarize([self.span(**{"zes.exitCode":0}),self.span(**{"zes.exitCode":7})],10)
        self.assertEqual(report["conflicting_duplicate_spans"],1)
        self.assertEqual(report["by_tool"],{})

    def test_invalid_measurement_does_not_crash_or_become_a_zero_exit(self):
        span=self.span(**{"zes.exitCode":True,"zes.outputDeltaBytes":"unknown"})
        span.update(start_time="unknown",end_time="unknown")
        report=module.summarize([span],10)
        row=report["by_tool"]["exec_command"]
        self.assertEqual(row["nonzero_process_exits"],0)
        self.assertEqual(report["invalid_measurement_fields"],3)


if __name__ == "__main__": unittest.main()
