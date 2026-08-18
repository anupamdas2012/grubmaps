#!/usr/bin/env bun
import { spawn } from "bun";

const procs = [
  { name: "api", color: "\x1b[36m", cwd: "server" },
  { name: "web", color: "\x1b[35m", cwd: "web" },
];
const RESET = "\x1b[0m";

const children = procs.map(({ name, color, cwd }) => {
  const child = spawn({
    cmd: ["bun", "--bun", "run", "dev"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  const pipe = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        console.log(`${color}[${name}]${RESET} ${line}`);
      }
    }
    if (buf) console.log(`${color}[${name}]${RESET} ${buf}`);
  };

  pipe(child.stdout);
  pipe(child.stderr);
  return child;
});

const shutdown = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(children.map((c) => c.exited));
