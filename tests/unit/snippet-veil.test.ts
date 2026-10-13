import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("PRISM-024 the veil contract matches across snippet, demo, and landing, and the FAQ stops admitting flicker", () => {
  const snippet = readFileSync("public/snippet.js", "utf8");
  const demo = readFileSync("demo/index.html", "utf8");
  const landing = readFileSync("landing/index.html", "utf8");

  for (const src of [snippet, demo, landing]) {
    expect(src).toContain("prism-veil");
    expect(src).toContain("__prismVeilTimedOut");
    expect(src).toContain("__prismVeilUntil");
  }

  expect(snippet).toContain('return n > 0 ? n : 800');
  expect(snippet).toContain("noteUnshown");
  expect(demo).toContain('data-selectors="#hero,#grid,#pdp-strip"');
  expect(demo).toContain('data-timeout="800"');
  expect(demo).toContain("|| 800");
  expect(landing).toContain("|| 800");

  expect(landing).not.toContain("A first-ever pageview can show the default briefly");
  expect(landing).not.toContain("may show your default page for a moment");
  expect(landing).toContain("stay hidden until the variant is in place");
  expect(landing).toContain("if anything fails your visitors see your normal page");
});
