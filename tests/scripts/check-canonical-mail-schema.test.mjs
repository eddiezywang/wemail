import assert from "node:assert/strict";
import test from "node:test";
import { forbidden, ruleViolations } from "../../scripts/check-canonical-mail-schema.mjs";

const removedSqlTable = forbidden.find((rule) => rule.name === "removed SQL table");

function removedSqlMatches(content) {
  return ruleViolations(removedSqlTable, content).map((match) => match.text);
}

// The rule must keep case-insensitive coverage (SQLite keywords accept any
// casing): the case-sensitive shortcut reverted from ae73c2d let lowercase /
// mixed-case SQL against removed tables slip through the gate.
test("removed SQL table rule hits mixed-case SQL against removed tables", () => {
  assert.deepEqual(removedSqlMatches('db.exec("select * from Accounts")'), ["from Accounts"]);
  assert.deepEqual(removedSqlMatches("select * from Accounts where id = 1"), ["from Accounts"]);
  assert.deepEqual(removedSqlMatches("insert INTO Todos (id) values (1)"), ["INTO Todos"]);
  assert.deepEqual(removedSqlMatches("UPDATE Emails SET seen = 1"), ["UPDATE Emails"]);
  assert.deepEqual(
    removedSqlMatches("create table if not exists user_tags (id text)"),
    ["table if not exists user_tags"],
  );
});

test("removed SQL table rule keeps uppercase SQL coverage after the prose narrowing", () => {
  assert.deepEqual(removedSqlMatches("SELECT value FROM db_meta WHERE key = 'migration_version'"), []);
  assert.deepEqual(removedSqlMatches("INSERT INTO todos (id) VALUES (1)"), ["INTO todos"]);
  assert.deepEqual(removedSqlMatches("DELETE FROM tag_feedback_rules;"), ["FROM tag_feedback_rules"]);
  assert.deepEqual(removedSqlMatches("ALTER TABLE emails DROP COLUMN legacy"), ["TABLE emails"]);
  assert.deepEqual(removedSqlMatches("email_id TEXT REFERENCES accounts(id)"), ["REFERENCES accounts"]);
});

// The concrete false positive that once pushed the rule to case-sensitive:
// "hypothetical instructions into todos" inside an LLM prompt string
// (server/wemail/intelligence/processors/TodoExtractionProcessor.ts:36).
// English prose continues with plain words, which must not count as SQL.
test("removed SQL table rule ignores English prose after removed-table words", () => {
  const prompt = "Do not turn hypothetical instructions into todos unless the condition is already true; phrases such as 'if your details change', 'if you want to change your selection', or 'if you later withdraw' are reference information.";
  assert.deepEqual(removedSqlMatches(prompt), []);
  assert.deepEqual(removedSqlMatches("merge the hypothetical instructions into todos and then close the task"), []);
  assert.deepEqual(removedSqlMatches("list of accounts and emails collected during onboarding"), []);
  assert.deepEqual(removedSqlMatches("sync accounts, then reconcile invoices"), []);
});

test("removed SQL table rule stays anchored to a removed table name", () => {
  assert.deepEqual(removedSqlMatches("select * from mail_messages where id = 1"), []);
  assert.deepEqual(removedSqlMatches("coalesce((select id from db_meta))"), []);
});

// Round-9 residual: valid SQL suffix shapes the narrowed lookahead used to
// miss — table aliases (AS / bare), subquery close-parens, and comma lists.
test("removed SQL table rule catches aliased, parenthesized, and comma-list SQL", () => {
  assert.deepEqual(removedSqlMatches('db.prepare("SELECT a.id FROM accounts AS a WHERE a.id = ?")'), [
    "FROM accounts",
  ]);
  assert.deepEqual(removedSqlMatches("SELECT * FROM accounts a WHERE x = 1"), ["FROM accounts"]);
  assert.deepEqual(removedSqlMatches("SELECT (SELECT count(*) FROM accounts) AS n"), ["FROM accounts"]);
  assert.deepEqual(removedSqlMatches("SELECT * FROM accounts, emails WHERE 1"), [
    "FROM accounts",
    // Comma-list continuation tables carry no FROM keyword, so they sit
    // outside this rule's reach; `emails` has its own unconditional rule and
    // every other removed table is covered by the bare-word "removed mail
    // table" rule.
  ]);
  assert.deepEqual(removedSqlMatches("select u.name from user_tags as u join emails on 1"), [
    "from user_tags",
    "join emails",
  ]);
});

// Bare-alias discrimination must not leak back into prose: an identifier
// after the table word counts only when followed by SQL syntax, not when
// followed by more prose words.
test("removed SQL table rule prose guard survives the bare-alias branch", () => {
  assert.deepEqual(removedSqlMatches("turn instructions into todos whenever the run finishes"), []);
  assert.deepEqual(removedSqlMatches("these accounts hold balances"), []);
});
