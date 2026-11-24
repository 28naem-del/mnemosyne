import { test } from "vitest";
import { strict as assert } from "node:assert";
import { BM25Index } from "../src/core/bm25.js";
import { extractEntities } from "../src/pipeline/extractor.js";
import { detectAgentMention } from "../src/cognitive/toma.js";
import { rewriteForEmbedding } from "../src/cognitive/intent.js";
import { detectLessons, detectStandaloneLessons } from "../src/cognitive/lesson-extractor.js";

test("legacy token edge trimming preserves punctuation and empty-token behavior", () => {
  const index = new BM25Index();
  assert.deepEqual(index.tokenize("--alpha:: 1.2.3 http://host --- ..."), ["alpha", "1.2.3", "http://host", "", ""]);
  assert.deepEqual(index.tokenize("word" + "-".repeat(100_000) + "/"), ["word" + "-".repeat(100_000) + "/"]);
});

test("entity extraction preserves supported email and port spellings", () => {
  const entities = extractEntities("port 8080; port: 8443; PORT = 1234; first.last@example.test; a..b@x..y.z-");
  for (const entity of ["port:8080", "port:8443", "port:1234", "first.last@example.test", "a..b@x..y.z"]) assert.ok(entities.includes(entity), entity);
  assert.deepEqual(extractEntities("-".repeat(100_000)), []);
  assert.deepEqual(extractEntities("port" + " ".repeat(100_000) + "!"), []);
});

test("agent possessives and nonmatches do not retry every word suffix", () => {
  assert.equal(detectAgentMention("Alice's knowledge", { alice: "agent-1" }), "agent-1");
  assert.equal(detectAgentMention("000's memories"), "000");
  assert.equal(detectAgentMention("0".repeat(100_000)), null);
});

test("embedding rewrites preserve internal question marks and operation ordering", () => {
  assert.equal(rewriteForEmbedding("Why did the server crash???", "diagnostic"), "server failure error");
  assert.equal(rewriteForEmbedding("why a?b???", "diagnostic"), "why a?b");
  assert.equal(rewriteForEmbedding("foo?is?", "factual"), "foo");
  assert.equal(rewriteForEmbedding("How to deploy???", "procedural"), "deploy steps guide");
  assert.equal(rewriteForEmbedding("When did we deploy???", "temporal"), "deploy timeline recent");
  const input = "why " + "?".repeat(100_000) + "!";
  assert.equal(rewriteForEmbedding(input, "diagnostic"), null);
});

test("contrast corrections retain normal, comma, multiline and whitespace captures", () => {
  for (const text of ["not blue, but green", "not blue it's green", "not blue rather green", "not blue it is green", "not  but green", "not\\nblue but green", "not blue \rbut green"]) {
    const input = text.replace("\\n", "\n");
    for (const result of [detectLessons("old", input), detectStandaloneLessons(input)]) {
      assert.ok(result.lessons.some(lesson => lesson.type === "correction" && lesson.correction === "green"), text);
    }
  }
});

test("contrast correction rejects adversarial absent separators", () => {
  for (const input of ["not " + " ".repeat(100_000), "not a" + " ".repeat(100_000), "not x ".repeat(20_000)]) {
    assert.ok(!detectLessons("old", input).lessons.some(lesson => lesson.type === "correction"));
  }
});


test("failure lessons preserve the assumption and optional reason", () => {
  const result = detectStandaloneLessons("blue config does not work because wrong port");
  assert.ok(result.lessons.some(lesson => lesson.type === "anti_pattern" && lesson.wrongAssumption === "blue config" && lesson.correction === "wrong port"));
});


test("contrast matching preserves greedy prefix whitespace before a later separator", () => {
  const result = detectStandaloneLessons("not  but never but but because ");
  assert.ok(result.lessons.some(lesson => lesson.type === "correction" && lesson.correction === "but because"));
  const acrossLine = detectStandaloneLessons("won't work not does not work\nit is blue");
  assert.ok(acrossLine.lessons.some(lesson => lesson.type === "correction" && lesson.correction === "blue"));
});
