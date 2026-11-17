import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const roots = ["app", "electron", "server", "shared", "scripts", "docs"];
const productionRoots = new Set(["app", "electron", "server", "shared", "scripts"]);
const ignoredDirectories = new Set(["node_modules", "build", "dist", "dist-electron", "workspace", ".git"]);
const checkedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".json", ".sql"]);
export const forbidden = [
  { name: "legacy mail table", pattern: /\b(?:mail_sync_cursors|intelligence_results|scheduled_drafts)\b/giu },
  { name: "removed mail table", productionOnly: true, pattern: /\b(?:ai_feedback_events|digest_settings|draft_versions|email_smart_tags|intelligence_jobs|learning_summaries|mail_flag_sync_state|mail_semantic_attributes|mail_sync_checkpoints|mail_sync_state|mail_system_classifications|mcp_settings_v2|schema_migrations|semantic_index|smart_tag_actions|smart_tag_backfill_runs|smart_tag_learning_run_samples|smart_tag_learning_runs|smart_tag_prompt_revisions|smart_tag_retag_items|smart_topic_candidates|smart_topic_evidence|system_classification_overrides|tag_feedback_rules|todo_suppressions|todos_v2|translation_cache|user_tags)\b/giu },
  // Stays case-insensitive on purpose: SQLite keywords accept any casing, so
  // `select * from Accounts` must remain a violation (the case-sensitive
  // shortcut was a gate relaxation, reverted here). The English-prose false
  // positive ("hypothetical instructions into todos ..." inside an LLM
  // prompt string) is narrowed away structurally instead: a hit additionally
  // requires the table reference to be followed by SQL syntax — a clause
  // keyword (WHERE / SET / VALUES / ...), a statement delimiter `(` `)` `;`
  // `]` or a comma, a quote / identifier quote / template interpolation
  // `${`, the AS-alias form, a bare table alias whose next token is SQL
  // syntax (`FROM accounts a WHERE ...`), or the end of the scanned
  // content. English prose continues with plain words ("todos unless the
  // condition ..."), whose next token is another plain word, failing every
  // branch of the lookahead.
  { name: "removed SQL table", productionOnly: true, pattern: /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`\[]?(?:accounts|ai_feedback_events|digest_settings|draft_versions|email_smart_tags|emails|intelligence_jobs|intelligence_results|learning_summaries|mail_flag_sync_state|mail_semantic_attributes|mail_sync_checkpoints|mail_sync_cursors|mail_sync_state|mail_system_classifications|mcp_settings_v2|scheduled_drafts|schema_migrations|semantic_index|smart_tag_actions|smart_tag_backfill_runs|smart_tag_learning_run_samples|smart_tag_learning_runs|smart_tag_prompt_revisions|smart_tag_retag_items|smart_topic_candidates|smart_topic_evidence|system_classification_overrides|tag_feedback_rules|todo_suppressions|todos|todos_v2|translation_cache|user_tags)\b(?=\s*(?:["'`();,\]]|\$\{)|\s*\b(?:AS|WHERE|SET|VALUES|ORDER|GROUP|LIMIT|USING|RETURNING|SELECT|CONFLICT|JOIN|UNION|INTERSECT|EXCEPT|DROP|ON)\b|\s+(?:AS\s+)?[A-Za-z_]\w*(?=\s*(?:\b(?:WHERE|SET|GROUP|ORDER|LIMIT|USING|RETURNING|SELECT|JOIN|ON|CONFLICT|UNION|INTERSECT|EXCEPT|DROP)\b|["'`();,\]]|\$\{))|\s*$)/giu },
  { name: "legacy emails SQL table", pattern: /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+(?:emails\b|\[emails\]|"emails"|`emails`)/giu },
  { name: "legacy mail repository", pattern: /\b(?:MailRepository|MailSyncService|MailSendService)\b/gu },
  { name: "legacy database entry point", productionOnly: true, pattern: /\b(?:WemailDb|openWemailDatabase|openWemailReadDatabase|openWemailWorkerDatabase|resolveDatabasePath)\b/gu },
  { name: "legacy database module", productionOnly: true, pattern: /(?:^|[\\/])db[\\/]Database(?:\.js|\.ts)?\b/gu },
  { name: "removed database selector", productionOnly: true, pattern: /\b(?:WEMAIL_DATABASE_candidate_PATH|Databasecandidate|MailDatabasecandidate|historicalPlatformSchema|schemaKind)\b/gu },
];

/** All rule matches in one file's content, with their offsets (flags applied). */
export function ruleViolations(rule, content) {
  const matches = [];
  rule.pattern.lastIndex = 0;
  let match;
  while ((match = rule.pattern.exec(content))) {
    matches.push({ text: match[0], index: match.index });
    if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
  }
  return matches;
}

const files = [];
function visit(path) {
  for (const name of readdirSync(path)) {
    if (ignoredDirectories.has(name)) continue;
    const item = join(path, name);
    if (statSync(item).isDirectory()) visit(item);
    else if (checkedExtensions.has(extname(name))) files.push(item);
  }
}

// CLI entry only when executed directly; importing the module (tests) must
// not scan the repo or exit the process.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  for (const directory of roots) visit(join(root, directory));

  const failures = [];
  for (const file of files) {
    if (file.endsWith("check-canonical-mail-schema.mjs")) continue;
    const relativePath = relative(root, file);
    if (/^server[\\/]wemail[\\/]db[\\/]/u.test(relativePath)) {
      failures.push(`${relativePath}:1: removed legacy database directory`);
    }
    const topLevelDirectory = relativePath.split(/[\\/]/u)[0];
    const content = readFileSync(file, "utf8");
    for (const rule of forbidden) {
      if (rule.productionOnly && !productionRoots.has(topLevelDirectory)) continue;
      for (const matched of ruleViolations(rule, content)) {
        const line = content.slice(0, matched.index).split(/\r?\n/u).length;
        failures.push(`${relativePath}:${line}: ${rule.name}: ${matched.text}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("Canonical mail schema gate failed:\n" + failures.join("\n"));
    process.exit(1);
  }
  console.log(`Canonical mail schema gate passed (${files.length} files scanned).`);
}
