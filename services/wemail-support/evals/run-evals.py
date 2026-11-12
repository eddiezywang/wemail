"""Executable corpus and support-runtime acceptance checks.

This runner intentionally covers deterministic guarantees: JSON validity,
metadata, retrieval, case deduplication/evidence continuation, and draft review
visibility. Real WeCom wording, image understanding, streaming, and duplicate
delivery remain channel acceptance cases and are listed separately in README.
"""

from __future__ import annotations

import argparse
import gc
import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SUPPORT = ROOT / "services" / "wemail-support"
KNOWLEDGE = SUPPORT / "knowledge-seed"
EVALS = SUPPORT / "evals"
RUNTIME_FILE = SUPPORT / "hermes-plugin" / "runtime.py"
REQUIRED_METADATA = {
    "id", "module", "title", "version", "audience", "confidentiality",
    "aliases", "summary",
}


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)


def frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise AssertionError(f"missing frontmatter: {path.name}")
    block = text.split("\n---\n", 1)[0][4:]
    values: dict[str, str] = {}
    for line in block.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            values[key.strip()] = value.strip()
    return values


def load_runtime():
    spec = importlib.util.spec_from_file_location("wemail_support_runtime_eval", RUNTIME_FILE)
    if not spec or not spec.loader:
        raise RuntimeError("cannot load support runtime")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def prepare_runtime(module, target: Path):
    published = target / "knowledge" / "published"
    published.mkdir(parents=True)
    for source in KNOWLEDGE.glob("*.md"):
        shutil.copy2(source, published / source.name)
    shutil.copy2(SUPPORT / "product-baseline.json", target / "product-baseline.json")
    module.os.environ["WEMAIL_SUPPORT_HOME"] = str(target)
    return module.SupportRuntime()


def check_corpus() -> list[str]:
    notes: list[str] = []
    ids: set[str] = set()
    for path in sorted(KNOWLEDGE.glob("*.md")):
        metadata = frontmatter(path)
        missing = REQUIRED_METADATA - metadata.keys()
        assert not missing, f"{path.name}: missing metadata {sorted(missing)}"
        document_id = metadata["id"]
        assert document_id not in ids, f"duplicate document id: {document_id}"
        ids.add(document_id)
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(">"):
                assert "按 WM-" not in line, f"user-facing quote leaks module: {path.name}"
                assert "待办编号" not in line, f"user-facing quote leaks todo id: {path.name}"
    baseline = load_json(SUPPORT / "product-baseline.json")
    assert baseline["current_release"], "product baseline has no current release"
    package = load_json(ROOT / "package.json")
    assert baseline["current_release"] == package["version"], "product baseline differs from package.json version"
    facts = load_json(SUPPORT / "facts" / "current-release.json")
    assert facts["release"] == baseline["current_release"], "fact release differs from product baseline"
    for fact in facts["facts"]:
        for assertion in fact["source_assertions"]:
            source = ROOT / assertion["path"]
            assert source.is_file(), f"{fact['id']}: source missing: {assertion['path']}"
            text = source.read_text(encoding="utf-8")
            assert assertion["contains"] in text, f"{fact['id']}: source assertion changed: {assertion}"
    for path in sorted(EVALS.glob("*.json")):
        load_json(path)
    notes.append(f"corpus: {len(ids)} documents; JSON, metadata, and {len(facts['facts'])} source facts valid")
    return notes


def check_retrieval(runtime) -> list[str]:
    checked = 0
    for path in sorted(EVALS.glob("golden-cases*.json")):
        for case in load_json(path):
            expected = case.get("expected_document")
            query = case.get("query")
            if not expected or not query or str(expected).startswith("none_"):
                continue
            results = runtime.search(query, None, 10)
            found = [item["document_id"] for item in results]
            assert expected in found, f"{case['id']}: expected {expected}, got {found}"
            checked += 1
    return [f"retrieval: {checked} golden queries include the expected document in top 10"]


def check_runtime(module, runtime) -> list[str]:
    module._RUNTIME = runtime
    preloaded = module.build_pre_llm_context(
        "maxBodyCharacters 的 maximum 是 20000，可以调大一点吗？", "wecom"
    )
    assert preloaded and "1000000" in preloaded["context"]
    assert "当前正式版" in preloaded["context"]
    module.build_pre_llm_context("你们现在的配色太丑了，有办法自定义配色吗？", "wecom")
    recovered = runtime.create_case(
        module.Actor("user-empty-args", "空参数用户", "wecom", "group-2", "group"), {}
    )
    assert recovered["module"] == "WM-17" and recovered["status"] == "feature_request"
    actor = module.Actor("user-1", "测试用户", "wecom", "group-1", "group")
    payload = {
        "primary_module": "WM-17", "category": "feature",
        "title": "希望自定义配色", "symptom": "现有三种主题不能满足使用需求",
        "issue_key": "theme-custom-colors", "priority": "low",
    }
    first = runtime.create_case(actor, payload)
    second = runtime.create_case(actor, payload)
    assert first["case_id"] == second["case_id"] and second["deduplicated"] is True
    runtime.append_case_evidence(actor, {
        "case_id": first["case_id"], "event_type": "user_followup",
        "summary": "用户补充希望调整阅读区背景", "evidence": "不含敏感数据",
    })
    group_reporter = module.Actor("user-handoff", "交接用户", "wecom", "group-handoff", "group")
    handoff_case = runtime.create_case(group_reporter, {
        "primary_module": "WM-03", "category": "investigation",
        "title": "后台正文补全未完成", "symptom": "等待一小时后仍需逐封点开",
        "issue_key": "body-hydration-after-one-hour", "priority": "medium",
        "handoff_required": True,
    })
    private_reporter = module.Actor("user-handoff", "交接用户", "wecom", "dm-handoff", "dm")
    resumed = runtime.resume_private_handoff(private_reporter, handoff_case["case_id"])
    assert resumed["case_id"] == handoff_case["case_id"]
    assert resumed["symptom"] == "等待一小时后仍需逐封点开"
    assert "chat_id" not in resumed and "reporter_id" not in resumed
    try:
        runtime.resume_private_handoff(
            module.Actor("another-user", "其他用户", "wecom", "dm-other", "dm"),
            handoff_case["case_id"],
        )
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("another WeCom user resumed a case they do not own")
    with runtime._connect() as db:
        cases = db.execute("SELECT COUNT(*) FROM support_cases").fetchone()[0]
        todos = db.execute("SELECT COUNT(*) FROM support_todos").fetchone()[0]
        events = db.execute("SELECT COUNT(*) FROM support_case_events").fetchone()[0]
    assert (cases, todos, events) == (3, 3, 1), (cases, todos, events)

    admin_path = runtime.config_path
    admin_path.write_text(json.dumps({"admins": [{
        "user_id": "admin-1", "display_name": "管理员", "role": "super_admin",
        "modules": ["*"], "notification_target": "",
    }]}), encoding="utf-8")
    admin = module.Actor("admin-1", "管理员", "wecom", "dm-admin", "dm")
    draft = runtime.create_draft(admin, {
        "document_id": "wm-eval-draft", "module_id": "WM-17",
        "title": "评测草稿", "content": "# 评测草稿\n\n这是供审核读取和比较的正文。",
        "change_reason": "验证审核者可以读取全文和差异",
    })
    detail = runtime.get_draft(admin, draft["draft_id"])
    assert "这是供审核读取" in detail["content"] and detail["diff"]
    reviewed = runtime.review_draft(admin, draft["draft_id"], "request_changes", "补充事实依据")
    assert reviewed["status"] == "changes_requested"
    return ["runtime: authoritative preloading, empty-argument recovery, case dedup, evidence continuation, identity-bound group/DM handoff, one todo per case, and readable draft review pass"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.parse_args()
    messages = check_corpus()
    module = load_runtime()
    with tempfile.TemporaryDirectory(prefix="wemail-support-eval-", ignore_cleanup_errors=True) as directory:
        runtime = prepare_runtime(module, Path(directory))
        messages.extend(check_retrieval(runtime))
        messages.extend(check_runtime(module, runtime))
        del runtime
        module.os.environ.pop("WEMAIL_SUPPORT_HOME", None)
        gc.collect()
    for message in messages:
        print(f"PASS {message}")
    print("NOTE Real WeCom image, native streaming, and one-reply delivery require channel acceptance.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
