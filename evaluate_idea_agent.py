"""Replay two saved WhisperX transcripts and plot observable pilot metrics."""

import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from time import perf_counter
from unittest.mock import patch
from urllib.parse import urlsplit

import matplotlib
import requests

matplotlib.use("Agg")
import matplotlib.pyplot as plt

import idea_agent as app


SAMPLES = {
    "AMI remote design": "c416cd53-97fe-46ad-89a4-d966e60c0a88",
    "Canada policy discussion": "4007b708-fb7e-4713-8765-bc145088b392",
}


def replay(root, name, sample_id):
    folder = root / sample_id
    folder.mkdir()
    chunks = app.load_transcript(app.DATA_DIR / sample_id / "audio.json")
    seconds = {"planning": 0, "retrieval": 0, "synthesis": 0, "rendering": 0}

    def timed(function, stage):
        active = False

        def run(*args, **kwargs):
            nonlocal active
            if active:
                return function(*args, **kwargs)
            active = True
            start = perf_counter()
            try:
                return function(*args, **kwargs)
            finally:
                seconds[stage] += perf_counter() - start
                active = False

        return run

    plan = timed(app.plan_research, "planning")(chunks)
    start = perf_counter()
    with patch.object(app, "execute_task", timed(app.execute_task, "retrieval")), patch.object(
        app, "synthesize_research", timed(app.synthesize_research, "synthesis")
    ):
        app.generate_result(folder, chunks, plan)
    seconds["rendering"] = max(0, perf_counter() - start - seconds["retrieval"] - seconds["synthesis"])
    result = json.loads((folder / "research.json").read_text(encoding="utf-8"))
    tasks = []
    for task in result["tasks"]:
        sources = {source["id"]: source["url"] for source in task["sources"]}
        cited = (task["suggestion"] or {}).get("source_ids", [])
        tasks.append({
            "id": task["task_id"], "question": task["question"], "status": task["status"],
            "retrieved_urls": sorted(set(sources.values())),
            "cited_urls": sorted({sources[source_id] for source_id in cited}),
        })
    return {"name": name, "sample_id": sample_id, "chunks": len(chunks), "seconds": seconds, "tasks": tasks}


def probe(url):
    try:
        with requests.get(url, timeout=(5, 8), stream=True) as response:
            status = response.status_code
            if status in (404, 410):
                outcome = "404 / 410"
            elif 200 <= status < 300:
                outcome = "2xx response"
            else:
                outcome = "Inconclusive"
            return {"url": url, "status": status, "outcome": outcome}
    except requests.RequestException as error:
        return {"url": url, "status": type(error).__name__, "outcome": "Inconclusive"}


def plot(root, runs, probes):
    tasks = [(run["name"].split()[0], task) for run in runs for task in run["tasks"]]
    fig, axes = plt.subplots(
        4, 1, figsize=(11, 10 + max(0, len(tasks) - 5) * 0.3), layout="constrained",
        gridspec_kw={"height_ratios": [1, 1, max(1.25, len(tasks) / 4), 1]},
    )
    ax = axes[0]
    statuses = [
        ("done", "Suggestion with citations", "#315b95"),
        ("synthesis_failed", "Sources found, suggestion missing", "#d38e36"),
        ("no_evidence", "No usable sources returned", "#9daec1"),
        ("failed", "Search failed", "#b65345"),
        ("not_run", "Search skipped", "#d7e0eb"),
    ]
    for row, run in enumerate(runs):
        counts = Counter(task["status"] for task in run["tasks"])
        left = 0
        for status, label, color in statuses:
            count = counts[status]
            ax.barh(row, count, left=left, color=color, label=label if row == 0 else None)
            if count:
                ax.text(left + count / 2, row, str(count), ha="center", va="center", color="white")
            left += count
        ax.annotate(f"{left} tasks", (left, row), xytext=(6, 0), textcoords="offset points", va="center")
    ax.set_yticks(range(len(runs)), [run["name"] for run in runs])
    ax.invert_yaxis()
    ax.set(xlim=(0, max(1, max(len(run["tasks"]) for run in runs)) * 1.24),
           xlabel="Planned tasks", title="Figure 1   Task outcomes by meeting")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.28), ncols=3, frameon=False, fontsize=9)

    ax = axes[1]
    for row, run in enumerate(runs):
        left = 0
        for (stage, seconds), color in zip(run["seconds"].items(), ("#315b95", "#0c8377", "#d38e36", "#a6a6a6")):
            ax.barh(row, seconds, left=left, label=stage.capitalize() if row == 0 else None, color=color)
            if seconds >= 1:
                ax.text(left + seconds / 2, row, f"{seconds:.1f}", ha="center", va="center", color="white")
            left += seconds
        ax.annotate(f"{left:.1f} s", (left, row), xytext=(5, 0), textcoords="offset points", va="center")
    ax.set_yticks(range(len(runs)), [run["name"] for run in runs])
    ax.invert_yaxis()
    ax.margins(x=0.13)
    ax.set(xlabel="Wall-clock seconds after transcript loading", title="Figure 2 / A   Replay time by stage")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.24), ncols=4, frameon=False)

    ax = axes[2]
    for row, (sample, task) in enumerate(tasks):
        total, used = len(task["retrieved_urls"]), len(task["cited_urls"])
        ax.barh(row, used, color="#315b95", label="Cited in task suggestion" if row == 0 else None)
        ax.barh(row, total - used, left=used, color="#d7e0eb",
                label="Returned by search, uncited in task suggestion" if row == 0 else None)
        ax.text(total + 0.08, row, f"{used}/{total}   {task['status']}", va="center", fontsize=9)
    ax.set_yticks(range(len(tasks)), [f"{sample} T{task['id']}" for sample, task in tasks])
    ax.invert_yaxis()
    max_urls = max([1] + [len(t["retrieved_urls"]) for _, t in tasks])
    ax.set(xlim=(0, max_urls + max(1.2, max_urls * 0.3)),
           xlabel="Distinct source URLs within task", title="B   Search results cited in per-task suggestions")
    if tasks:
        ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.22), ncols=2, frameon=False)

    ax = axes[3]
    counts = Counter(row["outcome"] for row in probes)
    labels = ["2xx response", "404 / 410", "Inconclusive"]
    bars = ax.bar(labels, [counts[label] for label in labels], color=["#0c8377", "#b65345", "#a6a6a6"])
    ax.bar_label(bars, padding=3)
    ax.set(ylim=(0, max([1, *counts.values()]) * 1.25), ylabel="Distinct URLs",
           title=f"C   HTTP checks for URLs cited in task suggestions (n={len(probes)})")
    for axis in axes:
        axis.spines[["top", "right"]].set_visible(False)
    fig.savefig(root / "evaluation.png", dpi=180)


def main():
    root = app.DATA_DIR / datetime.now().strftime("eval-%Y%m%d-%H%M%S")
    root.mkdir()
    print(root, flush=True)
    runs = []
    for name, sample_id in SAMPLES.items():
        run = replay(root, name, sample_id)
        runs.append(run)
        print(name, run["chunks"], len(run["tasks"]), run["seconds"], flush=True)
    urls = sorted({url for run in runs for task in run["tasks"] for url in task["cited_urls"]
                   if urlsplit(url).scheme in ("http", "https")})
    with ThreadPoolExecutor(max_workers=6) as pool:
        probes = list(pool.map(probe, urls))
    app.save_json(root / "metrics.json", {"runs": runs, "http_checks": probes})
    plot(root, runs, probes)


if __name__ == "__main__":
    main()
