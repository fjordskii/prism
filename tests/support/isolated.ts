import { join } from "node:path";

export type EnvSnap = Record<string, string | undefined>;

export function snapshotEnv(): EnvSnap {
  return { ...process.env };
}

export function restoreEnv(snap: EnvSnap) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snap)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// `bun test` keeps one module graph for the whole process. Specs that must
// import the server under a different env run in a child process so they
// cannot leave that graph, or a cleared OAuth env, behind.
export async function runFileIsolated(file: string) {
  const proc = Bun.spawn([process.execPath, "test", file], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, PRISM_TEST_ISOLATED: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${file} exited ${code}\n${stdout}\n${stderr}`);
  }
}
