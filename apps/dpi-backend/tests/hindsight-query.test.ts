import { test } from "node:test";
import assert from "node:assert/strict";
import { recallQuery, RECALL_QUERY_CHARS } from "../src/hindsight.js";

test("hindsight recall query collapses whitespace and stays under Hindsight's 500-token limit", () => {
  assert.equal(recallQuery("  a \n\n  b\t c  "), "a b c");
  const long = recallQuery("word ".repeat(5000));
  assert.equal(long.length, RECALL_QUERY_CHARS);
});
