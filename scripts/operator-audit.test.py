import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("operator_audit", Path(__file__).with_name("operator-audit.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AuditQueryTests(unittest.TestCase):
    def span(self, session="scope", span_id="one", **attrs):
        return {"context":{"trace_id":"trace", "span_id":span_id}, "name":"mcp.exec_command",
                "status_code":"OK", "attributes":{"session.id":session, "zes.tool.outcome":"succeeded", **attrs}}

    def test_synthetic_exclusion_is_explicit(self):
        report=module.summarize([self.span(session="synthetic-test")],10)
        self.assertEqual(report["retrieved"],1)
        self.assertEqual(report["included_unique_spans"],0)

    def test_transport_success_is_not_process_success_or_task_acceptance(self):
        report=module.summarize([self.span(**{"zes.exitCode":7})],10)
        row=report["by_tool"]["mcp.exec_command"]
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


if __name__ == "__main__": unittest.main()
