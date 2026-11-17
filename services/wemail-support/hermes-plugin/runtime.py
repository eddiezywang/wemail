"""Durable, role-safe runtime for WeMail support.

The model never supplies identity or role. Those values come from Hermes'
request-scoped gateway context. All mutations are transactionally audited.
"""

from __future__ import annotations

import hashlib
import difflib
import json
import os
import re
import sqlite3
import threading
import uuid
import zipfile
from collections import Counter
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


MODULES = (
    ("WM-01", "安装、升级与桌面运行"),
    ("WM-02", "账户、认证与邮箱连接"),
    ("WM-03", "邮件同步与邮箱管理"),
    ("WM-04", "写信、回复与发送"),
    ("WM-05", "通讯录与收件人"),
    ("WM-06", "摘要、简报与智能中心"),
    ("WM-07", "分类、智能标签与学习"),
    ("WM-08", "邮件待办与行动中心"),
    ("WM-09", "邮件搜索、问答与内容理解"),
    ("WM-10", "AI 写作、智能回复与个性化"),
    ("WM-11", "个人助理与学习工作空间"),
    ("WM-12", "自动化"),
    ("WM-13", "洞察报告与业务场景"),
    ("WM-14", "Skill Center 与 MCP"),
    ("WM-15", "外部连接与 Bot 渠道"),
    ("WM-16", "AI 模型与使用量"),
    ("WM-17", "设置、通知、数据隐私与诊断"),
)
MODULE_IDS = {item[0] for item in MODULES}
CASE_STATUSES = {
    "new", "triaging", "waiting_for_user", "confirmed_bug",
    "feature_request", "resolved", "closed",
}
TODO_STATUSES = {"pending", "in_progress", "blocked", "completed", "cancelled"}
DRAFT_STATUSES = {"draft", "in_review", "changes_requested", "approved", "rejected", "published"}
PRIORITIES = {"low", "medium", "high", "urgent"}
PUBLIC_AUDIENCES = {"user", "all"}


def _is_public_knowledge(metadata: dict[str, Any]) -> bool:
    return metadata.get("audience") in PUBLIC_AUDIENCES and metadata.get("confidentiality") == "public"


SAFE_DOC_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{2,100}$")
TOKEN_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9_.:-]{1,}|[\u4e00-\u9fff]{2,}")
SENSITIVE_RE = re.compile(
    r"(?i)(api[_ -]?key|password|密码|authorization|bearer|token|secret)\s*[:=]\s*\S+"
)
BEARER_RE = re.compile(r"(?i)\bbearer\s+[^\s,;]+")
DIAGNOSTIC_RELEVANT_RE = re.compile(
    r"(?i)(sync|正文|body|hydrat|backfill|reconcile|imap|mail|queue|retry|fetch|download|error|fail|timeout)"
)
WINDOWS_PATH_RE = re.compile(r"(?i)\b[A-Z]:\\(?:[^\s\"']+\\)*[^\s\"']+")
EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
MAX_DIAGNOSTIC_PACKAGE_BYTES = 25 * 1024 * 1024
MAX_DIAGNOSTIC_JSON_BYTES = 10 * 1024 * 1024
MAX_DIAGNOSTIC_ZIP_ENTRIES = 8
MAX_DIAGNOSTIC_FINDINGS = 100
_TURN_SUPPORT_QUERY: ContextVar[str] = ContextVar("wemail_support_turn_query", default="")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _issue_fingerprint(data: dict[str, Any]) -> str:
    """Return a stable, non-sensitive key used to avoid duplicate open cases."""
    explicit = str(data.get("issue_key") or "").strip().lower()
    if explicit:
        normalized = re.sub(r"[^a-z0-9\u4e00-\u9fff._:-]+", "-", explicit).strip("-")[:160]
    else:
        material = " ".join(
            str(data.get(name) or "")
            for name in ("primary_module", "category", "title", "symptom")
        ).lower()
        normalized = " ".join(TOKEN_RE.findall(material))[:1000]
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _result(**payload: Any) -> str:
    return _json(payload)


def _error(code: str, message: str) -> str:
    return _result(ok=False, error=code, message=message)


def _redact_support_input(value: Any, depth: int = 0) -> Any:
    """Remove recognizable credentials from structured and free-text input."""
    if depth > 8:
        return "[DEPTH_LIMIT]"
    if isinstance(value, dict):
        return {
            str(key): "[REDACTED]" if re.search(
                r"(?i)(password|passwd|authorization|api.?key|token|secret|credential|密码|密钥)", str(key)
            ) else _redact_support_input(item, depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_support_input(item, depth + 1) for item in value]
    if isinstance(value, str):
        return SENSITIVE_RE.sub(r"\1=[REDACTED]", BEARER_RE.sub("Bearer [REDACTED]", value))
    return value


def _session_value(name: str) -> str:
    try:
        from gateway.session_context import get_session_env
        return (get_session_env(name, "") or "").strip()
    except Exception:
        return (os.getenv(name) or "").strip()


def _trusted_session_value(name: str) -> str:
    """Identity must come from the active gateway session, never process env."""
    try:
        from gateway.session_context import get_session_env
        return (get_session_env(name, "") or "").strip()
    except Exception:
        return ""


def _search_terms(query: str) -> set[str]:
    """Keep Latin words and add Chinese bi/tri-grams for symptom matching."""
    terms: set[str] = set()
    for token in TOKEN_RE.findall(query.lower()):
        terms.add(token)
        if re.fullmatch(r"[\u4e00-\u9fff]+", token):
            for width in (2, 3):
                terms.update(token[index:index + width] for index in range(len(token) - width + 1))
    return terms


def _latest_user_query() -> str:
    """Recover the active turn text when Hermes emits an empty search call.

    Some Responses API turns produce ``wemail_support_search({})`` despite the
    required JSON schema. The gateway has already persisted the user message by
    then, so use the session-scoped id to recover it instead of returning an
    error and letting the model answer from an unverified user assertion.
    """
    current = _TURN_SUPPORT_QUERY.get().strip()
    if current:
        return current[:4000]
    session_id = _session_value("HERMES_SESSION_ID")
    if not session_id:
        return ""
    hermes_home = Path(os.getenv("HERMES_HOME") or Path.home() / ".hermes")
    state_path = hermes_home / "state.db"
    if not state_path.exists():
        return ""
    try:
        with sqlite3.connect(f"file:{state_path.as_posix()}?mode=ro", uri=True, timeout=2) as db:
            row = db.execute(
                "SELECT content FROM messages WHERE session_id=? AND role='user' AND active=1 ORDER BY id DESC LIMIT 1",
                (session_id,),
            ).fetchone()
        return str(row[0] or "").strip()[:4000] if row else ""
    except sqlite3.Error:
        return ""


def _search_public_knowledge(runtime: "SupportRuntime", args: dict[str, Any]) -> dict[str, Any]:
    query = str(args.get("query") or "").strip() or _latest_user_query()
    if not query:
        raise ValueError("query is required and the active user message could not be recovered")
    return {
        "results": runtime.search(query, args.get("module_id"), int(args.get("limit", 5))),
        "query": query,
    }


def _read_public_knowledge(runtime: "SupportRuntime", args: dict[str, Any]) -> dict[str, Any]:
    document_id = str(args.get("document_id") or "").strip()
    if not document_id:
        query = _latest_user_query()
        matches = runtime.search(query, None, 1) if query else []
        document_id = str(matches[0]["document_id"]) if matches else ""
    if not document_id:
        raise ValueError("document_id is required and no current search match could be recovered")
    return {"document": runtime.read(document_id)}


def _scrub_diagnostic_value(value: Any, depth: int = 0) -> Any:
    """Apply a second support-side privacy pass to exported diagnostics."""
    if depth > 8:
        return "[DEPTH_LIMIT]"
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for raw_key, raw_value in list(value.items())[:80]:
            key = str(raw_key)[:100]
            normalized_key = re.sub(r"[^a-z0-9]", "", key.lower())
            contains_secret = re.search(
                r"(?i)(password|passwd|authorization|api.?key|token|secret|credential)",
                key,
            )
            contains_mail_content = normalized_key in {
                "body", "bodytext", "bodyhtml", "mailbody", "rawbody",
                "subject", "mailsubject", "sender", "recipient", "recipients",
                "fromaddress", "toaddress", "ccaddress", "bccaddress",
            }
            if contains_secret or contains_mail_content:
                cleaned[key] = "[REDACTED]"
            else:
                cleaned[key] = _scrub_diagnostic_value(raw_value, depth + 1)
        return cleaned
    if isinstance(value, list):
        return [_scrub_diagnostic_value(item, depth + 1) for item in value[:100]]
    if isinstance(value, str):
        text = str(_redact_support_input(value))
        text = WINDOWS_PATH_RE.sub("[LOCAL_PATH]", text)
        text = EMAIL_RE.sub("[EMAIL]", text)
        return text[:1500]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:300]


def _diagnostic_cache_roots() -> tuple[Path, ...]:
    hermes_home = Path(os.getenv("HERMES_HOME") or Path.home() / ".hermes").resolve()
    return (
        (hermes_home / "cache" / "documents").resolve(),
        (hermes_home / "document_cache").resolve(),
    )


def _read_diagnostic_payload(file_path: str) -> tuple[dict[str, Any], Path]:
    path = Path(file_path).expanduser().resolve()
    if not any(path == root or root in path.parents for root in _diagnostic_cache_roots()):
        raise PermissionError("diagnostic package must be an attachment received in this support chat")
    if not path.is_file():
        raise FileNotFoundError("diagnostic package attachment was not found")
    if path.stat().st_size > MAX_DIAGNOSTIC_PACKAGE_BYTES:
        raise ValueError("diagnostic package exceeds the 25 MB support limit")

    suffix = path.suffix.lower()
    if suffix == ".json":
        raw = path.read_bytes()
    elif suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            entries = [item for item in archive.infolist() if not item.is_dir()]
            if not entries or len(entries) > MAX_DIAGNOSTIC_ZIP_ENTRIES:
                raise ValueError("diagnostic ZIP has an unexpected number of files")
            candidates = [
                item for item in entries
                if Path(item.filename).name == item.filename
                and re.fullmatch(r"wemail-diagnostics-[A-Za-z0-9T_-]+\.json", item.filename)
            ]
            if len(candidates) != 1:
                raise ValueError("diagnostic ZIP must contain one WeMail diagnostic JSON file")
            entry = candidates[0]
            if entry.flag_bits & 0x1:
                raise ValueError("encrypted diagnostic ZIP is not supported")
            if entry.file_size > MAX_DIAGNOSTIC_JSON_BYTES:
                raise ValueError("diagnostic JSON exceeds the 10 MB analysis limit")
            if entry.compress_size and entry.file_size / entry.compress_size > 100:
                raise ValueError("diagnostic ZIP compression ratio is unsafe")
            raw = archive.read(entry)
    else:
        raise ValueError("only WeMail diagnostic JSON or ZIP attachments are supported")

    if len(raw) > MAX_DIAGNOSTIC_JSON_BYTES:
        raise ValueError("diagnostic JSON exceeds the 10 MB analysis limit")
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("diagnostic package is not valid WeMail JSON") from exc
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1 or not isinstance(payload.get("logs"), list):
        raise ValueError("diagnostic package schema is not recognized")
    return payload, path


def _analyze_diagnostics(args: dict[str, Any]) -> dict[str, Any]:
    payload, cached_path = _read_diagnostic_payload(str(args.get("file_path") or ""))
    try:
        logs = payload.get("logs") or []
        event_counts: Counter[str] = Counter()
        level_counts: Counter[str] = Counter()
        relevant: list[dict[str, Any]] = []
        for item in logs:
            if not isinstance(item, dict):
                continue
            event = str(item.get("event") or "unknown")[:160]
            level = str(item.get("level") or item.get("severity") or "unknown").lower()[:30]
            event_counts[event] += 1
            level_counts[level] += 1
            serialized = json.dumps(item, ensure_ascii=False, default=str)
            if DIAGNOSTIC_RELEVANT_RE.search(serialized):
                relevant.append(_scrub_diagnostic_value(item))
        return {
            "package": {
                "schema_version": payload.get("schemaVersion"),
                "created_at": payload.get("createdAt"),
                "uploaded_by_app": bool(payload.get("uploaded")),
                "total_log_entries": len(logs),
            },
            "level_counts": dict(level_counts.most_common(12)),
            "top_events": [{"event": name, "count": count} for name, count in event_counts.most_common(30)],
            "relevant_entries": relevant[-MAX_DIAGNOSTIC_FINDINGS:],
            "privacy": "The received cache copy was deleted after analysis; only this secondarily-redacted summary may be used in the support case.",
        }
    finally:
        try:
            cached_path.unlink(missing_ok=True)
        except OSError:
            pass


@dataclass(frozen=True)
class Actor:
    user_id: str
    user_name: str
    platform: str
    chat_id: str
    chat_type: str


def _actor() -> Actor:
    return Actor(
        user_id=_trusted_session_value("HERMES_SESSION_USER_ID"),
        user_name=_trusted_session_value("HERMES_SESSION_USER_NAME"),
        platform=_trusted_session_value("HERMES_SESSION_PLATFORM"),
        chat_id=_trusted_session_value("HERMES_SESSION_CHAT_ID"),
        chat_type=_trusted_session_value("HERMES_SESSION_CHAT_TYPE"),
    )


class SupportRuntime:
    def __init__(self) -> None:
        hermes_home = Path(os.getenv("HERMES_HOME") or Path.home() / ".hermes")
        self.root = Path(os.getenv("WEMAIL_SUPPORT_HOME") or hermes_home / "wemail-support")
        self.knowledge = self.root / "knowledge"
        self.published = self.knowledge / "published"
        self.drafts_dir = self.knowledge / "drafts"
        self.internal = self.knowledge / "internal"
        self.archive = self.knowledge / "archive"
        self.index_path = self.knowledge / "index.md"
        self.db_path = self.root / "support.db"
        self.config_path = self.root / "admins.json"
        self.baseline_path = self.root / "product-baseline.json"
        self._lock = threading.RLock()
        for directory in (self.published, self.drafts_dir, self.internal, self.archive):
            directory.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self.rebuild_index()

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def _init_db(self) -> None:
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS support_cases (
                  id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL,
                  reporter_name TEXT NOT NULL, chat_id TEXT NOT NULL,
                  primary_module TEXT NOT NULL, related_modules_json TEXT NOT NULL,
                  category TEXT NOT NULL, title TEXT NOT NULL, symptom TEXT NOT NULL,
                  environment_json TEXT NOT NULL, reproduction TEXT NOT NULL,
                  expected TEXT NOT NULL, actual TEXT NOT NULL, evidence TEXT NOT NULL,
                  priority TEXT NOT NULL, status TEXT NOT NULL,
                  assigned_to TEXT, resolution TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS support_case_events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  case_id TEXT NOT NULL, actor_id TEXT NOT NULL,
                  actor_name TEXT NOT NULL, event_type TEXT NOT NULL,
                  summary TEXT NOT NULL, evidence TEXT NOT NULL,
                  source_chat_id TEXT NOT NULL, source_chat_type TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  FOREIGN KEY(case_id) REFERENCES support_cases(id)
                );
                CREATE TABLE IF NOT EXISTS support_todos (
                  id TEXT PRIMARY KEY, case_id TEXT,
                  title TEXT NOT NULL, description TEXT NOT NULL,
                  module_id TEXT NOT NULL, assignee_id TEXT,
                  status TEXT NOT NULL, priority TEXT NOT NULL,
                  due_at TEXT, created_by TEXT NOT NULL,
                  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                  FOREIGN KEY(case_id) REFERENCES support_cases(id)
                );
                CREATE TABLE IF NOT EXISTS knowledge_drafts (
                  id TEXT PRIMARY KEY, document_id TEXT NOT NULL,
                  module_id TEXT NOT NULL, title TEXT NOT NULL,
                  audience TEXT NOT NULL, confidentiality TEXT NOT NULL,
                  aliases_json TEXT NOT NULL, versions_json TEXT NOT NULL,
                  content TEXT NOT NULL, change_reason TEXT NOT NULL,
                  status TEXT NOT NULL, created_by TEXT NOT NULL,
                  last_edited_by TEXT,
                  reviewed_by TEXT, review_note TEXT NOT NULL DEFAULT '',
                  published_version INTEGER, created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS knowledge_versions (
                  document_id TEXT NOT NULL, version INTEGER NOT NULL,
                  module_id TEXT NOT NULL, title TEXT NOT NULL,
                  metadata_json TEXT NOT NULL, content TEXT NOT NULL,
                  content_hash TEXT NOT NULL, published_by TEXT NOT NULL,
                  published_at TEXT NOT NULL,
                  PRIMARY KEY(document_id, version)
                );
                CREATE TABLE IF NOT EXISTS audit_log (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
                  action TEXT NOT NULL, entity_type TEXT NOT NULL,
                  entity_id TEXT NOT NULL, details_json TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS notification_log (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  event_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                  target TEXT NOT NULL, status TEXT NOT NULL,
                  response TEXT NOT NULL, created_at TEXT NOT NULL
                );
                """
            )
            draft_columns = {row[1] for row in db.execute("PRAGMA table_info(knowledge_drafts)")}
            if "last_edited_by" not in draft_columns:
                db.execute("ALTER TABLE knowledge_drafts ADD COLUMN last_edited_by TEXT")
            # Repair incomplete migration as well as databases upgraded for the
            # first time; do not overwrite a known, newer editor.
            db.execute("""UPDATE knowledge_drafts SET last_edited_by=COALESCE(
                (SELECT actor_id FROM audit_log WHERE entity_type='knowledge_draft'
                 AND entity_id=knowledge_drafts.id AND action='update' ORDER BY id DESC LIMIT 1), created_by)
                WHERE last_edited_by IS NULL OR last_edited_by=''""")
            columns = {row[1] for row in db.execute("PRAGMA table_info(support_cases)")}
            if "issue_fingerprint" not in columns:
                db.execute("ALTER TABLE support_cases ADD COLUMN issue_fingerprint TEXT NOT NULL DEFAULT ''")
            if "origin_chat_type" not in columns:
                db.execute("ALTER TABLE support_cases ADD COLUMN origin_chat_type TEXT NOT NULL DEFAULT ''")
            if "handoff_required" not in columns:
                db.execute("ALTER TABLE support_cases ADD COLUMN handoff_required INTEGER NOT NULL DEFAULT 0")
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_support_cases_reporter_fingerprint "
                "ON support_cases(reporter_id,issue_fingerprint,status)"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_support_case_events_case "
                "ON support_case_events(case_id,created_at)"
            )

    def _admin_config(self) -> dict[str, Any]:
        if not self.config_path.exists():
            return {"admins": []}
        try:
            data = json.loads(self.config_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {"admins": []}
        except (OSError, ValueError):
            return {"admins": []}

    def product_baseline(self) -> dict[str, Any]:
        if not self.baseline_path.exists():
            return {"product": "WeMail", "platform": "Windows desktop", "current_release": "unknown"}
        try:
            data = json.loads(self.baseline_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("baseline is not an object")
            return {
                "product": str(data.get("product") or "WeMail"),
                "platform": str(data.get("platform") or "Windows desktop"),
                "current_release": str(data.get("current_release") or "unknown"),
                "verified_commit": str(data.get("verified_commit") or ""),
                "verified_at": str(data.get("verified_at") or ""),
            }
        except (OSError, ValueError):
            return {"product": "WeMail", "platform": "Windows desktop", "current_release": "unknown"}

    def admin_scope(self, actor: Actor) -> tuple[str, set[str]] | None:
        if actor.platform != "wecom" or not actor.user_id:
            return None
        for item in self._admin_config().get("admins", []):
            if not isinstance(item, dict) or item.get("user_id") != actor.user_id:
                continue
            role = item.get("role")
            modules = item.get("modules")
            if not isinstance(role, str) or role not in {"super_admin", "module_admin"} or not isinstance(modules, list):
                return None
            scope = MODULE_IDS if role == "super_admin" else {
                value for value in modules if isinstance(value, str) and value in MODULE_IDS
            }
            if role == "module_admin" and not scope:
                return None
            return role, set(scope)
        return None

    def require_admin(self, actor: Actor, module_id: str | None = None) -> tuple[str, set[str]]:
        scope = self.admin_scope(actor)
        if scope is None:
            raise PermissionError("administrator role required")
        if module_id and module_id not in scope[1]:
            raise PermissionError(f"administrator is not authorized for {module_id}")
        return scope

    def _notification_targets(self, module_id: str) -> list[str]:
        targets: list[str] = []
        for item in self._admin_config().get("admins", []):
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "module_admin")
            modules = item.get("modules") or []
            if role != "super_admin" and modules != ["*"] and module_id not in modules:
                continue
            target = str(item.get("notification_target") or "").strip()
            if target and target not in targets:
                targets.append(target)
        return targets

    def _notify(self, event_type: str, entity_id: str, module_id: str, message: str) -> dict[str, Any]:
        results: list[dict[str, Any]] = []
        for target in self._notification_targets(module_id):
            status = "failed"
            response = ""
            try:
                # Hermes' generic target parser currently treats opaque WeCom
                # user ids as channel names and then reparses the resolved id,
                # losing it.  Route an explicit WeCom target directly through
                # the same adapter helper; other platforms keep the public tool.
                platform_name, separator, native_target = target.partition(":")
                if platform_name.lower() == "wecom" and separator and native_target:
                    from gateway.config import Platform, load_gateway_config
                    from model_tools import _run_async
                    from tools.send_message_tool import _send_via_adapter
                    platform = Platform.WECOM
                    pconfig = load_gateway_config().platforms.get(platform)
                    if not pconfig or not pconfig.enabled:
                        raise RuntimeError("WeCom is not configured")
                    parsed = _run_async(_send_via_adapter(platform, pconfig, native_target, message))
                    response = _json(parsed)
                else:
                    from tools.send_message_tool import send_message_tool
                    response = str(send_message_tool({"action": "send", "target": target, "message": message}))
                    parsed = json.loads(response)
                status = "sent" if parsed.get("success") else "failed"
            except Exception as exc:
                response = str(exc)
            with self._connect() as db:
                db.execute(
                    "INSERT INTO notification_log(event_type,entity_id,target,status,response,created_at) VALUES(?,?,?,?,?,?)",
                    (event_type, entity_id, target, status, response[:2000], _now()),
                )
            results.append({"target": target, "status": status})
        return {"attempted": len(results), "deliveries": results}

    def list_admins(self, actor: Actor) -> list[dict[str, Any]]:
        role, _ = self.require_admin(actor)
        if role != "super_admin":
            raise PermissionError("administrator management requires super administrator")
        return [
            {
                "user_id": str(item.get("user_id") or ""),
                "display_name": str(item.get("display_name") or ""),
                "role": str(item.get("role") or "module_admin"),
                "modules": item.get("modules") or [],
                "notification_target": str(item.get("notification_target") or ""),
            }
            for item in self._admin_config().get("admins", []) if isinstance(item, dict)
        ]

    def upsert_admin(self, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
        role, _ = self.require_admin(actor)
        if role != "super_admin":
            raise PermissionError("administrator management requires super administrator")
        user_id = str(data.get("user_id") or "").strip()
        admin_role = str(data.get("role") or "module_admin")
        modules = [str(value) for value in data.get("modules") or []]
        if not user_id:
            raise ValueError("user_id is required")
        if admin_role not in {"super_admin", "module_admin"}:
            raise ValueError("role must be super_admin or module_admin")
        if admin_role == "super_admin":
            modules = ["*"]
        else:
            invalid = [value for value in modules if value not in MODULE_IDS]
            if invalid or not modules:
                raise ValueError("module_admin requires at least one valid module")
            modules = sorted(set(modules))
        config = self._admin_config()
        admins = [item for item in config.get("admins", []) if isinstance(item, dict) and item.get("user_id") != user_id]
        entry = {
            "user_id": user_id,
            "display_name": str(data.get("display_name") or "")[:120],
            "role": admin_role,
            "modules": modules,
            "notification_target": str(data.get("notification_target") or "").strip(),
        }
        admins.append(entry)
        config["admins"] = admins
        self.config_path.write_text(_json(config), encoding="utf-8")
        with self._connect() as db:
            self._audit(db, actor, "upsert", "support_admin", user_id, {"role": admin_role, "modules": modules})
        return entry

    def remove_admin(self, actor: Actor, user_id: str) -> dict[str, Any]:
        role, _ = self.require_admin(actor)
        if role != "super_admin":
            raise PermissionError("administrator management requires super administrator")
        config = self._admin_config()
        admins = [item for item in config.get("admins", []) if isinstance(item, dict)]
        found = next((item for item in admins if item.get("user_id") == user_id), None)
        if not found:
            raise FileNotFoundError("administrator not found")
        remaining = [item for item in admins if item.get("user_id") != user_id]
        if found.get("role") == "super_admin" and not any(item.get("role") == "super_admin" for item in remaining):
            raise ValueError("cannot remove the last super administrator")
        config["admins"] = remaining
        self.config_path.write_text(_json(config), encoding="utf-8")
        with self._connect() as db:
            self._audit(db, actor, "remove", "support_admin", user_id, {})
        return {"user_id": user_id, "removed": True}

    def _audit(self, db: sqlite3.Connection, actor: Actor, action: str,
               entity_type: str, entity_id: str, details: dict[str, Any]) -> None:
        db.execute(
            "INSERT INTO audit_log(actor_id,actor_name,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)",
            (actor.user_id, actor.user_name, action, entity_type, entity_id, _json(details), _now()),
        )

    @staticmethod
    def _validate_module(module_id: str) -> str:
        if module_id not in MODULE_IDS:
            raise ValueError("unknown module id")
        return module_id

    @staticmethod
    def _doc_metadata(path: Path) -> tuple[dict[str, Any], str]:
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            return {}, text
        marker = text.find("\n---\n", 4)
        if marker < 0:
            return {}, text
        raw = text[4:marker]
        metadata: dict[str, Any] = {}
        for line in raw.splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            value = value.strip()
            if value.startswith("["):
                try:
                    metadata[key.strip()] = json.loads(value)
                    continue
                except ValueError:
                    pass
            metadata[key.strip()] = value.strip('"')
        return metadata, text[marker + 5 :].strip()

    def rebuild_index(self) -> dict[str, Any]:
        rows: list[dict[str, Any]] = []
        for path in sorted(self.published.glob("*.md")):
            metadata, content = self._doc_metadata(path)
            if not _is_public_knowledge(metadata):
                continue
            summary = str(metadata.get("summary") or "") or next(
                (line.strip("# ") for line in content.splitlines() if line.strip()), ""
            )
            rows.append({
                "id": str(metadata.get("id") or path.stem),
                "module": str(metadata.get("module") or ""),
                "title": str(metadata.get("title") or path.stem),
                "summary": summary[:240],
                "aliases": metadata.get("aliases") if isinstance(metadata.get("aliases"), list) else [],
            })
        lines = [
            "# WeMail Support Knowledge Map", "",
            "Only documents listed here are approved for ordinary-user answers.",
            "Search by module, symptom, alias, product term, or error text; then read the exact document.", "",
        ]
        for row in rows:
            aliases = "、".join(row["aliases"][:8])
            lines.extend([
                f"## {row['id']} · {row['title']}",
                f"- 模块：{row['module']}",
                f"- 摘要：{row['summary']}",
                f"- 症状别名：{aliases or '无'}", "",
            ])
        self.index_path.write_text("\n".join(lines), encoding="utf-8")
        return {"documents": len(rows), "updated_at": _now()}

    def search(self, query: str, module_id: str | None, limit: int) -> list[dict[str, Any]]:
        terms = _search_terms(query)
        scored: list[tuple[int, dict[str, Any]]] = []
        for path in self.published.glob("*.md"):
            metadata, content = self._doc_metadata(path)
            if not _is_public_knowledge(metadata):
                continue
            if module_id and metadata.get("module") != module_id:
                continue
            title = str(metadata.get("title") or path.stem)
            aliases = metadata.get("aliases") if isinstance(metadata.get("aliases"), list) else []
            summary = str(metadata.get("summary") or "")
            title_haystack = f"{title} {' '.join(map(str, aliases))}".lower()
            body_haystack = f"{summary} {content}".lower()
            score = sum(8 for term in terms if term in title_haystack)
            score += sum(2 for term in terms if term in body_haystack)
            if query.strip().lower() in body_haystack:
                score += 12
            if score <= 0:
                continue
            matched_terms = sorted(term for term in terms if term in title_haystack or term in body_haystack)
            scored.append((score, {
                "document_id": str(metadata.get("id") or path.stem),
                "module": str(metadata.get("module") or ""),
                "title": title,
                "summary": summary[:360],
                "score": score,
                "matched_terms": matched_terms[:12],
            }))
        scored.sort(key=lambda item: (-item[0], item[1]["document_id"]))
        selected = [item[1] for item in scored[: max(1, min(limit, 10))]]
        if selected:
            best = max(int(item["score"]) for item in selected)
            for item in selected:
                ratio = int(item["score"]) / best if best else 0
                item["confidence"] = "high" if ratio >= 0.75 else "medium" if ratio >= 0.4 else "low"
        return selected

    def read(self, document_id: str) -> dict[str, Any]:
        if not SAFE_DOC_ID.fullmatch(document_id):
            raise ValueError("invalid document id")
        path = self.published / f"{document_id}.md"
        if not path.exists():
            raise FileNotFoundError("published document not found")
        metadata, content = self._doc_metadata(path)
        if not _is_public_knowledge(metadata):
            raise PermissionError("document is not approved for users")
        return {
            "document_id": document_id,
            "module": metadata.get("module"),
            "title": metadata.get("title") or document_id,
            "version": metadata.get("version"),
            "content": content,
            "citation": str(metadata.get("title") or document_id),
            "product_baseline": self.product_baseline(),
        }

    def create_case(self, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(data)
        if not str(normalized.get("primary_module") or "").strip():
            query = _latest_user_query()
            matches = self.search(query, None, 1) if query else []
            normalized["primary_module"] = matches[0]["module"] if matches else "WM-17"
            normalized.setdefault("title", query[:160] or "WeMail 用户反馈")
            normalized.setdefault("symptom", query[:2000] or "用户要求产品支持跟进")
            if re.search(r"(?i)(密码|密钥|token|越权|泄露|隐私|安全)", query):
                normalized.setdefault("category", "security")
                normalized.setdefault("priority", "high")
            elif re.search(r"(失败|错误|异常|无法|不行|读不到|没有同步|崩溃|闪退)", query):
                normalized.setdefault("category", "bug")
            else:
                normalized.setdefault("category", "feature")
                normalized.setdefault("priority", "low")
        data = _redact_support_input(normalized)
        module_id = self._validate_module(str(data.get("primary_module") or ""))
        related = [str(value) for value in data.get("related_modules") or [] if str(value) in MODULE_IDS]
        priority = str(data.get("priority") or "medium")
        if priority not in PRIORITIES:
            priority = "medium"
        fingerprint = _issue_fingerprint(data)
        handoff_required = bool(data.get("handoff_required"))
        with self._connect() as db:
            existing = db.execute(
                """SELECT id,primary_module,priority,status,updated_at FROM support_cases
                   WHERE reporter_id=? AND issue_fingerprint=?
                     AND status NOT IN ('resolved','closed')
                   ORDER BY updated_at DESC LIMIT 1""",
                (actor.user_id, fingerprint),
            ).fetchone()
        if existing:
            if handoff_required:
                with self._connect() as db:
                    db.execute(
                        "UPDATE support_cases SET handoff_required=1,updated_at=? WHERE id=?",
                        (_now(), existing["id"]),
                    )
            return {
                "case_id": existing["id"],
                "status": existing["status"],
                "module": existing["primary_module"],
                "priority": existing["priority"],
                "deduplicated": True,
                "handoff_required": handoff_required,
            }
        category = str(data.get("category") or "investigation")[:80]
        initial_status = "feature_request" if category == "feature" else "triaging"
        case_id = f"CASE-{uuid.uuid4().hex[:8].upper()}"
        todo_id = f"STODO-{uuid.uuid4().hex[:8].upper()}"
        created = _now()
        environment = data.get("environment") if isinstance(data.get("environment"), dict) else {}
        with self._connect() as db:
            db.execute(
                """INSERT INTO support_cases(id,reporter_id,reporter_name,chat_id,primary_module,related_modules_json,category,title,symptom,environment_json,reproduction,expected,actual,evidence,priority,status,created_at,updated_at,issue_fingerprint,origin_chat_type,handoff_required)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (case_id, actor.user_id, actor.user_name, actor.chat_id, module_id,
                 _json(related), category,
                 str(data.get("title") or "WeMail 用户反馈")[:200],
                 str(data.get("symptom") or "")[:4000], _json(environment),
                 str(data.get("reproduction") or "")[:4000], str(data.get("expected") or "")[:2000],
                 str(data.get("actual") or "")[:2000], SENSITIVE_RE.sub(r"\1=[REDACTED]", str(data.get("evidence") or ""))[:6000],
                 priority, initial_status, created, created, fingerprint, actor.chat_type, int(handoff_required)),
            )
            self._audit(db, actor, "create", "support_case", case_id, {"module": module_id, "priority": priority})
            db.execute(
                """INSERT INTO support_todos(id,case_id,title,description,module_id,assignee_id,status,priority,due_at,created_by,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (todo_id, case_id, f"跟进：{str(data.get('title') or 'WeMail 用户反馈')[:180]}",
                 str(data.get("symptom") or "")[:6000], module_id, None, "pending", priority,
                 None, actor.user_id, created, created),
            )
            self._audit(db, actor, "auto_create", "support_todo", todo_id, {"case_id": case_id, "module": module_id})
        notification = self._notify(
            "support_case_created", case_id, module_id,
            f"📨 WeMail 新用户反馈\n编号：{case_id}\n模块：{module_id}\n优先级：{priority}\n标题：{str(data.get('title') or 'WeMail 用户反馈')[:200]}\n跟进待办：{todo_id}",
        )
        return {"case_id": case_id, "todo_id": todo_id, "status": initial_status, "module": module_id, "priority": priority, "notification": notification, "deduplicated": False, "handoff_required": handoff_required}

    def append_case_evidence(self, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
        case_id = str(data.get("case_id") or "").strip().upper()
        event_type = str(data.get("event_type") or "user_followup")[:80]
        summary = str(_redact_support_input(data.get("summary") or "")).strip()[:2000]
        evidence = str(_redact_support_input(data.get("evidence") or "")).strip()[:6000]
        if not summary:
            raise ValueError("summary is required")
        with self._connect() as db:
            row = db.execute("SELECT * FROM support_cases WHERE id=?", (case_id,)).fetchone()
            if not row:
                raise FileNotFoundError("support case not found")
            if row["reporter_id"] != actor.user_id:
                self.require_admin(actor, row["primary_module"])
            created = _now()
            db.execute(
                """INSERT INTO support_case_events(case_id,actor_id,actor_name,event_type,summary,evidence,source_chat_id,source_chat_type,created_at)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                (case_id, actor.user_id, actor.user_name, event_type, summary, evidence,
                 actor.chat_id, actor.chat_type, created),
            )
            db.execute("UPDATE support_cases SET updated_at=? WHERE id=?", (created, case_id))
            self._audit(db, actor, "append_evidence", "support_case", case_id, {"event_type": event_type})
        return {"case_id": case_id, "appended": True, "updated_at": created}

    def analyze_diagnostics(self, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
        # The shared gateway cache does not establish which session owns a
        # path. Refuse before opening or deleting any file until the gateway
        # supplies a trusted attachment-to-session binding.
        raise PermissionError("diagnostic attachment analysis is unavailable: session ownership cannot be verified")

    def list_cases(self, actor: Actor, status: str | None, limit: int) -> list[dict[str, Any]]:
        admin = self.admin_scope(actor)
        clauses: list[str] = []
        params: list[Any] = []
        if admin is None:
            clauses.append("reporter_id = ?")
            params.append(actor.user_id)
        elif admin[0] != "super_admin":
            placeholders = ",".join("?" for _ in admin[1]) or "''"
            clauses.append(f"primary_module IN ({placeholders})")
            params.extend(sorted(admin[1]))
        if status:
            clauses.append("status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(max(1, min(limit, 50)))
        with self._connect() as db:
            rows = db.execute(
                f"SELECT id,title,primary_module,category,priority,status,assigned_to,created_at,updated_at FROM support_cases {where} ORDER BY updated_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    def resume_private_handoff(self, actor: Actor, case_id: str | None) -> dict[str, Any]:
        """Resume this exact reporter's group-originated issue in a private chat.

        Conversation transcripts remain isolated by Hermes.  Only the bounded,
        already-scrubbed support-case snapshot crosses the group/DM boundary.
        """
        if actor.chat_type != "dm":
            raise PermissionError("a support handoff may only be resumed in a one-to-one chat")
        requested_id = str(case_id or "").strip().upper()
        clauses = ["reporter_id = ?"]
        params: list[Any] = [actor.user_id]
        if requested_id:
            clauses.append("id = ?")
            params.append(requested_id)
        else:
            clauses.append("status NOT IN ('resolved','closed')")
        where = " AND ".join(clauses)
        with self._connect() as db:
            rows = db.execute(
                f"""SELECT id,primary_module,category,title,symptom,environment_json,
                           reproduction,expected,actual,evidence,priority,status,
                           created_at,updated_at
                    FROM support_cases WHERE {where}
                    ORDER BY updated_at DESC LIMIT 2""",
                params,
            ).fetchall()
            if not rows:
                raise FileNotFoundError(
                    "no matching open support case belongs to the current WeCom user"
                )
            if not requested_id and len(rows) > 1:
                raise ValueError(
                    "more than one open support case belongs to this user; provide the case_id from the group reply"
                )
            row = rows[0]
            todo = db.execute(
                """SELECT id,status,priority FROM support_todos
                   WHERE case_id=? ORDER BY updated_at DESC LIMIT 1""",
                (row["id"],),
            ).fetchone()
            self._audit(
                db,
                actor,
                "resume_private_handoff",
                "support_case",
                row["id"],
                {"surface": "dm"},
            )
        try:
            environment = json.loads(row["environment_json"] or "{}")
        except (TypeError, ValueError):
            environment = {}
        snapshot = {
            "case_id": row["id"],
            "primary_module": row["primary_module"],
            "category": row["category"],
            "title": row["title"],
            "symptom": row["symptom"],
            "environment": environment,
            "reproduction": row["reproduction"],
            "expected": row["expected"],
            "actual": row["actual"],
            "evidence": row["evidence"],
            "priority": row["priority"],
            "status": row["status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "todo": dict(todo) if todo else None,
        }
        return _scrub_diagnostic_value(snapshot)

    def update_case(self, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
        data = _redact_support_input(data)
        case_id = str(data.get("case_id") or "")
        with self._connect() as db:
            row = db.execute("SELECT * FROM support_cases WHERE id=?", (case_id,)).fetchone()
            if not row:
                raise FileNotFoundError("support case not found")
            self.require_admin(actor, row["primary_module"])
            patch: dict[str, Any] = {}
            for field in ("status", "priority", "assigned_to", "resolution"):
                if field in data and data[field] is not None:
                    patch[field] = str(data[field])
            if "status" in patch and patch["status"] not in CASE_STATUSES:
                raise ValueError("invalid case status")
            if "priority" in patch and patch["priority"] not in PRIORITIES:
                raise ValueError("invalid priority")
            if not patch:
                raise ValueError("no case changes supplied")
            patch["updated_at"] = _now()
            assignments = ", ".join(f"{key}=?" for key in patch)
            db.execute(f"UPDATE support_cases SET {assignments} WHERE id=?", (*patch.values(), case_id))
            self._audit(db, actor, "update", "support_case", case_id, patch)
        return {"case_id": case_id, **patch}

    def create_todo(self, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
        data = _redact_support_input(data)
        module_id = self._validate_module(str(data.get("module_id") or ""))
        self.require_admin(actor, module_id)
        case_id = str(data.get("case_id") or "") or None
        priority = str(data.get("priority") or "medium")
        if priority not in PRIORITIES:
            priority = "medium"
        todo_id = f"STODO-{uuid.uuid4().hex[:8].upper()}"
        created = _now()
        with self._connect() as db:
            if case_id:
                case = db.execute("SELECT primary_module FROM support_cases WHERE id=?", (case_id,)).fetchone()
                if not case:
                    raise FileNotFoundError("support case not found")
                self.require_admin(actor, case["primary_module"])
            db.execute(
                """INSERT INTO support_todos(id,case_id,title,description,module_id,assignee_id,status,priority,due_at,created_by,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (todo_id, case_id, str(data.get("title") or "跟进 WeMail 用户反馈")[:200],
                 str(data.get("description") or "")[:6000], module_id,
                 str(data.get("assignee_id") or "") or None, "pending", priority,
                 str(data.get("due_at") or "") or None, actor.user_id, created, created),
            )
            self._audit(db, actor, "create", "support_todo", todo_id, {"case_id": case_id, "module": module_id})
        return {"todo_id": todo_id, "case_id": case_id, "status": "pending"}

    def list_todos(self, actor: Actor, status: str | None, limit: int) -> list[dict[str, Any]]:
        admin = self.require_admin(actor)
        clauses: list[str] = []
        params: list[Any] = []
        if admin[0] != "super_admin":
            placeholders = ",".join("?" for _ in admin[1]) or "''"
            clauses.append(f"module_id IN ({placeholders})")
            params.extend(sorted(admin[1]))
        if status:
            clauses.append("status=?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(max(1, min(limit, 50)))
        with self._connect() as db:
            rows = db.execute(
                f"SELECT id,case_id,title,module_id,assignee_id,status,priority,due_at,updated_at FROM support_todos {where} ORDER BY updated_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    def update_todo(self, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
        data = _redact_support_input(data)
        todo_id = str(data.get("todo_id") or "")
        with self._connect() as db:
            row = db.execute("SELECT * FROM support_todos WHERE id=?", (todo_id,)).fetchone()
            if not row:
                raise FileNotFoundError("support todo not found")
            self.require_admin(actor, row["module_id"])
            patch: dict[str, Any] = {}
            for field in ("status", "assignee_id", "due_at", "description"):
                if field in data and data[field] is not None:
                    patch[field] = str(data[field]) or None
            if "status" in patch and patch["status"] not in TODO_STATUSES:
                raise ValueError("invalid todo status")
            if not patch:
                raise ValueError("no todo changes supplied")
            patch["updated_at"] = _now()
            db.execute(
                f"UPDATE support_todos SET {', '.join(f'{key}=?' for key in patch)} WHERE id=?",
                (*patch.values(), todo_id),
            )
            self._audit(db, actor, "update", "support_todo", todo_id, patch)
        return {"todo_id": todo_id, **patch}

    def _assert_document_module(self, db: sqlite3.Connection, document_id: str, module_id: str) -> None:
        path = self.published / f"{document_id}.md"
        if path.exists():
            metadata, _ = self._doc_metadata(path)
            if metadata.get("module") != module_id:
                raise PermissionError("document belongs to a different or unknown module")
        versions = db.execute("SELECT DISTINCT module_id FROM knowledge_versions WHERE document_id=?", (document_id,)).fetchall()
        if any(version["module_id"] != module_id for version in versions):
            raise PermissionError("document history belongs to a different module")

    def create_draft(self, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
        data = _redact_support_input(data)
        module_id = self._validate_module(str(data.get("module_id") or ""))
        self.require_admin(actor, module_id)
        document_id = str(data.get("document_id") or "").lower()
        if not SAFE_DOC_ID.fullmatch(document_id):
            raise ValueError("document_id must use lowercase letters, numbers, dots, underscores, or hyphens")
        draft_id = f"KDRAFT-{uuid.uuid4().hex[:8].upper()}"
        created = _now()
        aliases = [str(value)[:120] for value in data.get("aliases") or []][:30]
        versions = data.get("versions") if isinstance(data.get("versions"), dict) else {"since": "1.1", "until": None}
        content = SENSITIVE_RE.sub(r"\1=[REDACTED]", str(data.get("content") or "").strip())
        if len(content) < 20:
            raise ValueError("knowledge content is too short")
        with self._connect() as db:
            self._assert_document_module(db, document_id, module_id)
            db.execute(
                """INSERT INTO knowledge_drafts(id,document_id,module_id,title,audience,confidentiality,aliases_json,versions_json,content,change_reason,status,created_by,last_edited_by,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (draft_id, document_id, module_id, str(data.get("title") or document_id)[:200],
                 str(data.get("audience") or "user"), str(data.get("confidentiality") or "public"),
                 _json(aliases), _json(versions), content, str(data.get("change_reason") or "")[:1000],
                 "in_review", actor.user_id, actor.user_id, created, created),
            )
            self._audit(db, actor, "create", "knowledge_draft", draft_id, {"document_id": document_id, "module": module_id})
        return {"draft_id": draft_id, "document_id": document_id, "status": "in_review"}

    def list_drafts(self, actor: Actor, status: str | None, limit: int) -> list[dict[str, Any]]:
        admin = self.require_admin(actor)
        clauses: list[str] = []
        params: list[Any] = []
        if admin[0] != "super_admin":
            placeholders = ",".join("?" for _ in admin[1]) or "''"
            clauses.append(f"module_id IN ({placeholders})")
            params.extend(sorted(admin[1]))
        if status:
            clauses.append("status=?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(max(1, min(limit, 50)))
        with self._connect() as db:
            rows = db.execute(
                f"SELECT id,document_id,module_id,title,status,created_by,reviewed_by,review_note,updated_at FROM knowledge_drafts {where} ORDER BY updated_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    def get_draft(self, actor: Actor, draft_id: str) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute("SELECT * FROM knowledge_drafts WHERE id=?", (draft_id,)).fetchone()
        if not row:
            raise FileNotFoundError("knowledge draft not found")
        self.require_admin(actor, row["module_id"])
        with self._connect() as db:
            self._assert_document_module(db, row["document_id"], row["module_id"])
        published_path = self.published / f"{row['document_id']}.md"
        current_content = ""
        if published_path.exists():
            _, current_content = self._doc_metadata(published_path)
        diff = "\n".join(difflib.unified_diff(
            current_content.splitlines(), row["content"].splitlines(),
            fromfile="current-published", tofile=f"draft-{draft_id}", lineterm="",
        ))
        return {
            "draft_id": row["id"], "document_id": row["document_id"],
            "module_id": row["module_id"], "title": row["title"],
            "status": row["status"], "content": row["content"],
            "change_reason": row["change_reason"], "created_by": row["created_by"],
            "last_edited_by": row["last_edited_by"],
            "reviewed_by": row["reviewed_by"], "review_note": row["review_note"],
            "diff": diff[:20000],
        }

    def update_draft(self, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
        data = _redact_support_input(data)
        draft_id = str(data.get("draft_id") or "").strip().upper()
        with self._connect() as db:
            row = db.execute("SELECT * FROM knowledge_drafts WHERE id=?", (draft_id,)).fetchone()
            if not row:
                raise FileNotFoundError("knowledge draft not found")
            self.require_admin(actor, row["module_id"])
            if row["status"] in {"approved", "published"}:
                raise ValueError("approved or published drafts cannot be edited")
            content = SENSITIVE_RE.sub(r"\1=[REDACTED]", str(data.get("content") or row["content"]).strip())
            if len(content) < 20:
                raise ValueError("knowledge content is too short")
            reason = str(data.get("change_reason") or row["change_reason"])[:1000]
            updated = _now()
            db.execute(
                "UPDATE knowledge_drafts SET content=?,change_reason=?,status='in_review',last_edited_by=?,reviewed_by=NULL,review_note='',updated_at=? WHERE id=?",
                (content, reason, actor.user_id, updated, draft_id),
            )
            self._audit(db, actor, "update", "knowledge_draft", draft_id, {"change_reason": reason})
        return {"draft_id": draft_id, "status": "in_review", "updated_at": updated}

    def review_draft(self, actor: Actor, draft_id: str, decision: str, note: str) -> dict[str, Any]:
        note = str(_redact_support_input(note))
        if decision not in {"approve", "reject", "request_changes"}:
            raise ValueError("decision must be approve, reject, or request_changes")
        with self._connect() as db:
            row = db.execute("SELECT * FROM knowledge_drafts WHERE id=?", (draft_id,)).fetchone()
            if not row:
                raise FileNotFoundError("knowledge draft not found")
            self.require_admin(actor, row["module_id"])
            if row["status"] != "in_review":
                raise ValueError("only drafts in review can be reviewed")
            if decision == "approve" and (not row["last_edited_by"] or actor.user_id in {row["created_by"], row["last_edited_by"]}):
                raise PermissionError("a different administrator must approve the draft")
            status = {"approve": "approved", "reject": "rejected", "request_changes": "changes_requested"}[decision]
            db.execute(
                "UPDATE knowledge_drafts SET status=?,reviewed_by=?,review_note=?,updated_at=? WHERE id=?",
                (status, actor.user_id, note[:1000], _now(), draft_id),
            )
            self._audit(db, actor, decision, "knowledge_draft", draft_id, {"note": note[:1000]})
        return {"draft_id": draft_id, "status": status}

    @staticmethod
    def _render_document(row: sqlite3.Row, version: int) -> str:
        aliases = json.loads(row["aliases_json"])
        versions = json.loads(row["versions_json"])
        summary = next((line.strip("# ") for line in row["content"].splitlines() if line.strip()), row["title"])
        metadata = {
            "id": row["document_id"], "module": row["module_id"], "title": row["title"],
            "version": version, "audience": row["audience"], "confidentiality": row["confidentiality"],
            "aliases": aliases, "versions": versions, "summary": summary[:240],
        }
        lines = ["---"]
        for key, value in metadata.items():
            rendered = _json(value) if isinstance(value, (list, dict)) else str(value)
            lines.append(f"{key}: {rendered}")
        lines.extend(["---", "", row["content"].strip(), ""])
        return "\n".join(lines)

    def publish_draft(self, actor: Actor, draft_id: str) -> dict[str, Any]:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM knowledge_drafts WHERE id=?", (draft_id,)).fetchone()
            if not row:
                raise FileNotFoundError("knowledge draft not found")
            self.require_admin(actor, row["module_id"])
            self._assert_document_module(db, row["document_id"], row["module_id"])
            if row["status"] != "approved":
                raise ValueError("draft must be approved before publishing")
            if row["confidentiality"] != "public" or row["audience"] not in PUBLIC_AUDIENCES:
                raise ValueError("only public user-facing knowledge can be published to the user corpus")
            if not row["last_edited_by"] or not row["reviewed_by"] or row["reviewed_by"] in {row["created_by"], row["last_edited_by"]}:
                raise PermissionError("a different administrator must approve the draft")
            version = int(db.execute(
                "SELECT COALESCE(MAX(version),0)+1 FROM knowledge_versions WHERE document_id=?",
                (row["document_id"],),
            ).fetchone()[0])
            rendered = self._render_document(row, version)
            path = self.published / f"{row['document_id']}.md"
            temporary = path.with_suffix(".md.tmp")
            temporary.write_text(rendered, encoding="utf-8")
            temporary.replace(path)
            metadata = {
                "audience": row["audience"], "confidentiality": row["confidentiality"],
                "aliases": json.loads(row["aliases_json"]), "versions": json.loads(row["versions_json"]),
            }
            db.execute(
                "INSERT INTO knowledge_versions(document_id,version,module_id,title,metadata_json,content,content_hash,published_by,published_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (row["document_id"], version, row["module_id"], row["title"], _json(metadata), row["content"],
                 hashlib.sha256(row["content"].encode("utf-8")).hexdigest(), actor.user_id, _now()),
            )
            db.execute(
                "UPDATE knowledge_drafts SET status='published',published_version=?,updated_at=? WHERE id=?",
                (version, _now(), draft_id),
            )
            self._audit(db, actor, "publish", "knowledge_document", row["document_id"], {"version": version, "draft_id": draft_id})
            index = self.rebuild_index()
        return {"draft_id": draft_id, "document_id": row["document_id"], "version": version, "status": "published", "index": index}

    def rollback(self, actor: Actor, document_id: str, version: int) -> dict[str, Any]:
        if not SAFE_DOC_ID.fullmatch(document_id):
            raise ValueError("invalid document id")
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT * FROM knowledge_versions WHERE document_id=? AND version=?",
                (document_id, version),
            ).fetchone()
            if not row:
                raise FileNotFoundError("knowledge version not found")
            role, _ = self.require_admin(actor, row["module_id"])
            if role != "super_admin":
                raise PermissionError("rollback requires super administrator")
            metadata = json.loads(row["metadata_json"])
            if not _is_public_knowledge(metadata):
                raise ValueError("only public user-facing knowledge can be restored to the user corpus")
            fake = {
                "document_id": document_id, "module_id": row["module_id"], "title": row["title"],
                "audience": metadata.get("audience", "user"), "confidentiality": metadata.get("confidentiality", "public"),
                "aliases_json": _json(metadata.get("aliases", [])), "versions_json": _json(metadata.get("versions", {})),
                "content": row["content"],
            }
            class Row(dict):
                __getattr__ = dict.__getitem__
            rendered = self._render_document(Row(fake), version)
            (self.published / f"{document_id}.md").write_text(rendered, encoding="utf-8")
            self._audit(db, actor, "rollback", "knowledge_document", document_id, {"version": version})
            index = self.rebuild_index()
        return {"document_id": document_id, "version": version, "status": "rolled_back", "index": index}

    def status(self, actor: Actor) -> dict[str, Any]:
        admin = self.admin_scope(actor)
        with self._connect() as db:
            counts = {
                "cases": db.execute("SELECT COUNT(*) FROM support_cases").fetchone()[0],
                "open_cases": db.execute("SELECT COUNT(*) FROM support_cases WHERE status NOT IN ('resolved','closed')").fetchone()[0],
                "support_todos": db.execute("SELECT COUNT(*) FROM support_todos").fetchone()[0],
                "pending_todos": db.execute("SELECT COUNT(*) FROM support_todos WHERE status IN ('pending','in_progress','blocked')").fetchone()[0],
                "drafts_in_review": db.execute("SELECT COUNT(*) FROM knowledge_drafts WHERE status='in_review'").fetchone()[0],
            }
        return {
            "ok": True,
            "role": admin[0] if admin else "user",
            "modules": sorted(admin[1]) if admin else [],
            "published_documents": len(list(self.published.glob("*.md"))),
            **counts,
        }


_RUNTIME: SupportRuntime | None = None
_RUNTIME_LOCK = threading.Lock()


def runtime() -> SupportRuntime:
    global _RUNTIME
    with _RUNTIME_LOCK:
        if _RUNTIME is None:
            _RUNTIME = SupportRuntime()
        return _RUNTIME


def build_pre_llm_context(user_message: str, platform: str) -> dict[str, str] | None:
    """Preload approved product facts for dedicated WeCom support turns.

    Skill selection is model-driven and can be skipped.  The support channel
    cannot safely fall back to model memory, so product turns receive a small
    authoritative context before the first model call.  Tools remain available
    for follow-up reads and mutations.
    """
    text = str(user_message or "").strip()
    if not text:
        return None
    _TURN_SUPPORT_QUERY.set(text[:4000])
    force = os.getenv("WEMAIL_SUPPORT_FORCE_CONTEXT") == "1"
    if platform != "wecom" and not force:
        return None
    normalized = re.sub(r"[\s，。！？!?,.]+", "", text.lower())
    if normalized in {"hi", "hello", "你好", "您好", "在吗", "你是谁", "你能做什么", "hello你能做什么"}:
        return None
    support = runtime()
    matches = support.search(text, None, 3)
    if not matches:
        return {
            "context": (
                "[WEMAIL_SUPPORT_GUARD]\n"
                "这是 WeMail 产品支持问题，但当前已发布知识没有可靠命中。"
                "不得依据模型记忆猜测产品能力、版本、入口或限制；如需产品事实，"
                "调用 wemail_support_search/read。仍无结论时说明尚待确认并按规则跟进。"
            )
        }
    baseline = support.product_baseline()
    sections = [
        "[WEMAIL_APPROVED_KNOWLEDGE]",
        f"当前正式版：WeMail {baseline.get('current_release')}（Windows 桌面版）。",
        "以下内容来自已发布知识，优先级高于模型记忆和会话中的旧答复。"
        "直接据此回答，不让用户自行检查产品是否具备已明确的能力。",
    ]
    for match in matches[:3]:
        document = support.read(str(match["document_id"]))
        sections.extend([
            f"\n## {document['title']}",
            str(document["content"])[:7000],
        ])
    sections.append(
        "\n[END_WEMAIL_APPROVED_KNOWLEDGE]\n"
        "只组合当前问题需要的结论和步骤；不要照抄整篇文档，不展示 WM 模块或内部编号。"
    )
    return {"context": "\n".join(sections)[:22000]}


def _call(operation):
    def handler(args: dict, **_: Any) -> str:
        try:
            actor = _actor()
            if actor.platform != "wecom" or not actor.user_id:
                raise PermissionError("authenticated WeCom session required")
            return _result(ok=True, **operation(runtime(), actor, args))
        except PermissionError as exc:
            return _error("permission_denied", str(exc))
        except FileNotFoundError as exc:
            return _error("not_found", str(exc))
        except KeyError as exc:
            return _error("invalid_arguments", f"missing required argument: {exc.args[0]}")
        except ValueError as exc:
            return _error("invalid_arguments", str(exc))
    return handler


def _object(properties: dict[str, Any], required: Iterable[str] = ()) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


S = {"type": "string"}
MODULE = {"type": "string", "enum": sorted(MODULE_IDS)}
STATUS_CASE = {"type": "string", "enum": sorted(CASE_STATUSES)}
STATUS_TODO = {"type": "string", "enum": sorted(TODO_STATUSES)}
PRIORITY = {"type": "string", "enum": sorted(PRIORITIES)}


TOOL_SPECS = [
    {"name": "wemail_support_search", "description": "Search only approved public WeMail support knowledge. Always pass a non-empty query string, for example {\"query\":\"外观 主题 配色\"}. Use before answering product behavior, troubleshooting, known issues, or limits. Returns document ids, never filesystem paths or source code.", "handler": _call(lambda r,a,x: _search_public_knowledge(r, x)), "schema": _object({"query": S, "module_id": MODULE, "limit": {"type":"integer","minimum":1,"maximum":10}}, ["query"]), "emoji": "🔎"},
    {"name": "wemail_support_read", "description": "Read one exact approved public knowledge document returned by wemail_support_search and use its friendly title as the citation. Never invent a document id.", "handler": _call(lambda r,a,x: _read_public_knowledge(r, x)), "schema": _object({"document_id": S}, ["document_id"]), "emoji": "📖"},
    {"name": "wemail_support_analyze_diagnostics", "description": "Unavailable until attachment ownership can be verified. Do not request or submit diagnostic files for automated analysis.", "handler": _call(lambda r,a,x: {"diagnostics": r.analyze_diagnostics(a,x)}), "schema": _object({"file_path": S,"case_id":S}, ["file_path"]), "emoji": "🩺"},
    {"name": "wemail_support_create_case", "description": "Create or reuse a durable support case for a confirmed defect, explicit feature request, security concern, or unresolved problem. Prefer a stable issue_key for the same user issue; when omitted, the backend derives a redacted fingerprint and still prevents an identical open case. Set handoff_required only when a group-to-DM material handoff is actually needed.", "handler": _call(lambda r,a,x: {"case": r.create_case(a,x)}), "schema": _object({"primary_module":MODULE,"related_modules":{"type":"array","items":MODULE},"category":{"type":"string","enum":["how_to","configuration","expected_limit","bug","feature","quality","external_dependency","investigation","security"]},"title":S,"symptom":S,"environment":{"type":"object"},"reproduction":S,"expected":S,"actual":S,"evidence":S,"priority":PRIORITY,"issue_key":S,"handoff_required":{"type":"boolean"}}, ["primary_module","category","title","symptom"]), "emoji":"🎫"},
    {"name": "wemail_support_append_case_evidence", "description": "Append a bounded, redacted follow-up to an existing case. The reporter may append only to their own case; administrators are module-scoped. Use this instead of creating another case when the user adds time, screenshots, reproduction results, or diagnostic conclusions.", "handler": _call(lambda r,a,x: {"case": r.append_case_evidence(a,x)}), "schema": _object({"case_id":S,"event_type":S,"summary":S,"evidence":S}, ["case_id","summary"]), "emoji":"🧾"},
    {"name": "wemail_support_resume_private_handoff", "description": "In a one-to-one chat, recover the current verified WeCom user's own bounded support-case snapshot after an issue began in a group. Pass the case_id from the group reply. It may fall back only when exactly one open case belongs to this user; multiple open cases require an explicit id. Never returns another user's case or a raw group transcript.", "handler": _call(lambda r,a,x: {"handoff": r.resume_private_handoff(a,x.get("case_id"))}), "schema": _object({"case_id":S}), "emoji":"🔐"},
    {"name": "wemail_support_list_cases", "description": "List support cases visible to the current identity. Users see only their own cases; administrators see only authorized modules.", "handler": _call(lambda r,a,x: {"cases": r.list_cases(a,x.get("status"),int(x.get("limit",20)))}), "schema": _object({"status":STATUS_CASE,"limit":{"type":"integer","minimum":1,"maximum":50}})},
    {"name": "wemail_support_update_case", "description": "Administrator-only: update status, priority, assignment, or resolution of a support case. Module scope is enforced by the backend.", "handler": _call(lambda r,a,x: {"case":r.update_case(a,x)}), "schema": _object({"case_id":S,"status":STATUS_CASE,"priority":PRIORITY,"assigned_to":S,"resolution":S}, ["case_id"])},
    {"name": "wemail_support_create_todo", "description": "Administrator-only: create a support todo linked to a support case. This is not a WeMail mail todo.", "handler": _call(lambda r,a,x: {"todo":r.create_todo(a,x)}), "schema": _object({"case_id":S,"title":S,"description":S,"module_id":MODULE,"assignee_id":S,"priority":PRIORITY,"due_at":S}, ["title","module_id"])},
    {"name": "wemail_support_list_todos", "description": "Administrator-only: list support todos for authorized modules.", "handler": _call(lambda r,a,x: {"todos":r.list_todos(a,x.get("status"),int(x.get("limit",20)))}), "schema": _object({"status":STATUS_TODO,"limit":{"type":"integer","minimum":1,"maximum":50}})},
    {"name": "wemail_support_update_todo", "description": "Administrator-only: update a support todo status, assignee, due time, or description.", "handler": _call(lambda r,a,x: {"todo":r.update_todo(a,x)}), "schema": _object({"todo_id":S,"status":STATUS_TODO,"assignee_id":S,"due_at":S,"description":S}, ["todo_id"])},
    {"name": "wemail_support_create_draft", "description": "Administrator-only: create a reviewed knowledge change draft. Never writes directly to the published corpus.", "handler": _call(lambda r,a,x: {"draft":r.create_draft(a,x)}), "schema": _object({"document_id":S,"module_id":MODULE,"title":S,"audience":{"type":"string","enum":["user","all","admin"]},"confidentiality":{"type":"string","enum":["public","internal","restricted"]},"aliases":{"type":"array","items":S},"versions":{"type":"object"},"content":S,"change_reason":S}, ["document_id","module_id","title","content","change_reason"])},
    {"name": "wemail_support_list_drafts", "description": "Administrator-only: list knowledge drafts in authorized modules.", "handler": _call(lambda r,a,x: {"drafts":r.list_drafts(a,x.get("status"),int(x.get("limit",20)))}), "schema": _object({"status":{"type":"string","enum":sorted(DRAFT_STATUSES)},"limit":{"type":"integer","minimum":1,"maximum":50}})},
    {"name": "wemail_support_get_draft", "description": "Administrator-only: read a knowledge draft, its current published content comparison, and a bounded unified diff before reviewing it.", "handler": _call(lambda r,a,x: {"draft":r.get_draft(a,str(x["draft_id"]))}), "schema": _object({"draft_id":S}, ["draft_id"])},
    {"name": "wemail_support_update_draft", "description": "Administrator-only: revise a draft after review feedback and return it to in-review state.", "handler": _call(lambda r,a,x: {"draft":r.update_draft(a,x)}), "schema": _object({"draft_id":S,"content":S,"change_reason":S}, ["draft_id","content"])},
    {"name": "wemail_support_review_draft", "description": "Administrator-only: after reading the draft and diff, approve, reject, or request changes with a review note. Approval is separate from publication.", "handler": _call(lambda r,a,x: {"draft":r.review_draft(a,str(x["draft_id"]),str(x["decision"]),str(x.get("note") or ""))}), "schema": _object({"draft_id":S,"decision":{"type":"string","enum":["approve","reject","request_changes"]},"note":S}, ["draft_id","decision"])},
    {"name": "wemail_support_publish_draft", "description": "Administrator-only: publish a public draft approved by another administrator, create a version, rebuild index.md, and audit the change.", "handler": _call(lambda r,a,x: {"publication":r.publish_draft(a,str(x["draft_id"]))}), "schema": _object({"draft_id":S}, ["draft_id"])},
    {"name": "wemail_support_rollback_document", "description": "Super-administrator-only: roll a published knowledge document back to a recorded version and rebuild the public index.", "handler": _call(lambda r,a,x: {"rollback":r.rollback(a,str(x["document_id"]),int(x["version"]))}), "schema": _object({"document_id":S,"version":{"type":"integer","minimum":1}}, ["document_id","version"])},
    {"name": "wemail_support_list_admins", "description": "Super-administrator-only: list configured WeMail support administrators, module scopes, and notification targets.", "handler": _call(lambda r,a,x: {"admins":r.list_admins(a)}), "schema": _object({})},
    {"name": "wemail_support_upsert_admin", "description": "Super-administrator-only: add or update a support administrator. Use the exact trusted WeCom user id, never a display name, as identity.", "handler": _call(lambda r,a,x: {"admin":r.upsert_admin(a,x)}), "schema": _object({"user_id":S,"display_name":S,"role":{"type":"string","enum":["super_admin","module_admin"]},"modules":{"type":"array","items":MODULE},"notification_target":S}, ["user_id","role"])},
    {"name": "wemail_support_remove_admin", "description": "Super-administrator-only: remove a support administrator. The backend prevents removal of the last super administrator.", "handler": _call(lambda r,a,x: {"admin":r.remove_admin(a,str(x["user_id"]))}), "schema": _object({"user_id":S}, ["user_id"])},
    {"name": "wemail_support_status", "description": "Show the current identity's trusted support role and authorized module scope plus non-sensitive runtime counts. Use to verify administrator access; never infer role from a name.", "handler": _call(lambda r,a,x: {"status":r.status(a)}), "schema": _object({}), "emoji":"🛡️"},
]
