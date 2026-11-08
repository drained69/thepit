import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("auto mode fetches a fresh challenge after an incorrect guess", async () => {
  const child = spawn(process.execPath, ["--import", "./test/mock-gate.mjs", "get-pass.mjs", "alice.testnet", "0", "http://mock"], {
    cwd: new URL("..", import.meta.url), env: { ...process.env, PIT_AUTO_ANSWER: "1" }, stdio: "ignore",
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0);
});
