import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4

from fastapi import HTTPException

import idea_agent as agent


# Synthetic transcript for testing only.
TRANSCRIPT = {"segments": [
    {"text": "We will study proactive prompts using pauses.", "start": 2, "end": 4, "speaker": "SPEAKER_00"},
    {"text": "Compare with prompts triggered by a button.", "start": 4, "end": 7, "speaker": "SPEAKER_01"},
    {"text": "Drop the heart rate route.", "start": 7, "end": 9, "speaker": "SPEAKER_00"},
]}
TASK = {"question": "Which dataset has pause annotations?", "reason": "To choose evaluation data",
        "routes": ["pause"], "evidence_ids": [0], "source_type": "web", "query": "public pause dataset"}


class ResearchWorkflowTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        agent.save_json(self.folder / "audio.json", TRANSCRIPT)
        self.chunks = agent.load_transcript(self.folder / "audio.json")

    def test_empty_plan_never_searches(self):
        with patch.object(agent, "complete", return_value={"stage": "", "tasks": []}) as llm:
            plan = agent.plan_research(self.chunks)
            with patch.object(agent, "execute_task") as execute:
                self.assertFalse(agent.generate_result(self.folder, self.chunks, plan))
                execute.assert_not_called()
            llm.assert_called_once()
        self.assertTrue(all(not chunk["events"] for chunk in self.chunks))

    def test_audio_timeout_has_clear_error(self):
        with patch.object(agent.subprocess, "run", side_effect=subprocess.TimeoutExpired("whisperx", 3600)), \
                self.assertRaisesRegex(RuntimeError, "音频处理超时"):
            agent.run_command(["whisperx"], 3600)

    def test_transcribe_uses_bundled_ffmpeg_without_a_path_entry(self):
        binary = self.folder / "ffmpeg.exe"
        binary.touch()
        with patch.object(agent, "BUNDLED_FFMPEG", binary), patch.dict(os.environ, {"PATH": ""}), \
                patch.object(agent, "run_command") as run:
            self.assertEqual(agent.transcribe(self.folder, self.folder / "upload.m4a"), self.chunks)
        convert, transcribe = run.call_args_list
        self.assertEqual(convert.args[0][0], str(binary))
        self.assertEqual(transcribe.args[0][3], str(binary.parent))
        self.assertEqual(transcribe.kwargs["env"]["PATH"].split(os.pathsep)[0], str(binary.parent))

    def test_shared_query_and_partial_result_with_citations(self):
        duplicate = {**TASK, "query": " PUBLIC   pause dataset ", "routes": ["button"], "evidence_ids": [1]}
        other = {**TASK, "query": "button click baseline", "routes": ["button"], "evidence_ids": [1]}
        plan_json = {"stage": "design", "tasks": [TASK, duplicate, other]}
        source = {"id": "source-1", "title": "Dataset", "url": "https://example.org/data", "summary": "Pause annotations"}
        review = {"idea_summary": "Compare proactive and manual prompts.",
                  "academic_context": "The available dataset supports pause-based evaluation.",
                  "feasibility": "Conditionally feasible if button labels are added.",
                  "decisive_gaps": ["Button labels are missing."],
                  "recommended_path": ["Audit annotation coverage."]}
        suggestion = {"task_id": 1, "finding": "Pause annotations exist.", "source_ids": ["source-1"],
                      "impact": "Supports the pause route.", "gap": "Button labels unknown.",
                      "next_step": "Review annotation coverage."}
        with patch.object(agent, "complete", side_effect=[plan_json, {"suggestions": [suggestion]},
                                                          {"review": review, "suggestions": [suggestion]}]) as llm, \
                patch.object(agent, "search_web", side_effect=[[source], RuntimeError("Test failure")]) as search:
            plan = agent.plan_research(self.chunks)
            self.assertTrue(agent.generate_result(self.folder, self.chunks, plan))
        self.assertEqual(len(llm.call_args_list[0].args[1]), 3)
        self.assertEqual(len(llm.call_args_list), 3)
        self.assertEqual([call.args[0] for call in search.call_args_list],
                         ["public pause dataset", "button click baseline"])
        tasks = json.loads((self.folder / "research.json").read_text(encoding="utf-8"))["tasks"]
        self.assertEqual(tasks[0]["routes"], ["pause", "button"])
        self.assertEqual(tasks[0]["evidence_ids"], [0, 1])
        self.assertEqual(tasks[1]["status"], "failed")
        report = (self.folder / "report.md").read_text(encoding="utf-8")
        self.assertIn("## 核心构思", report)
        self.assertIn("## 总体可行性", report)
        self.assertIn("## 精简证据", report)
        self.assertNotIn("为什么查 ·", report)
        self.assertIn("00:02 SPEAKER_00", report)
        self.assertIn("00:04 SPEAKER_01", report)
        self.assertIn(source["url"], report)
        card = self.chunks[0]["events"][1]["data"]["insight"]
        self.assertEqual(card["cited_documents"][0]["source_url"], source["url"])

    def test_bad_evidence_or_retrieval_type_rejected(self):
        for invalid in [{"evidence_ids": [99]}, {"source_type": "other"}]:
            with self.subTest(invalid=invalid), patch.object(agent, "complete", return_value={
                "stage": "design", "tasks": [{**TASK, **invalid}],
            }), self.assertRaises(RuntimeError):
                agent.plan_research(self.chunks)

    def test_default_search_covers_academic_tasks_and_merges_shared_queries(self):
        academic = {**TASK, "source_type": "academic", "evidence_ids": [1]}
        web = {**TASK, "query": "another dataset"}
        source = {"id": "paper", "url": "https://example.org/paper", "summary": "Evidence"}
        with patch.dict(agent.os.environ, {"SCHOLARQA_URL": ""}), \
                patch.object(agent, "complete", return_value={"stage": "design", "tasks": [academic, TASK, web]}), \
                patch.object(agent, "search_web", return_value=[source]) as search:
            plan = agent.plan_research(self.chunks)
            self.assertEqual(len(plan.tasks), 2)
            self.assertEqual(plan.tasks[0].evidence_ids, [1, 0])
            result = agent.execute_task(plan.tasks[0])
        search.assert_called_once_with(academic["query"])
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["sources"], [source])

    def test_scholarqa_contract(self):
        task = agent.ResearchTask.model_validate({**TASK, "source_type": "academic"})
        started = Mock()
        started.json.return_value = {"task_id": "123", "task_result": None}
        completed = Mock()
        completed.json.return_value = {"task_result": {"sections": [{
            "text": "Comparison", "citations": [
                {"paper": {"corpus_id": 13756489, "title": "Paper"}, "snippets": ["Passage"]},
            ],
        }]}}
        with patch.dict(agent.os.environ, {"SCHOLARQA_URL": "http://localhost:8000/query_corpusqa"}), \
                patch.object(agent.requests, "post", side_effect=[started, completed]) as post, \
                patch.object(agent, "sleep"):
            result = agent.execute_task(task)
        self.assertEqual(post.call_args.kwargs["json"]["task_id"], "123")
        self.assertFalse(post.call_args.kwargs["json"]["opt_in"])
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["answer"], "Comparison")
        self.assertEqual(result["sources"][0]["summary"], "Passage")


class SpeakerWorkflowTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        data_dir = patch.object(agent, "DATA_DIR", self.root)
        data_dir.start()
        self.addCleanup(data_dir.stop)
        self.first, self.second = uuid4(), uuid4()
        self.first_folder = self.recording(self.first, {"SPEAKER_00": [1, 0]})
        self.second_folder = self.recording(self.second, {"SPEAKER_00": [0, 1], "SPEAKER_01": [1, 0]})

    def recording(self, result_id, vectors):
        folder = self.root / str(result_id)
        folder.mkdir()
        agent.save_json(folder / "audio.json", {**TRANSCRIPT, "speaker_embeddings": vectors})
        (folder / "report.md").write_text("# A single report", encoding="utf-8")
        return folder

    def action(self, result_id, action, label="", contact_id=None, name=""):
        return agent.update_speakers(result_id, agent.SpeakerAction(
            action=action, label=label, contact_id=contact_id, name=name,
        ), x_idea_agent="1")

    def calibrate(self):
        agent.save_json(self.root / "speaker_calibration.json", {
            "model": agent.SPEAKER_MODEL, "validated": True, "min_similarity": 0.8, "min_margin": 0.15,
        })

    def test_cross_file_registration_refresh_and_revoke(self):
        self.assertEqual(agent.get_speakers(self.second)["suggested_ids"], [])
        registered = self.action(self.first, "register", "SPEAKER_00", name="Reference")
        contact = registered["contacts"][0]["id"]
        self.assertIsNone(registered["speakers"][0]["score"])
        pending = agent.get_speakers(self.second)
        self.assertEqual(pending["status"], "uncalibrated")
        self.assertEqual(pending["suggested_ids"], [])
        self.calibrate()
        report = self.second_folder / "report.md"
        before = report.read_bytes()
        matched = self.action(self.second, "refresh")
        self.assertFalse(matched["speakers"][0]["matched"])
        self.assertTrue(matched["speakers"][1]["matched"])
        self.assertEqual(matched["suggested_ids"], [contact])
        self.assertEqual(report.read_bytes(), before)
        self.action(self.first, "register", "SPEAKER_00", contact_id=contact)
        self.assertEqual(len(agent.speaker_library()["samples"]), 1)
        self.action(self.first, "rename", contact_id=contact, name="Renamed")
        self.assertEqual(agent.get_speakers(self.second)["contacts"][0]["name"], "Renamed")
        self.action(self.first, "revoke", "SPEAKER_00")
        self.assertEqual(agent.get_speakers(self.second)["suggested_ids"], [])

    def test_speaker_http_route_precedes_file_route(self):
        paths = [route.path for route in agent.app.routes]
        self.assertLess(
            paths.index("/api/idea-agent/result/{result_id}/speakers"),
            paths.index("/api/idea-agent/result/{result_id}/{filename}"),
        )

    def test_report_viewers_follow_confirmed_speakers_per_recording(self):
        self.calibrate()
        registered = self.action(self.first, "register", "SPEAKER_00", name="Reference")
        contact = registered["contacts"][0]
        self.assertEqual(registered["viewers"], [contact])
        pending = agent.get_speakers(self.second)
        self.assertEqual(pending["suggested_ids"], [contact["id"]])
        self.assertEqual(pending["viewers"], [])
        self.assertIn("暂无确认人员", agent.result_file(self.second, "report.md").body.decode())

        for label in ("SPEAKER_00", "SPEAKER_01"):
            self.action(self.second, "register", label, contact_id=contact["id"])
        self.assertEqual(agent.get_speakers(self.second)["viewers"], [contact])
        report = agent.result_file(self.second, "report.md")
        self.assertIn("**报告可查看人员（本地名单）**：Reference\n", report.body.decode())
        self.assertEqual(report.headers["content-disposition"], 'attachment; filename="report.md"')
        self.assertEqual((self.second_folder / "report.md").read_text(encoding="utf-8"), "# A single report")

        self.action(self.second, "revoke", "SPEAKER_00")
        self.assertEqual(agent.get_speakers(self.second)["viewers"], [contact])
        self.action(self.second, "revoke", "SPEAKER_01")
        self.assertEqual(agent.get_speakers(self.second)["viewers"], [])
        self.assertEqual(agent.get_speakers(self.first)["viewers"], [contact])
        self.assertIn("暂无确认人员", agent.result_file(self.second, "report.md").body.decode())

    def test_ambiguous_invalid_and_legacy_embeddings(self):
        self.calibrate()
        self.action(self.first, "register", "SPEAKER_00", name="First")
        third = uuid4()
        self.recording(third, {"SPEAKER_00": [1, 0.02]})
        self.action(third, "register", "SPEAKER_00", name="Second")
        self.assertEqual(agent.get_speakers(self.second)["suggested_ids"], [])
        agent.save_json(self.second_folder / "audio.json", TRANSCRIPT)
        self.assertEqual(agent.get_speakers(self.second)["status"], "unavailable")
        agent.save_json(self.second_folder / "audio.json", {
            **TRANSCRIPT, "speaker_embeddings": {"SPEAKER_00": [0, 0]},
        })
        with self.assertRaises(HTTPException):
            self.action(self.second, "register", "SPEAKER_00", name="Invalid")

    def test_report_is_published_when_matching_fails(self):
        chunks = agent.load_transcript(self.first_folder / "audio.json")
        plan = agent.ResearchPlan(stage="", tasks=[])

        def fail_matching(folder):
            self.assertTrue((folder / "input.json").is_file())
            self.assertIn("没有识别到", (folder / "report.md").read_text(encoding="utf-8"))
            raise OSError("simulated matching failure")

        with patch.object(agent, "job", {}), patch.object(agent, "transcribe", return_value=chunks), \
                patch.object(agent, "plan_research", return_value=plan), \
                patch.object(agent, "refresh_speaker_matches", side_effect=fail_matching), \
                self.assertLogs("uvicorn.error", level="ERROR"):
            agent.process(self.first_folder, None)
        self.assertEqual(agent.read_json(self.root / "latest.json", {})["phase"], "done")


if __name__ == "__main__":
    unittest.main()
