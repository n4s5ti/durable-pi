// read_sqlite, read_archive, read_document, web_search, fetch_url and github, through a live session against local
// fixtures. TOOLKIT_LIVE=1 adds real GitHub (gh's login) and DuckDuckGo calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { githubArgv } from "../src/toolkit-github.js";
import { htmlToMarkdown } from "../src/toolkit-common.js";
import { notebookText, xlsxText, xmlText } from "../src/toolkit-read.js";
import { formatResults, parseDuckDuckGo } from "../src/toolkit-web.js";
import { faux, tempStore } from "./helpers.js";

const has = (bin: string) => {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`]);
    return true;
  } catch {
    return false;
  }
};
const live = process.env.TOOLKIT_LIVE === "1";

test("document XML, sheets, notebooks and HTML turn into readable text", () => {
  assert.equal(xmlText('<w:p><w:r><w:t>Hello</w:t></w:r><w:tab/><w:r><w:t>A &amp; B</w:t></w:r></w:p><w:p><w:t>Two</w:t></w:p>'), "Hello\tA & B\nTwo");
  const sheet = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>x</t></is></c></row>';
  assert.equal(xlsxText("<si><t>name</t></si>", '<sheet name="Data" sheetId="1"/>', [sheet]), "## Data\nname\t\t42\n\tx");
  assert.equal(notebookText(JSON.stringify({ cells: [{ cell_type: "markdown", source: ["# T"] }, { cell_type: "code", source: "x = 1" }] })), "# T\n\n```\nx = 1\n```");
  const md = htmlToMarkdown(
    '<html><head><title>t</title><script>evil()</script></head><body><nav>menu</nav><main><h2>Docs &amp; more</h2><p>See <a href="/x">the <b>guide</b></a>.</p><ul><li>one</li><li>two</li></ul><pre><code>a &lt; b</code></pre></main></body></html>',
  );
  assert.equal(md, "## Docs & more\n\nSee [the guide](/x).\n\n- one\n- two\n\n```\na < b\n```");
});

test("DuckDuckGo results parse and unwrap, and results format with their provider", () => {
  const html =
    '<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example <b>A</b></a><a class="result__snippet">First &amp; best</a></div>' +
    '<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>' +
    '<div class="result"><a class="result__a" href="https://example.org/b">B</a></div>';
  const results = parseDuckDuckGo(html);
  assert.deepEqual(results, [
    { title: "Example A", url: "https://example.com/a", snippet: "First & best" },
    { title: "B", url: "https://example.org/b" },
  ]);
  assert.equal(formatResults("duckduckgo", results), "1. Example A\n   https://example.com/a\n   First & best\n2. B\n   https://example.org/b\n\n(duckduckgo)");
});

test("github ops build the gh command and refuse missing inputs", () => {
  assert.deepEqual(githubArgv({ op: "repo_view" }), ["gh", "repo", "view"]);
  assert.deepEqual(githubArgv({ op: "pr_view", number: 7, repo: "o/r" }), ["gh", "pr", "view", "7", "--repo", "o/r", "--comments"]);
  assert.deepEqual(githubArgv({ op: "file_read", path: "/README.md", ref: "dev" }), [
    "gh", "api", "-H", "Accept: application/vnd.github.raw", "repos/{owner}/{repo}/contents/README.md?ref=dev",
  ]);
  assert.deepEqual(githubArgv({ op: "search_prs", query: "is:open", repo: "o/r", limit: 5 }), ["gh", "search", "prs", "is:open", "--repo", "o/r", "--limit", "5"]);
  assert.deepEqual(githubArgv({ op: "pr_list", state: "merged", query: "fix" }), ["gh", "pr", "list", "--limit", "20", "--state", "merged", "--search", "fix"]);
  assert.deepEqual(githubArgv({ op: "run_view", number: 9, failed_logs: true }), ["gh", "run", "view", "9", "--log-failed"]);
  assert.throws(() => githubArgv({ op: "issue_view" }), /needs number/);
  assert.throws(() => githubArgv({ op: "search_code" }), /needs query/);
  assert.throws(() => githubArgv({ op: "issue_list", state: "merged" }), /open, closed or all/);
});

/** A one-page PDF whose page says "Hello PDF". pdftotext tolerates the approximate xref. */
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 41>>stream
BT /F1 18 Tf 20 40 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

test("file, web and GitHub tools run in a live session", { skip: !has("bsdtar") }, async () => {
  const t = await tempStore();
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/search")) {
      const q = new URL(req.url, "http://x").searchParams.get("q");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [{ title: `About ${q}`, url: "https://example.com/q", content: "local searxng" }] }));
    } else {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<html><head><title>Local page</title></head><body><nav>skip me</nav><article><h1>Hi</h1><p>Body text.</p></article></body></html>");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const searxng = process.env.SEARXNG_URL;
  process.env.SEARXNG_URL = base;

  // Fixtures in the session folder.
  const db = new DatabaseSync(join(t.work, "app.sqlite"));
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES ('ada'), ('lin'), ('bo');");
  db.close();
  const zip = (name: string, files: Record<string, string>) => {
    const dir = join(t.root, `src-${name}`);
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    execFileSync("bsdtar", ["--format", "zip", "-cf", join(t.work, name), "-C", dir, ...Object.keys(files)]);
  };
  zip("bundle.zip", { "docs/readme.txt": "inside the zip\n", "a.txt": "a\n" });
  zip("memo.docx", { "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Memo body</w:t></w:r></w:p></w:body></w:document>" });
  zip("deck.pptx", {
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>",
  });
  zip("book.xlsx", {
    "xl/workbook.xml": '<workbook><sheets><sheet name="Q1" sheetId="1"/></sheets></workbook>',
    "xl/sharedStrings.xml": "<sst><si><t>total</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12</v></c></row></sheetData></worksheet>',
  });
  writeFileSync(join(t.work, "hello.pdf"), PDF);

  const store = await t.open();
  try {
    const s = await store.create({ name: "FilesWeb", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(s.id, "main");
    let n = 0;
    const call = async (name: string, args: unknown) => {
      const sub = await store.send(c, { content: `tool: ${name} ${JSON.stringify(args)}`, requestId: `fw-${n++}` });
      assert.equal((await store.settled(h, sub.id as number, 30000)).status, "done");
      const md = (await store.transcript(c, "markdown")).text ?? "";
      return md.slice(md.lastIndexOf("Tool finished:"));
    };

    assert.match(await call("read_sqlite", { path: "app.sqlite" }), /table users \(3 rows\)/);
    assert.match(await call("read_sqlite", { path: "app.sqlite", table: "users", limit: 2 }), /rows 1-2 of 3; next page: offset 2\n\nid\tname\n1\tada\n2\tlin/);
    assert.match(await call("read_sqlite", { path: "app.sqlite", sql: "SELECT count(*) AS n FROM users" }), /n\n3/);
    assert.match(await call("read_sqlite", { path: "app.sqlite", sql: "DELETE FROM users" }), /readonly|read-only|attempt to write/i);
    assert.match(await call("read_archive", { path: "bundle.zip" }), /docs\/readme\.txt/);
    assert.match(await call("read_archive", { path: "bundle.zip", member: "docs/readme.txt" }), /inside the zip/);
    assert.match(await call("read_document", { path: "memo.docx" }), /Memo body/);
    assert.match(await call("read_document", { path: "deck.pptx" }), /## Slide 1\nFirst\n\n## Slide 2\nSecond/);
    assert.match(await call("read_document", { path: "book.xlsx" }), /## Q1\ntotal\t12/);
    if (has("pdftotext")) assert.match(await call("read_document", { path: "hello.pdf" }), /Hello PDF/);
    assert.match(await call("fetch_url", { url: `${base}/page` }), /# Local page\n\n# Hi\n\nBody text\./);
    assert.match(await call("web_search", { query: "durable", provider: "searxng" }), /1\. About durable\n {3}https:\/\/example\.com\/q\n {3}local searxng/);
    if (live && has("gh")) {
      assert.match(await call("github", { op: "file_read", repo: "n4s5ti/durable-pi", path: "README.md" }), /Durable Pi/);
      assert.match(await call("github", { op: "search_prs", repo: "n4s5ti/durable-pi", query: "omarchy", limit: 3 }), /omarchy-plugin/);
    }
    if (live) assert.match(await call("web_search", { query: "ripgrep github", provider: "duckduckgo", limit: 3 }), /1\. .*\n {3}https?:\/\//);
  } finally {
    if (searxng === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = searxng;
    server.close();
    await store.close();
    await t.cleanup();
  }
});
