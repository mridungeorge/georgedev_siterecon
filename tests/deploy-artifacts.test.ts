import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The deployment files cannot be run in CI, so these tests pin the specific mistakes a review found in
// them. They read the text, which is crude but catches the regressions that mattered: rules in the
// wrong order, a deploy that skips the eval gate, a container that gets every API key.

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf-8").replace(/\r\n/g, "\n");

describe("deploy/vm/egress-rules.sh", () => {
  const script = read("deploy/vm/egress-rules.sh");
  const lines = script.split("\n");
  const indexOf = (needle: string) => lines.findIndex((l) => l.includes(needle));

  it("puts the ESTABLISHED,RELATED accept above the DROP, so replies to host-started connections are not dropped", () => {
    // iptables -I puts a rule at the top, so the accept must be inserted AFTER the drop to end up above it.
    const drop = indexOf("add INPUT -s \"$SUBNET\" -j DROP");
    const accept = indexOf("ensure_top INPUT -s \"$SUBNET\" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT");
    expect(drop).toBeGreaterThan(-1);
    expect(accept).toBeGreaterThan(drop);
  });

  it("repairs the order on a machine where the rules were already added the wrong way round", () => {
    expect(script).toMatch(/ensure_top\(\)\s*\{[^}]*-D[^}]*-I/);
  });

  it("refuses to finish without persistence, so a reboot cannot leave the browser container with no firewall", () => {
    expect(script).toMatch(/netfilter-persistent[\s\S]*exit 1/);
    expect(script).not.toMatch(/NOTE: install iptables-persistent/);
  });

  it("blocks the cloud metadata range and the private ranges", () => {
    for (const range of ["169.254.0.0/16", "10.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12", "100.64.0.0/10"]) expect(script).toContain(range);
  });
});

describe("deploy/vm/run-fetch.sh", () => {
  const script = read("deploy/vm/run-fetch.sh");

  it("gives the container public DNS servers, because the VM's own resolver is the blocked metadata server", () => {
    expect(script).toMatch(/--dns 1\.1\.1\.1/);
    expect(script).toMatch(/--dns 8\.8\.8\.8/);
  });

  it("does not restart on its own after a reboot, when the firewall rules may not be loaded yet", () => {
    expect(script).toContain("--restart no");
    expect(script).not.toContain("unless-stopped");
  });

  it("refuses to start unless the egress rules are in place", () => {
    expect(script).toMatch(/iptables -C DOCKER-USER[^\n]*169\.254\.0\.0\/16/);
    expect(script).toMatch(/exit 1/);
  });

  it("passes the container only its own small env file, never the web app's provider keys", () => {
    expect(script).toContain("fetch.env");
    expect(script).not.toMatch(/--env-file[^\n]*siterecon\.env/);
  });
});

describe("deploy/vm/setup.sh", () => {
  const script = read("deploy/vm/setup.sh");
  it("writes a separate fetch.env that holds the secret and no API keys", () => {
    const block = script.slice(script.indexOf("fetch.env"));
    expect(block).toContain("FETCH_SERVICE_SECRET");
    expect(script).toMatch(/cat > \/etc\/siterecon\/fetch\.env/);
    const fetchEnv = script.slice(script.indexOf("cat > /etc/siterecon/fetch.env"), script.indexOf("EOF", script.indexOf("cat > /etc/siterecon/fetch.env") + 40));
    expect(fetchEnv).not.toMatch(/NIM|GEMINI|PAGESPEED|TAVILY|MLFLOW/);
  });
});

describe("deploy/vm/verify-egress.sh", () => {
  const script = read("deploy/vm/verify-egress.sh");
  it("judges by curl's exit code, so an unrelated failure is not read as 'blocked'", () => {
    expect(script).toContain("%{exitcode}");
  });
  it("checks the curl image works before trusting any result", () => {
    expect(script).toMatch(/curl --version|--version/);
  });
  it("probes the machine's own address and a port that really listens, where a missing rule would show", () => {
    expect(script).toMatch(/hostname -I/);
    expect(script).toContain("127.0.0.1:8787");
  });
});

describe("GitHub workflows", () => {
  const deploy = read(".github/workflows/deploy.yml");
  const ci = read(".github/workflows/ci.yml");

  it("deploys only commits pushed to master, never a pull request from a branch with the same name", () => {
    expect(deploy).toContain("github.event.workflow_run.event == 'push'");
  });

  it("deploys only when the accuracy and adversarial gates passed, because CI runs them", () => {
    expect(ci).toContain("npm run eval");
    expect(ci).toContain("npm run eval:adversarial");
    expect(deploy).toMatch(/workflows: \["CI"\]/);
  });

  it("does not paste the VM's output into a single-quoted shell string", () => {
    expect(deploy).not.toMatch(/echo '\$\{\{/);
  });

  it("waits for the app to come back rather than a fixed sleep", () => {
    expect(deploy).not.toMatch(/sleep 5 &&/);
    expect(deploy).toMatch(/for i in/);
  });

  it("has no separate eval workflow that deploy would ignore", () => {
    expect(existsSync(join(root, ".github/workflows/eval-gate.yml"))).toBe(false);
  });
});
