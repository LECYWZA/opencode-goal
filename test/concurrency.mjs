import { Store, Arbiter } from "../dist/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goalrun-conc-"));
const file = path.join(dir, "state.json");

function state(sessionID, worktree) {
  return {
    sessionID, worktree, directory: worktree, mode: "goal", objective: "t",
    startedAt: Date.now(), completed: false, paused: false, turns: 0,
    lastActivityAt: Date.now(), noProgressTurns: 0, progressLog: [],
  };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

// 1) Merge-write across two "instances": distinct keys must both survive.
await (async () => {
  const s1 = new Store(file);
  const s2 = new Store(file);
  s1.set("A", state("s1", "/w"));
  s2.set("B", state("s2", "/w2"));
  await s1.flush();
  await s2.flush();
  const read = new Store(file);
  const snap = read.snapshot();
  check("merge-write keeps A", !!snap["A"]);
  check("merge-write keeps B", !!snap["B"]);
  // remove of one key must not drop the other (deleted only own key)
  s1.remove("A");
  await s1.flush();
  const snap2 = new Store(file).snapshot();
  check("remove drops A only", !snap2["A"]);
  check("remove keeps B", !!snap2["B"]);
})();

// 2) Arbiter cross-instance mutual exclusion on same worktree.
await (async () => {
  const arb1 = new Arbiter(dir);
  const arb2 = new Arbiter(dir);
  const rt1 = { state: { worktree: "/shared", sessionID: "s1" } };
  const rt2 = { state: { worktree: "/shared", sessionID: "s2" } };

  check("arb1 can acquire", arb1.canRun(rt1) === true);
  check("arb2 blocked while arb1 holds", arb2.canRun(rt2) === false);
  arb1.releaseAll(rt1);
  check("arb2 acquires after arb1 releases", arb2.canRun(rt2) === true);

  // different worktree is never blocked by another
  const arb3 = new Arbiter(dir);
  const rt3 = { state: { worktree: "/other", sessionID: "s3" } };
  check("different worktree runs while /shared held", arb3.canRun(rt3) === true);

  // local in-flight serialization: same instance second session blocked while first in flight
  const arb4 = new Arbiter(dir);
  const rta = { state: { worktree: "/serial", sessionID: "sa" } };
  const rtb = { state: { worktree: "/serial", sessionID: "sb" } };
  check("arb4/rta acquires", arb4.canRun(rta, "serial") === true);
  check("arb4/rtb blocked (local in-flight)", arb4.canRun(rtb, "serial") === false);
  arb4.releaseLocal(rta);
  check("arb4/rtb runs after local release", arb4.canRun(rtb, "serial") === true);

  // parallel policy bypasses coordination entirely
  const arbP = new Arbiter(dir);
  const rp1 = { state: { worktree: "/parallel", sessionID: "p1" } };
  const rp2 = { state: { worktree: "/parallel", sessionID: "p2" } };
  arbP.canRun(rp1, "serial"); // p1 takes the serial sit
  check("parallel NOT blocked even while another serial run holds sit", arbP.canRun(rp2, "parallel") === true);
  const rp3 = { state: { worktree: "/parallel2", sessionID: "p3" } };
  check("parallel independent session also free", arbP.canRun(rp3, "parallel") === true);
})();

// cleanup heartbeat intervals so process can exit (Arbiter may hold timers)
console.log(`\nRESULT  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
