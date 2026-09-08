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
        self.assertEqual(report["session_attribution"], {"observed":0,"missing":1})
        self.assertIn("does not establish", report["synthetic_exclusion_meaning"])

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

    def test_duplicate_measurement_types_are_order_independent(self):
        for other in (True, 1.0):
            integer = self.span(**{"zes.exitCode":1})
            changed = self.span(**{"zes.exitCode":other})
            for records in ([integer, changed], [changed, integer]):
                with self.subTest(other=repr(other), first=records[0]["attributes"]["zes.exitCode"]):
                    report = module.summarize(records, 10)
                    self.assertEqual(report["conflicting_duplicate_spans"], 1)
                    self.assertEqual(report["by_tool"], {})

    def test_duplicate_event_types_are_checked_recursively(self):
        left = self.span()
        right = self.span()
        left["events"] = [{"attributes":{"success":True}}]
        right["events"] = [{"attributes":{"success":1}}]
        report = module.summarize([left, right], 10)
        self.assertEqual(report["conflicting_duplicate_spans"], 1)

    def test_annotation_changes_are_not_measurement_conflicts(self):
        left, right = self.span(), self.span()
        right["annotations"] = [{"name":"review", "label":"inspected"}]
        report = module.summarize([left, right], 10)
        self.assertEqual(report["conflicting_duplicate_spans"], 0)
        self.assertEqual(report["by_tool"]["exec_command"]["calls"], 1)

    def test_unobserved_measurements_are_not_measured_zero(self):
        missing = module.summarize([self.span()], 10)["by_tool"]["exec_command"]
        zero = self.span(**{"zes.outputDeltaBytes":0,"zes.exitCode":0})
        zero.update(start_time="2026-09-08T00:00:00+00:00", end_time="2026-09-08T00:00:00+00:00")
        observed = module.summarize([zero], 10)["by_tool"]["exec_command"]
        self.assertIsNone(missing["returned_bytes"])
        self.assertIsNone(missing["duration_ms"])
        self.assertEqual(observed["returned_bytes"], 0)
        self.assertEqual(observed["duration_ms"], 0)
        for key in ("returned_bytes", "duration_ms", "process_exit"):
            self.assertEqual(missing["measurement_coverage"][key], {"observed":0,"missing":1,"invalid":0})
            self.assertEqual(observed["measurement_coverage"][key], {"observed":1,"missing":0,"invalid":0})

    def test_partial_totals_report_missing_and_invalid_contributions(self):
        observed = self.span(span_id="observed", **{"zes.outputDeltaBytes":12,"zes.exitCode":7})
        observed.update(start_time="2026-09-08T00:00:00+00:00", end_time="2026-09-08T00:00:00.100000+00:00")
        invalid = self.span(span_id="invalid", **{"zes.outputDeltaBytes":True,"zes.exitCode":True})
        invalid.update(start_time="bad", end_time="bad")
        missing = self.span(span_id="missing")
        report = module.summarize([missing, invalid, observed], 10)
        row = report["by_tool"]["exec_command"]
        self.assertEqual(row["returned_bytes"], 12)
        self.assertAlmostEqual(row["duration_ms"], 100)
        self.assertEqual(row["nonzero_process_exits"], 1)
        self.assertEqual(report["invalid_measurement_fields"], 3)
        for coverage in row["measurement_coverage"].values():
            self.assertEqual(coverage, {"observed":1,"missing":1,"invalid":1})

    def test_partial_timestamp_is_missing_not_zero_duration(self):
        partial = self.span()
        partial["start_time"] = "2026-09-08T00:00:00+00:00"
        row = module.summarize([partial], 10)["by_tool"]["exec_command"]
        self.assertIsNone(row["duration_ms"])
        self.assertEqual(row["measurement_coverage"]["duration_ms"]["missing"], 1)


if __name__ == "__main__": unittest.main()
