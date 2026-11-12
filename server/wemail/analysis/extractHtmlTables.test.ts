import assert from "node:assert/strict";
import { test } from "node:test";
import { extractHtmlTables, htmlTableDataset } from "./extractHtmlTables.js";

test("extractHtmlTables: parses well-formed HTML table", () => {
  const html = `<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>`;
  const tables = extractHtmlTables(html);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns, ["A", "B"]);
  assert.equal(tables[0].rows.length, 2);
  assert.equal(tables[0].rows[0].A, "1");
  assert.equal(tables[0].rows[1].B, "4");
});

test("extractHtmlTables: tolerant of <td>…</th> mismatches (enterprise email)", () => {
  const html = `<table><tr><th>model</th><th>cnt</th></tr><tr><td>qwen3-30b</th><td>3019</th></tr></table>`;
  const tables = extractHtmlTables(html);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rows[0].model, "qwen3-30b");
  assert.equal(tables[0].rows[0].cnt, "3019");
});

test("extractHtmlTables: handles multiple tables", () => {
  const html = `<table><tr><th>X</th></tr><tr><td>1</td></tr></table><table><tr><th>Y</th></tr><tr><td>2</td></tr></table>`;
  const tables = extractHtmlTables(html);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].columns[0], "X");
  assert.equal(tables[1].columns[0], "Y");
});

test("htmlTableDataset keeps heterogeneous tables out of the analytical row set", () => {
  const dataset = htmlTableDataset([{
    id: "mail-1",
    receivedAt: "2026-08-03T08:00:00.000Z",
    body_html: [
      "<table><tr><th>model</th><th>cnt</th></tr><tr><td>a</td><td>3</td></tr></table>",
      "<table><tr><th>model</th><th>latency</th></tr><tr><td>a</td><td>10</td></tr></table>",
    ].join(""),
  }]);

  assert.deepEqual(dataset.schema.fields.map((field) => field.name), ["model", "cnt"]);
  assert.deepEqual(dataset.rows, [{ model: "a", cnt: 3 }]);
  assert.equal(dataset.rawTables?.length, 2);
});

test("htmlTableDataset still merges matching table shapes across source emails", () => {
  const table = (model: string, count: number) =>
    `<table><tr><th>model</th><th>cnt</th></tr><tr><td>${model}</td><td>${count}</td></tr></table>`;
  const dataset = htmlTableDataset([
    { id: "mail-1", receivedAt: "2026-08-02T08:00:00.000Z", body_html: table("a", 3) },
    { id: "mail-2", receivedAt: "2026-08-03T08:00:00.000Z", body_html: table("b", 5) },
  ]);

  assert.equal(dataset.rows.length, 2);
  assert.deepEqual(dataset.rows.map((row) => row._source_date), ["2026-08-02", "2026-08-03"]);
});

test("htmlTableDataset parses common business number formats for downstream analysis", () => {
  const dataset = htmlTableDataset([{
    id: "mail-number-formats",
    receivedAt: "2026-08-03T08:00:00.000Z",
    body_html: [
      "<table><tr><th>成功率</th><th>金额</th><th>调用量</th><th>响应时长</th></tr>",
      "<tr><td>92.5%</td><td>¥12,400</td><td>3.5万</td><td>42 ms</td></tr></table>",
    ].join(""),
  }]);

  assert.deepEqual(dataset.rows, [{ 成功率: 0.925, 金额: 12400, 调用量: 35000, 响应时长: 42 }]);
  assert.ok(dataset.schema.fields.every((field) => field.type === "number"));
});

test("htmlTableDataset normalizes overlapping time-window columns into a long dataset", () => {
  const dataset = htmlTableDataset([{
    id: "mail-window",
    receivedAt: "2026-08-04T08:00:00.000Z",
    body_html: [
      "<table><tr><th>类型</th><th>最近一小时</th><th>当天</th></tr>",
      "<tr><td>实时</td><td>100</td><td>1200</td></tr>",
      "<tr><td>离线</td><td>20</td><td>300</td></tr></table>",
    ].join(""),
  }]);

  assert.deepEqual(dataset.schema.fields.map((field) => field.name), ["类型", "_time_window", "_value"]);
  assert.deepEqual(dataset.rows, [
    { 类型: "实时", _time_window: "最近一小时", _value: 100 },
    { 类型: "实时", _time_window: "当天", _value: 1200 },
    { 类型: "离线", _time_window: "最近一小时", _value: 20 },
    { 类型: "离线", _time_window: "当天", _value: 300 },
  ]);
  assert.equal(dataset.schema.fields[0]?.semanticId, "execution_type");
  assert.equal(dataset.schema.fields[1]?.semanticRole, "time_window");
  assert.equal(dataset.rawTables?.[0]?.rows.length, 2, "raw source table remains lossless");
});

test("htmlTableDataset recognizes and canonicalizes an existing time-window dimension", () => {
  const dataset = htmlTableDataset([{
    id: "mail-long-window",
    receivedAt: "2026-08-04T08:00:00.000Z",
    body_html: [
      "<table><tr><th>task_name</th><th>运行类型</th><th>统计范围</th><th>cnt</th></tr>",
      "<tr><td>A</td><td>实时</td><td>近1小时</td><td>100</td></tr>",
      "<tr><td>A</td><td>实时</td><td>当日</td><td>1200</td></tr>",
      "<tr><td>A</td><td>离线</td><td>近1小时</td><td>20</td></tr>",
      "<tr><td>A</td><td>离线</td><td>当日</td><td>300</td></tr></table>",
    ].join(""),
  }]);

  const windowField = dataset.schema.fields.find((field) => field.name === "统计范围");
  assert.equal(windowField?.semanticRole, "time_window");
  assert.deepEqual([...new Set(dataset.rows.map((row) => row.统计范围))], ["最近一小时", "当天"]);
  assert.equal(dataset.schema.fields.find((field) => field.name === "运行类型")?.semanticId, "execution_type");
});
