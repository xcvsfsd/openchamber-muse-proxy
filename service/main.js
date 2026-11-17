import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/service/main.ts
import http from "node:http";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var BASE = process.env.MUSE_PROXY_BASE ?? "http://127.0.0.1:8788";
var POLL_MS = 15000;
var STATE_FILE = join(homedir(), ".config", "openchamber-muse-proxy", "state.json");
var health = null;
var history = { switches: [], errors: [] };
var lastNow = "";
var lastErrTime = "";
async function loadState() {
  try {
    await mkdir(join(homedir(), ".config", "openchamber-muse-proxy"), { recursive: true });
    const raw = await readFile(STATE_FILE, "utf8");
    const j = JSON.parse(raw);
    if (Array.isArray(j.switches))
      history.switches = j.switches.slice(-20);
    if (Array.isArray(j.errors))
      history.errors = j.errors.slice(-20);
  } catch {}
}
async function saveState() {
  try {
    await writeFile(STATE_FILE, JSON.stringify(history));
  } catch {}
}
function stamp() {
  const d = new Date;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
async function poll() {
  try {
    const r = await fetch(`${BASE}/__health`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    const now = j.autoswitch?.now ?? "";
    if (lastNow && now && now !== lastNow) {
      history.switches.unshift(`${stamp()} ${lastNow} → ${now}`);
      history.switches = history.switches.slice(0, 20);
      saveState();
    }
    if (now)
      lastNow = now;
    const et = j.last_error?.time ?? "";
    if (et && et !== lastErrTime) {
      lastErrTime = et;
      history.errors.unshift(`${et} ${j.last_error?.error ?? ""}`.slice(0, 200));
      history.errors = history.errors.slice(0, 20);
      saveState();
    }
    health = { ...j, at: stamp(), reachable: true };
  } catch {
    health = { ok: false, at: stamp(), reachable: false };
  }
}
async function callProxy(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000)
  });
  let j = null;
  try {
    j = await r.json();
  } catch {
    j = { error: `http-${r.status}` };
  }
  return { status: r.status, json: j };
}
function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, out: String(stdout ?? stderr ?? "").trim() });
    });
  });
}
async function processState() {
  let listening = false;
  try {
    const r = await fetch(`${BASE}/__health`, { signal: AbortSignal.timeout(3000) });
    listening = r.ok;
  } catch {
    listening = false;
  }
  const sys = await run("systemctl", ["--user", "is-active", "muse-proxy.service"]);
  const unit = (await run("systemctl", ["--user", "cat", "muse-proxy.service"])).code === 0;
  return { listening, systemd: sys.out || "unknown", unit };
}
async function statusRows() {
  if (!health?.reachable || !health?.ok) {
    return { rows: [
      { kind: "line", id: "svc", label: "分流代理", value: "不可达", dot: "error" },
      { kind: "note", id: "hint", text: "127.0.0.1:8788 无响应，检查 muse-proxy.service", tone: "warning" }
    ] };
  }
  const now = health.autoswitch?.now ?? "未知";
  const blocked = !!health.autoswitch?.now_blocked;
  const probe = health.preflight;
  const rows = [
    {
      kind: "line",
      id: "node",
      label: "节点",
      value: shortNode(now),
      dot: blocked ? "error" : "success",
      actions: [
        { kind: "button", id: "switch", label: "换节点", variant: "outline" },
        { kind: "button", id: "probe", label: "探活", variant: "outline" }
      ]
    },
    { kind: "line", id: "probe", label: "探活", value: probeLabel(), dot: probe?.ok === false ? "error" : "success" }
  ];
  const le = health.last_error;
  if (le?.time) {
    rows.push({ kind: "note", id: "err", text: `${le.time} ${le.error}`.slice(0, 160), tone: "error" });
  }
  const ps = await processState();
  rows.push({
    kind: "line",
    id: "svc",
    label: "代理进程",
    value: ps.listening ? `运行中·systemd ${ps.systemd}` : `已停止·systemd ${ps.systemd}`,
    dot: ps.listening ? "success" : "error",
    actions: [{ kind: "button", id: "svc", label: ps.listening ? "重启" : "拉起", variant: "outline" }]
  });
  return { rows };
}
function shortNode(n) {
  return n.replace(/\|.*$/, "").slice(0, 24) || "未知";
}
function probeLabel() {
  const p = health?.preflight;
  if (!p)
    return "未知";
  return p.ok ? `OK·${p.runs}次/${p.failures}败` : `失败·${p.err}`.slice(0, 40);
}
async function ensureProxy() {
  try {
    const r = await fetch(`${BASE}/__health`, { signal: AbortSignal.timeout(3000) });
    if (r.ok)
      return "ok";
  } catch {}
  const unit = await run("systemctl", ["--user", "cat", "muse-proxy.service"]);
  if (unit.code === 0) {
    const s = await run("systemctl", ["--user", "start", "muse-proxy.service"]);
    return s.code === 0 ? "ok" : "systemd 启动失败";
  }
  const bin = join(homedir(), ".local", "bin", "muse-proxy");
  const { spawn } = await import("node:child_process");
  try {
    const child = spawn("python3", [bin], { detached: true, stdio: "ignore" });
    child.unref();
    return "ok";
  } catch (e) {
    return `拉起失败：${e instanceof Error ? e.message : e}`;
  }
}
var server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end();
    return;
  }
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/health") {
    res.writeHead(200).end("{}");
    return;
  }
  if (req.method === "GET" && path === "/status") {
    statusRows().then((rows) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(rows)), () => res.writeHead(500).end("{}"));
    return;
  }
  if (req.method === "GET" && path === "/full") {
    processState().then((ps) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ health, history, process: ps })), () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ health, history })));
    return;
  }
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    (async () => {
      if (req.method === "POST" && path === "/status") {
        let id = "";
        try {
          id = JSON.parse(body || "{}").id ?? "";
        } catch {}
        if (id === "switch") {
          const r = await callProxy("/__switch", {});
          const j = r.json;
          if (r.status >= 200 && r.status < 300) {
            await poll();
            res.writeHead(200).end("{}");
          } else
            res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ message: String(j?.error ?? "换节点失败") }));
          return;
        }
        if (id === "probe") {
          const r = await callProxy("/__probe-now", {});
          const j = r.json;
          if (r.status >= 200 && r.status < 300) {
            await poll();
            res.writeHead(200).end("{}");
          } else
            res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ message: String(j?.error ?? j?.err ?? "探活失败") }));
          return;
        }
        if (id === "svc") {
          const ps = await processState();
          if (ps.listening) {
            const r = await run("systemctl", ["--user", "restart", "muse-proxy.service"]);
            if (r.code === 0) {
              await poll();
              res.writeHead(200).end("{}");
            } else
              res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "重启失败：无 systemd 或 unit 不存在" }));
          } else {
            const msg = await ensureProxy();
            if (msg === "ok") {
              await poll();
              res.writeHead(200).end("{}");
            } else
              res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ message: msg }));
          }
          return;
        }
      }
      res.writeHead(404).end("{}");
    })().catch(() => {
      res.writeHead(500).end("{}");
    });
  });
});
if (!PORT || !TOKEN) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
await loadState();
await poll();
setInterval(() => {
  poll();
}, POLL_MS);
server.listen(PORT, "127.0.0.1");
