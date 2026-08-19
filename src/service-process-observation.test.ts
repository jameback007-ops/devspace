import assert from "node:assert/strict";
import test from "node:test";
import { observeCurrentServiceChildProcesses } from "./service-process-observation.js";

test("service process observation counts only sibling children in the current cgroup", () => {
  const observation = observeCurrentServiceChildProcesses({
    pid: 42,
    cgroupRoot: "/sys/fs/cgroup",
    readText: (path) => {
      if (path === "/proc/self/cgroup") {
        return "0::/system.slice/devspace-zesnexus.service\n";
      }
      if (
        path
        === "/sys/fs/cgroup/system.slice/devspace-zesnexus.service/cgroup.procs"
      ) {
        return "42\n43\n44\n44\n";
      }
      throw new Error(`Unexpected test path: ${path}`);
    },
  });
  assert.equal(observation.state, "observed");
  assert.equal(observation.childProcessCount, 2);
  assert.match(
    String(observation.cgroupIdentityDigestSha256),
    /^[a-f0-9]{64}$/,
  );
  assert.equal("cgroupPath" in observation, false);
});

test("service process observation fails closed without raw errors", () => {
  const observation = observeCurrentServiceChildProcesses({
    pid: 42,
    readText: () => {
      throw new Error("private host path detail");
    },
  });
  assert.equal(observation.state, "unavailable");
  assert.equal(observation.childProcessCount, 0);
  assert.match(String(observation.errorDigestSha256), /^[a-f0-9]{64}$/);
  assert.equal("error" in observation, false);
});
