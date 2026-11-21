#!/usr/bin/env python3
"""muse-proxy: 给 OpenCode 用的本地分流反向代理。
源码唯一真相：openchamber-muse-proxy 仓 vendor/muse-proxy.py。
部署：scripts/install.sh 拷到 ~/.local/bin/muse-proxy 并注册 systemd user 服务。

按请求体里的 model 字段决定上游链路：
  * model 以 muse 开头 → 经 HTTP 代理（默认 192.168.34.201:7897）访问 opencode.ai
  * 其他模型           → 直连 opencode.ai，完全不受代理节点影响

只监听 127.0.0.1，SSE 流式原样透传。纯标准库，无第三方依赖。

muse 链路额外做三件事：
  1. 发请求前快速探节点活性（3s），死了立刻报错，不让对话干等
  2. 探活失败 / 403 地区限制 → 通过 mihomo 控制口自动换节点重试一次
  3. 任何失败都返回 JSON 错误，OpenCode 会把原因显示在对话里

用法: muse-proxy [--port 8788] [--upstream opencode.ai] [--proxy host:port]
健康检查: curl http://127.0.0.1:8788/__health
"""
import argparse
import concurrent.futures
import http.client
import http.server
import json
import os
import socket
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import deque

DEFAULT_PORT = 8788
DEFAULT_UPSTREAM = "opencode.ai"
DEFAULT_PROXY = "192.168.34.201:7897"
MUSE_PREFIX = "muse"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


def _env_flag(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() not in ("0", "false", "no", "off")


# 超时分层：建连要快失败，首字节要等得住模型思考，流式空闲别太短
CONNECT_TIMEOUT = _env_int("MUSE_PROXY_CONNECT_TIMEOUT", 8)      # 上游建连(含TLS/隧道)
BODY_READ_TIMEOUT = _env_int("MUSE_PROXY_BODY_TIMEOUT", 60)      # 读客户端请求体
FIRST_BYTE_TIMEOUT = _env_int("MUSE_PROXY_FIRST_TIMEOUT", 60)    # 等上游首字节
STREAM_IDLE_TIMEOUT = _env_int("MUSE_PROXY_IDLE_TIMEOUT", 180)   # 流中途两次数据间隔

# 探活在后台线程做，主流程只读缓存、永不等待探活：
# 后台每 PROBE_INTERVAL 秒做一次 CONNECT+TLS 握手 + 控制口组/节点刷新
PREFLIGHT = _env_flag("MUSE_PROXY_PREFLIGHT", True)
PREFLIGHT_TIMEOUT = _env_int("MUSE_PROXY_PREFLIGHT_TIMEOUT", 3)
PROBE_INTERVAL = _env_int("MUSE_PROXY_PROBE_INTERVAL", 10)

# mihomo 控制口（Clash Verge: 外部控制器监听地址），用来换节点
CTL = os.environ.get("MUSE_PROXY_CTL", "192.168.34.201:9097")
CTL_SECRET_FILE = os.path.expanduser("~/.config/clash-ctl/secret")
AUTOSWITCH = _env_flag("MUSE_PROXY_AUTOSWITCH", True)
# 节点优先级：美国01 > 伦敦01 > 新加坡专线01 > 日本高速01
PREFERRED_NODES = [
    n.strip() for n in os.environ.get(
        "MUSE_PROXY_NODES",
        "🇺🇸美国01|流媒体|0.1x,🇬🇧英国伦敦01|流媒体|0.1x,🇸🇬新加坡专线01|BGP|流媒体,🇯🇵日本高速01|BGP|CUCM",
    ).split(",") if n.strip()
]
# muse 禁用节点：香港/台湾出口对 muse 不通（403 RegionError），一律不选，当前是它也要换走
BLOCK_KEYWORDS = [
    k.strip().lower() for k in os.environ.get(
        "MUSE_PROXY_BLOCK_NODES", "香港,hong kong,hongkong,台湾,taiwan"
    ).split(",") if k.strip()
]

# Clash 刷新（/__clash-refresh 用）：订阅更新 + 节点测速
CLASH_TEST_URL = os.environ.get(
    "MUSE_PROXY_CLASH_TEST_URL", "http://cp.cloudflare.com/generate_204")
CLASH_TEST_TIMEOUT = _env_int("MUSE_PROXY_CLASH_TEST_TIMEOUT", 4)  # 单节点测速秒
CLASH_TOP_N = _env_int("MUSE_PROXY_CLASH_TOP_N", 5)  # 取前 N 个最快
# 测速时跳过的非真实节点（流量显示/套餐显示/功能位）
SKIP_NODES = ("DIRECT", "REJECT", "GLOBAL", "自动选择", "故障转移")

CFG = {"port": DEFAULT_PORT, "upstream": DEFAULT_UPSTREAM, "proxy": DEFAULT_PROXY}

# 最近一次异常，/__health 里能看到，方便事后确认是不是本地这一跳出的问题
LAST = {"time": "", "route": "", "path": "", "error": ""}

# 节点探活结果缓存：只由后台线程写，主流程只读
PROBE = {"ts": 0.0, "ok": True, "err": ""}

# 当前策略组与节点缓存：只由后台线程 / 换节点时写，主流程只读
GROUP = {"ts": 0.0, "group": "", "now": ""}

# 后台探活线程状态
PROBER = {"runs": 0, "failures": 0, "last_run": ""}

_STATE_LOCK = threading.Lock()

# 请求序号：#sid 唯一标识来源，只记内存（重启清零）
REQ_SEQ = 0


# 流量统计：实时网速 + 累计流量（只记内存，重启清零）
# up = 收到请求体（客户端→代理），down = 发出响应体（代理→客户端）
TRAFFIC = {
    "up": 0, "down": 0,
    "up_muse": 0, "down_muse": 0,
    "events": deque(maxlen=1200),  # (ts, up_n, down_n)，算窗口速率用
}
TRAFFIC_WINDOW = 5.0  # 速率窗口秒（滑动窗口内累计字节，用于 5s 内网速）


def traffic_add(up_n: int, down_n: int, muse: bool) -> None:
    now = time.time()
    with _STATE_LOCK:
        TRAFFIC["up"] += up_n
        TRAFFIC["down"] += down_n
        if muse:
            TRAFFIC["up_muse"] += up_n
            TRAFFIC["down_muse"] += down_n
        if up_n or down_n:
            TRAFFIC["events"].append((now, up_n, down_n))


def traffic_snapshot():
    now = time.time()
    with _STATE_LOCK:
        ev = [e for e in TRAFFIC["events"] if now - e[0] <= TRAFFIC_WINDOW]
        up = sum(e[1] for e in ev)
        down = sum(e[2] for e in ev)
        return {
            "up_bytes": TRAFFIC["up"], "down_bytes": TRAFFIC["down"],
            "up_muse": TRAFFIC["up_muse"], "down_muse": TRAFFIC["down_muse"],
            "up_rate": round(up / TRAFFIC_WINDOW, 1),
            "down_rate": round(down / TRAFFIC_WINDOW, 1),
            "up_window": up, "down_window": down,
            "window_s": TRAFFIC_WINDOW,
        }
# stage 流转：收请求 → 建连中 → 等上游首字节 → 流式传输 → 完成/失败
# 实时流程：每条转发请求的阶段追踪（面板判断卡住/失败用，只记内存，重启清零）
REQS_ACTIVE = {}           # sid -> entry（在途）
REQS_RECENT = deque(maxlen=20)  # 已完成（新在前）


def _stamp_full() -> str:
    import datetime
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def req_begin(method: str, path: str, model: str, route: str) -> str:
    """登记一条新请求，返回 sid（#N，面板唯一标识）。"""
    global REQ_SEQ
    now = time.time()
    with _STATE_LOCK:
        REQ_SEQ += 1
        sid = str(REQ_SEQ)
        REQS_ACTIVE[sid] = {
            "sid": sid, "start": now, "stage": "收请求", "stage_ts": now,
            "method": method, "path": path[:120], "model": model[:60],
            "route": route, "connect_ms": None,
            "up_first_ms": None, "e2e_first_ms": None, "sent": 0,
        }
    return sid


def req_stage(sid: str, stage: str, route=None) -> None:
    with _STATE_LOCK:
        e = REQS_ACTIVE.get(sid)
        if e is not None:
            e["stage"] = stage
            e["stage_ts"] = time.time()
            if route:
                e["route"] = route


def req_mark_connect(sid: str) -> None:
    with _STATE_LOCK:
        e = REQS_ACTIVE.get(sid)
        if e is not None:
            e["connect_ms"] = int((time.time() - e["start"]) * 1000)


def req_mark_up(sid: str) -> None:
    with _STATE_LOCK:
        e = REQS_ACTIVE.get(sid)
        if e is not None:
            e["up_first_ms"] = int((time.time() - e["start"]) * 1000)


def req_mark_e2e(sid: str) -> None:
    with _STATE_LOCK:
        e = REQS_ACTIVE.get(sid)
        if e is not None:
            e["e2e_first_ms"] = int((time.time() - e["start"]) * 1000)


def req_progress(sid: str, n: int) -> None:
    """流式传输中累加已发字节（面板在途行看进度用）。"""
    with _STATE_LOCK:
        e = REQS_ACTIVE.get(sid)
        if e is not None:
            e["sent"] += n


def req_finish(sid: str, ok: bool, error: str = "", sent: int = 0,
               outcome: str = "") -> None:
    now = time.time()
    with _STATE_LOCK:
        e = REQS_ACTIVE.pop(sid, None)
        if e is None:
            return
        REQS_RECENT.appendleft({
            "sid": sid, "at": _stamp_full(), "method": e["method"], "path": e["path"],
            "model": e["model"], "route": e["route"],
            "outcome": outcome or ("ok" if ok else "error"),
            "total_s": round(now - e["start"], 2),
            "first_ms": e["e2e_first_ms"], "up_ms": e["up_first_ms"],
            "bytes": sent, "error": (error or "")[:300],
        })


def req_oneshot(method: str, path: str, model: str, route: str,
                ok: bool, error: str) -> None:
    """建 sid 前就失败的请求（请求体坏/禁用节点无候选）：直接记一笔最近记录。"""
    global REQ_SEQ
    with _STATE_LOCK:
        REQ_SEQ += 1
        REQS_RECENT.appendleft({
            "sid": str(REQ_SEQ), "at": _stamp_full(), "method": method, "path": path[:120],
            "model": (model or "")[:60], "route": route,
            "outcome": "ok" if ok else "error",
            "total_s": 0, "first_ms": None, "up_ms": None,
            "bytes": 0, "error": (error or "")[:300],
        })


def reqs_snapshot():
    now = time.time()
    with _STATE_LOCK:
        active = [
            {
                "sid": e["sid"], "method": e["method"], "path": e["path"],
                "model": e["model"], "route": e["route"], "stage": e["stage"],
                "elapsed_s": round(now - e["start"], 1),
                "stuck_s": round(now - e["stage_ts"], 1),
                "connect_ms": e["connect_ms"],
                "up_first_ms": e["up_first_ms"],
                "e2e_first_ms": e["e2e_first_ms"], "sent": e["sent"],
            }
            for e in sorted(REQS_ACTIVE.values(), key=lambda x: x["start"])
        ]
        recent = list(REQS_RECENT)
    return {"active": active, "recent": recent}


def node_blocked(name: str) -> bool:
    """muse 禁用节点判断（香港/台湾出口不可用）。"""
    if not name:
        return False
    low = name.lower()
    return any(k in low for k in BLOCK_KEYWORDS)


def log(msg: str) -> None:
    import datetime
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    print(f"{ts} {msg}", file=sys.stderr, flush=True)


def note_error(path: str, route: str, msg: str) -> None:
    import datetime
    LAST.update(
        time=datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        route=route,
        path=path,
        error=msg,
    )


# ---------------- mihomo 控制口 ----------------
def ctl_secret() -> str:
    sec = os.environ.get("MUSE_PROXY_CTL_SECRET")
    if sec:
        return sec
    try:
        with open(CTL_SECRET_FILE) as f:
            return f.read().strip()
    except Exception:
        return ""


def ctl_call(path: str, payload=None):
    host, port = (CTL.split(":") + ["9097"])[:2]
    url = f"http://{host}:{port}{urllib.parse.quote(path, safe='/')}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="PUT" if data is not None else "GET")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    sec = ctl_secret()
    if sec:
        req.add_header("Authorization", f"Bearer {sec}")
    with urllib.request.urlopen(req, timeout=3) as r:
        raw = r.read()
        return json.loads(raw.decode()) if raw else {}


def ctl_request(method: str, raw_path: str, payload=None, timeout: int = 5):
    """带查询串的控制口调用（raw_path 里的 ?&= 不转义，给 delay 测速用）。"""
    host, port = (CTL.split(":") + ["9097"])[:2]
    url = f"http://{host}:{port}{raw_path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    sec = ctl_secret()
    if sec:
        req.add_header("Authorization", f"Bearer {sec}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw.decode()) if raw else {}


def find_group():
    """找出真正承载 muse 流量的策略组：先看活跃连接链路，再退回按候选节点推断。"""
    try:
        conns = (ctl_call("/connections") or {}).get("connections") or []
        for c in conns:
            host = str((c.get("metadata") or {}).get("host") or "")
            chains = c.get("chains") or []
            if CFG["upstream"] in host and len(chains) >= 2:
                return chains[-1]
    except Exception:
        pass

    try:
        proxies = (ctl_call("/proxies") or {}).get("proxies") or {}
    except Exception as e:
        log(f"换节点跳过：控制口 {CTL} 不可达({e})")
        return None
    for name, p in proxies.items():
        if p.get("type") != "Selector" or name == "GLOBAL":
            continue
        alln = p.get("all") or []
        now = p.get("now")
        if now in (None, "", "DIRECT", "REJECT", "GLOBAL"):
            continue
        if len([n for n in PREFERRED_NODES if n in alln]) < 2:
            continue
        return name
    return None


def current_group(force: bool = False):
    """返回 (策略组, 当前节点)。force=True 时同步问控制口（仅换节点等低频操作用）。"""
    if not force:
        return GROUP["group"], GROUP["now"]
    group = find_group()
    node = ""
    if group:
        try:
            node = (ctl_call(f"/proxies/{group}") or {}).get("now") or ""
        except Exception:
            node = ""
    with _STATE_LOCK:
        GROUP.update(ts=time.time(), group=group or "", now=node)
    return GROUP["group"], GROUP["now"]


def switch_node(exclude=()) -> str:
    """换到候选节点里优先级最高、且不是当前所用、且不在禁用列表的那个。返回新节点名或空串。"""
    if not AUTOSWITCH:
        return ""
    group, now = current_group(force=True)
    if not group:
        log("换节点跳过：找不到承载 muse 的策略组（控制口不可达或组内没有候选节点）")
        return ""
    try:
        alln = (ctl_call(f"/proxies/{group}") or {}).get("all") or []
    except Exception as e:
        log(f"换节点跳过：读组 {group} 失败({e})")
        return ""
    for node in PREFERRED_NODES:
        if node not in alln or node == now or node in exclude:
            continue
        if node_blocked(node):  # 双保险：候选里混进香港/台湾也不用
            continue
        try:
            ctl_call(f"/proxies/{group}", {"name": node})
            log(f"换节点 {group}: {now} → {node}")
            with _STATE_LOCK:
                GROUP.update(ts=time.time(), group=group, now=node)
            return node
        except Exception as e:
            log(f"换节点 {node} 失败：{e}")
    return ""


# ---------------- 后台探活（与主流程隔离） ----------------
def probe_once(ctx) -> tuple:
    """做一次 CONNECT+TLS 握手，不发业务请求。只由后台线程调用。"""
    host, port = (CFG["proxy"].split(":") + ["7897"])[:2]
    conn = None
    try:
        conn = http.client.HTTPSConnection(host, int(port), timeout=PREFLIGHT_TIMEOUT, context=ctx)
        conn.set_tunnel(CFG["upstream"], 443)
        conn.connect()
        return True, ""
    except Exception as e:
        return False, f"{e.__class__.__name__}: {e}"
    finally:
        try:
            if conn:
                conn.close()
        except Exception:
            pass


def refresh_group_cache() -> tuple:
    """刷新策略组/节点缓存，只由后台线程与换节点调用。返回 (group, now)。"""
    group = find_group()
    node = ""
    if group:
        try:
            node = (ctl_call(f"/proxies/{group}") or {}).get("now") or ""
        except Exception:
            node = ""
    with _STATE_LOCK:
        GROUP.update(ts=time.time(), group=group or "", now=node)
    return GROUP["group"], GROUP["now"]


def prober_loop():
    """后台线程：定时探活 + 刷新组缓存，只在状态变化/失败时打日志。"""
    import datetime
    ctx = ssl.create_default_context()
    last_ok, last_node = True, ""
    while True:
        try:
            ok, err = probe_once(ctx)
            group, now = refresh_group_cache()
            runs_fail = False
            with _STATE_LOCK:
                PROBE.update(ts=time.time(), ok=ok, err=err)
                PROBER["runs"] += 1
                PROBER["last_run"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                if not ok:
                    PROBER["failures"] += 1
                    runs_fail = True
            if not ok:
                log(f"后台探活失败({err})，主流程命中时会换节点")
            elif not last_ok:
                log("后台探活恢复，节点可用")
            if node_blocked(now) and now != last_node:
                log(f"后台发现当前节点 {now} 已禁用（香港/台湾不可用于 muse），下次 muse 请求会自动换走")
            last_ok, last_node = ok, now
        except Exception as e:
            log(f"后台探活异常：{e.__class__.__name__}: {e}")
        time.sleep(PROBE_INTERVAL)


# ---------------- 语义判断 ----------------
def is_region_error(raw: bytes) -> bool:
    t = raw.decode("utf-8", "replace").lower()
    return "regionerror" in t or "not available in your country" in t


def explain_upstream(status: int, raw: bytes) -> str:
    """把上游状态码翻成人能看懂的原因，直接出现在对话里。"""
    text = raw.decode("utf-8", "replace").strip()
    detail = ""
    code = ""
    try:
        data = json.loads(text)
        err = data.get("error") if isinstance(data, dict) else None
        if isinstance(err, dict):
            code = str(err.get("code") or err.get("type") or "")
            detail = str(err.get("message") or "")
        elif isinstance(err, str):
            detail = err
        if not detail and isinstance(data, dict):
            detail = str(data.get("message") or data.get("detail") or "")
    except Exception:
        detail = text
    blob = f"{code} {detail}".lower()
    region = "region" in blob or "not available in your country" in blob

    if status == 401:
        why, hint = "Go key 失效或订阅异常", "；去 OpenCode Console 重建 API key"
    elif status == 403 and region:
        why, hint = "当前节点出口地区不被 muse 接受（RegionError）", "；自动换节点也没成功，去 Verge 手动换：美国01 → 伦敦01 → 新加坡专线01"
    elif status == 403:
        why, hint = "上游拒绝访问", ""
    elif status == 404:
        why, hint = "接口路径不存在", ""
    elif status == 429:
        why, hint = "限流或超量", "；查 opencode console 用量，或等窗口重置"
    elif 500 <= status < 600:
        why, hint = "上游服务故障", "；稍后重试，或换节点"
    elif status == 400:
        why, hint = "请求被上游拒绝", ""
    else:
        why, hint = "上游返回异常", ""

    tail = f"：{detail[:200]}" if detail else ""
    return f"muse 上游 {status} {why}{hint}{tail}"


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "muse-proxy/1.7"

    def log_message(self, fmt, *args):  # 不打印默认访问日志，避免噪音
        return

    # ---------- 异常要能让客户端看见（否则对话里就是一直转圈） ----------
    def send_proxy_error(self, status: int, message: str) -> None:
        payload = json.dumps({
            "error": {
                "type": "muse_proxy_error",
                "code": f"muse_proxy_{status}",
                "message": message,
            }
        }, ensure_ascii=False).encode()
        traffic_add(0, len(payload), False)  # 错误响应体也算下行（路由未知，只记总量）
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)
            self.wfile.flush()
        except Exception:
            pass
        self.close_connection = True

    # ---------- 请求体（支持 chunked，否则 body 会被吞） ----------
    def read_body(self) -> bytes:
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        self.connection.settimeout(BODY_READ_TIMEOUT)
        try:
            if "chunked" in te:
                parts = []
                while True:
                    line = self.rfile.readline(65536)
                    if not line:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        size = int(line.split(b";")[0], 16)
                    except ValueError:
                        raise ValueError(f"chunk 长度非法: {line[:20]!r}")
                    if size == 0:
                        while True:
                            t = self.rfile.readline(65536)
                            if t in (b"\r\n", b"\n", b""):
                                break
                        break
                    parts.append(self.rfile.read(size))
                    self.rfile.read(2)  # 每块结尾的 CRLF
                return b"".join(parts)
            length = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(length) if length else b""
        finally:
            self.connection.settimeout(None)

    # ---------- 路由判断 ----------
    @staticmethod
    def wants_proxy(body: bytes) -> bool:
        if not body:
            return False
        try:
            data = json.loads(body.decode("utf-8", "replace"))
        except Exception:
            return False
        model = str((data or {}).get("model") or "").lower()
        return model.startswith(MUSE_PREFIX)

    @staticmethod
    def model_of(body: bytes) -> str:
        """请求体里的模型名（面板实时流程展示用，解析失败返回空）。"""
        try:
            data = json.loads(body.decode("utf-8", "replace"))
            return str((data or {}).get("model") or "")
        except Exception:
            return ""

    # ---------- 健康检查 ----------
    def do_GET(self):
        if self.path == "/__health":
            payload = json.dumps({
                "ok": True,
                "upstream": CFG["upstream"],
                "proxy": CFG["proxy"],
                "muse_prefix": MUSE_PREFIX,
                "timeouts": {
                    "connect": CONNECT_TIMEOUT,
                    "body": BODY_READ_TIMEOUT,
                    "first_byte": FIRST_BYTE_TIMEOUT,
                    "stream_idle": STREAM_IDLE_TIMEOUT,
                },
                "preflight": {
                    "enabled": PREFLIGHT,
                    "mode": "background",
                    "timeout": PREFLIGHT_TIMEOUT,
                    "interval": PROBE_INTERVAL,
                    "ok": PROBE["ok"],
                    "err": PROBE["err"],
                    "runs": PROBER["runs"],
                    "failures": PROBER["failures"],
                    "last_run": PROBER["last_run"],
                },
                "autoswitch": {
                    "enabled": AUTOSWITCH,
                    "ctl": CTL,
                    "nodes": PREFERRED_NODES,
                    "blocked_keywords": BLOCK_KEYWORDS,
                    "group": GROUP["group"],
                    "now": GROUP["now"],
                    "now_blocked": node_blocked(GROUP["now"]),
                },
                "last_error": LAST,
                "requests": reqs_snapshot(),
                "traffic": traffic_snapshot(),
            }, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.forward("GET")

    def do_POST(self):
        self.forward("POST")

    def do_PUT(self):
        self.forward("PUT")

    def do_DELETE(self):
        self.forward("DELETE")

    def do_PATCH(self):
        self.forward("PATCH")

    # ---------- 本地运维端点 ----------
    def send_local_json(self, status: int, obj) -> None:
        payload = json.dumps(obj, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)
            self.wfile.flush()
        except Exception:
            pass
        self.close_connection = True

    def handle_switch(self, body: bytes) -> None:
        """POST /__switch {node?}：切到指定节点，或按优先级自动换下一个。"""
        want = ""
        if body:
            try:
                want = str(json.loads(body.decode("utf-8", "replace")).get("node") or "")
            except Exception:
                want = ""
        group, now = current_group(force=True)
        if not group:
            self.send_local_json(502, {"ok": False, "error": "控制口不可达，找不到策略组"})
            return
        if want:
            try:
                alln = (ctl_call(f"/proxies/{group}") or {}).get("all") or []
            except Exception as e:
                self.send_local_json(502, {"ok": False, "error": f"读组失败：{e}"})
                return
            if want not in alln:
                self.send_local_json(400, {"ok": False, "error": f"组 {group} 里没有节点 {want}"})
                return
            if node_blocked(want):
                self.send_local_json(400, {"ok": False, "error": f"节点 {want} 已禁用（香港/台湾不可用于 muse）"})
                return
            try:
                ctl_call(f"/proxies/{group}", {"name": want})
                with _STATE_LOCK:
                    GROUP.update(ts=time.time(), group=group, now=want)
                log(f"手动换节点 {group}: {now} → {want}")
                self.send_local_json(200, {"ok": True, "from": now, "to": want, "group": group})
            except Exception as e:
                self.send_local_json(502, {"ok": False, "error": f"换节点失败：{e}"})
            return
        node = switch_node()
        if node:
            self.send_local_json(200, {"ok": True, "from": now, "to": node, "group": group})
        else:
            self.send_local_json(502, {"ok": False, "error": "没有可用候选节点", "from": now, "group": group})

    def handle_probe_now(self) -> None:
        """POST /__probe-now：同步做一次探活 + 组刷新，立即返回结果。"""
        ctx = ssl.create_default_context()
        t0 = time.time()
        ok, err = probe_once(ctx)
        group, now = refresh_group_cache()
        log(f"手动探活 {'OK' if ok else '失败(' + err + ')'}（{time.time() - t0:.2f}s）")
        self.send_local_json(200 if ok else 502, {
            "ok": ok, "err": err, "group": group, "now": now,
            "blocked": node_blocked(now), "elapsed": round(time.time() - t0, 2),
        })

    # ---------- Clash 刷新：订阅更新 + 全组测速取 TopN ----------
    @staticmethod
    def _is_real_node(name: str) -> bool:
        if not name or name in SKIP_NODES:
            return False
        return not (name.startswith("剩余流量") or name.startswith("套餐到期"))

    def clash_delay(self, name: str):
        """单个节点测速，返回 (name, delay_ms|None)。失败/超时记 None。"""
        q = urllib.parse.quote(name, safe="")
        u = urllib.parse.quote(CLASH_TEST_URL, safe="")
        ms = int(CLASH_TEST_TIMEOUT * 1000)
        try:
            r = ctl_request("GET", f"/proxies/{q}/delay?timeout={ms}&url={u}",
                            timeout=CLASH_TEST_TIMEOUT + 3)
            d = r.get("delay")
            return (name, d if isinstance(d, int) else None)
        except Exception:
            return (name, None)

    def _provider_snapshot(self, providers: dict) -> dict:
        """provider 名 -> (节点数, 名单哈希)，用来判断 PUT 后订阅内容是否真变了。"""
        import hashlib
        snap = {}
        for pname, p in (providers or {}).items():
            names = sorted(str(x.get("name") or "") for x in (p.get("proxies") or []))
            snap[pname] = (len(names), hashlib.md5("|".join(names).encode()).hexdigest()[:12])
        return snap

    def handle_clash_delay(self, body: bytes) -> None:
        """POST /__clash-delay {node?}：只测一个节点（默认当前节点），轻量定时刷新用。"""
        want = ""
        if body:
            try:
                want = str(json.loads(body.decode("utf-8", "replace")).get("node") or "")
            except Exception:
                want = ""
        name = want or GROUP.get("now") or ""
        if not name:
            self.send_local_json(502, {"ok": False, "error": "当前无节点可测"})
            return
        _, delay = self.clash_delay(name)
        if delay is None:
            self.send_local_json(502, {"ok": False, "node": name, "error": "测速失败或超时"})
            return
        log(f"单节点测速 {name} = {delay}ms")
        self.send_local_json(200, {"ok": True, "node": name, "delay_ms": delay})

    def handle_clash_refresh(self) -> None:
        """POST /__clash-refresh：订阅刷新 + 当前策略组全节点测速，返回最快 TopN。

        步骤：逐个 PUT /providers/proxies/{名} 触发订阅更新（前后对名单做哈希，
        没变化就如实报告，免得 204 误导人）→ 顺手触发一次 clash 自带
        healthcheck（异步，不管结果）→ 对当前组全部真实节点 10 并发打
        delay → 按延迟排序取最快，香港/台湾等禁用节点不进 Top
        （muse 不可用，进去也切不过去）。
        注意：节点内联在 Verge profile 里的，核心 PUT 拉不到新东西，
        那种订阅只能去 Verge 里点更新。
        """
        t0 = time.time()
        try:
            providers = (ctl_request("GET", "/providers/proxies", timeout=8)
                         or {}).get("providers") or {}
        except Exception as e:
            msg = f"控制口 {CTL} 不可达：{e}"
            log(f"Clash 刷新失败：{msg}")
            self.send_local_json(502, {"ok": False, "error": msg})
            return
        before = self._provider_snapshot(providers)
        updated, upd_fail = [], []
        for pname in providers.keys():
            try:
                ctl_request("PUT",
                            f"/providers/proxies/{urllib.parse.quote(pname, safe='')}",
                            timeout=10)
                updated.append(pname)
            except Exception as e:
                upd_fail.append(f"{pname}：{e}")
        # 给核心一点时间做异步拉取，再重读对比名单是否真变了
        time.sleep(3)
        try:
            after_providers = (ctl_request("GET", "/providers/proxies", timeout=8)
                               or {}).get("providers") or {}
        except Exception:
            after_providers = {}
        after = self._provider_snapshot(after_providers)
        changed, same = [], []
        for pname in updated:
            b, a = before.get(pname, (0, "")), after.get(pname, (0, ""))
            if b != a and pname in after:
                changed.append({"name": pname, "before": b[0], "after": a[0]})
            else:
                same.append(pname)
        if changed:
            sub_note = "订阅已更新：" + "、".join(f"{c['name']}{c['before']}→{c['after']}个" for c in changed)
        elif updated:
            sub_note = "订阅内容无变化（源站无更新，或节点内联在 Verge profile 里，只能去 Verge 点更新）"
        else:
            sub_note = ""
        # 触发 clash 自带健康检查（后台异步做，只为刷新它自己的 alive 状态）
        try:
            u = urllib.parse.quote(CLASH_TEST_URL, safe="")
            ctl_request("GET",
                        f"/providers/proxies/default/healthcheck?url={u}&timeout=5000",
                        timeout=5)
        except Exception:
            pass
        group, now = current_group(force=True)
        if not group:
            self.send_local_json(502, {
                "ok": False, "error": "控制口不可达或组内无候选，找不到承载 muse 的策略组",
                "providers_updated": updated, "providers_failed": upd_fail,
                "sub_note": sub_note})
            return
        try:
            alln = (ctl_call(f"/proxies/{group}") or {}).get("all") or []
        except Exception as e:
            self.send_local_json(502, {
                "ok": False, "error": f"读组 {group} 失败：{e}",
                "providers_updated": updated, "providers_failed": upd_fail,
                "sub_note": sub_note})
            return
        candidates = [n for n in alln if self._is_real_node(n)]
        results = []
        if candidates:
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
                futs = {ex.submit(self.clash_delay, n): n for n in candidates}
                try:
                    for f in concurrent.futures.as_completed(futs, timeout=90):
                        try:
                            results.append(f.result())
                        except Exception:
                            results.append((futs[f], None))
                except Exception:
                    pass  # 整体超时：有多少算多少
        scored = sorted(((n, d) for n, d in results if d is not None),
                        key=lambda x: x[1])
        failed_n = sum(1 for _, d in results if d is None)
        usable = [(n, d) for n, d in scored if not node_blocked(n)]
        top = [{"name": n, "delay_ms": d, "blocked": False}
               for n, d in usable[:CLASH_TOP_N]]
        # 默认用最快：如果当前节点不是 Top1，自动切过去（只影响新建连接，在途流不受影响）
        switched_to, switch_error = "", ""
        if top:
            want = top[0]["name"]
            if now != want:
                try:
                    ctl_request("PUT",
                                f"/proxies/{urllib.parse.quote(group, safe='')}",
                                {"name": want}, timeout=5)
                    with _STATE_LOCK:
                        GROUP.update(ts=time.time(), group=group, now=want)
                    switched_to = want
                    log(f"Clash 刷新后自动切到最快节点 {group}: {now} → {want}")
                except Exception as e:
                    switch_error = f"{e.__class__.__name__}: {e}"
                    log(f"自动切最快节点 {want} 失败({switch_error})，保持 {now}")
        elapsed = round(time.time() - t0, 1)
        log(f"Clash 刷新完成（{elapsed}s）：{sub_note}；"
            f"测速 {len(results)}/{len(candidates)}，"
            f"Top{len(top)} {', '.join(f'{n} {d}ms' for n, d in usable[:CLASH_TOP_N]) or '无'}"
            f"{'，已切 ' + switched_to if switched_to else ''}")
        self.send_local_json(200, {
            "ok": True, "group": group, "now": switched_to or now,
            "elapsed": elapsed, "providers_updated": updated,
            "providers_failed": upd_fail, "tested": len(results),
            "failed_n": failed_n,
            "blocked_skipped": len(scored) - len(usable),
            "providers_changed": changed, "providers_same": same,
            "sub_note": sub_note, "top": top,
            "switched_to": switched_to, "switch_error": switch_error,
        })

    # ---------- 转发 ----------
    def _open(self, via_proxy: bool, ctx):
        """建连(TCP+TLS+可选隧道)。"""
        if via_proxy:
            host, port = (CFG["proxy"].split(":") + ["7897"])[:2]
            conn = http.client.HTTPSConnection(host, int(port), timeout=CONNECT_TIMEOUT, context=ctx)
            conn.set_tunnel(CFG["upstream"], 443)
        else:
            conn = http.client.HTTPSConnection(CFG["upstream"], 443, timeout=CONNECT_TIMEOUT, context=ctx)
        conn.connect()
        return conn

    def forward(self, method: str):
        t0 = time.time()

        # 本地运维端点（只监听 127.0.0.1，给 OpenChamber 插件调的，不转发上游）
        if self.path == "/__switch" and method == "POST":
            try:
                body = self.read_body()
            except Exception as e:
                self.send_proxy_error(400, f"请求体读取失败：{e}")
                return
            self.handle_switch(body)
            return
        if self.path == "/__probe-now" and method == "POST":
            self.handle_probe_now()
            return
        if self.path == "/__clash-refresh" and method == "POST":
            self.handle_clash_refresh()
            return
        if self.path == "/__clash-delay" and method == "POST":
            try:
                body = self.read_body()
            except Exception as e:
                self.send_proxy_error(400, f"请求体读取失败：{e}")
                return
            self.handle_clash_delay(body)
            return
        if self.path.startswith("/__"):
            self.send_proxy_error(404, f"未知本地端点：{self.path}")
            return

        try:
            body = self.read_body()
        except Exception as e:
            msg = f"muse-proxy 读取请求体失败（{BODY_READ_TIMEOUT}s 超时或格式错误）：{e}"
            log(f"[{method} {self.path}] {msg}")
            note_error(self.path, "-", msg)
            req_oneshot(method, self.path, "", "-", False, msg)
            self.send_proxy_error(400, msg)
            return

        via_proxy = self.wants_proxy(body)
        model = self.model_of(body)
        log(f"[{method} {self.path}] 收到 {len(body)}B → {'proxy' if via_proxy else 'direct'}")
        traffic_add(len(body), 0, via_proxy)  # 上行：收到请求体即记

        ctx = ssl.create_default_context()
        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in ("host", "connection", "proxy-connection", "content-length", "transfer-encoding")
        }
        headers["Host"] = CFG["upstream"]
        if body or method in ("POST", "PUT", "PATCH"):
            headers["Content-Length"] = str(len(body))

        # 0) 香港/台湾节点对 muse 不通：当前就是它就先换走，别等上游 403（只读后台缓存，不阻塞）
        if via_proxy and AUTOSWITCH:
            cur = GROUP["now"]
            if node_blocked(cur) and GROUP["group"]:
                log(f"[{method} {self.path}] 当前节点 {cur} 已禁用（香港/台湾不可用于 muse），换走")
                node = switch_node(exclude=(cur,))
                if not node:
                    msg = (f"muse-proxy 当前节点 {cur} 被禁用（香港/台湾出口对 muse 不可用），"
                           "且没有可用候选节点；去 Verge 手动换：美国01 → 伦敦01 → 新加坡专线01")
                    log(f"[{method} {self.path}] {msg}")
                    note_error(self.path, "proxy", msg)
                    req_oneshot(method, self.path, model, "proxy", False, msg)
                    self.send_proxy_error(502, msg)
                    return

        # 1) 节点活性只读后台缓存：坏且新鲜就换，换不动立刻报错；缓存陈旧/未知则乐观直发，
        #    真出问题由下面的建连失败→换节点重试兜住。主流程永不等待探活。
        if via_proxy and PREFLIGHT:
            pok, perr, pts = PROBE["ok"], PROBE["err"], PROBE["ts"]
            if not pok and time.time() - pts < PROBE_INTERVAL * 3:
                node = switch_node()
                if node:
                    log(f"[{method} {self.path}] 后台探活为坏，已换节点 {node}，直接发请求")
                else:
                    msg = (f"muse-proxy 节点探活失败（后台 {PREFLIGHT_TIMEOUT}s 握手：{perr}）："
                           "去 Verge 换节点：美国01 → 伦敦01 → 新加坡专线01")
                    log(f"[{method} {self.path}] {msg}")
                    note_error(self.path, "proxy", msg)
                    req_oneshot(method, self.path, model, "proxy", False, msg)
                    self.send_proxy_error(502, msg)
                    return

        # 2) 发请求；失败或 403 地区限制则换节点重试一次
        attempts = 0
        switched = ""
        sid = req_begin(method, self.path, model, "proxy" if via_proxy else "direct")  # 从这里起算一条在用请求；下面所有错误返回前都要先注销
        while True:
            attempts += 1
            stage = "建连" if via_proxy else "直连建连"
            req_stage(sid, "建连中", "proxy" if via_proxy else "direct")
            conn = None
            try:
                conn = self._open(via_proxy, ctx)
                log(f"[{method} {self.path}] 上游已连接({time.time() - t0:.2f}s) "
                    f"{'经' + CFG['proxy'] if via_proxy else '直连'}")
                req_mark_connect(sid)
                req_stage(sid, "等上游首字节")
                stage = "等待上游首字节"
                conn.sock.settimeout(FIRST_BYTE_TIMEOUT)
                conn.request(method, self.path, body=body or None, headers=headers)
                resp = conn.getresponse()
                req_mark_up(sid)
            except Exception as e:
                if via_proxy and attempts == 1 and AUTOSWITCH:
                    node = switch_node(exclude=(switched,) if switched else ())
                    if node:
                        switched = node
                        log(f"[{method} {self.path}] {stage}失败({e})，已换节点 {node} 重试")
                        try:
                            conn.close()
                        except Exception:
                            pass
                        continue
                if via_proxy:
                    # 兜底：降级直连（TUN 全量时等同没用，仅为不断链）
                    log(f"[{method} {self.path}] proxy {stage}失败({e})，降级直连")
                    try:
                        conn.close()
                    except Exception:
                        pass
                    via_proxy = False
                    try:
                        conn = self._open(False, ctx)
                        conn.sock.settimeout(FIRST_BYTE_TIMEOUT)
                        conn.request(method, self.path, body=body or None, headers=headers)
                        resp = conn.getresponse()
                        req_mark_up(sid)
                        req_stage(sid, "等上游首字节", "direct")
                        log(f"[{method} {self.path}] 上游已连接({time.time() - t0:.2f}s) 直连(降级)")
                    except Exception as e2:
                        msg = (f"muse-proxy 连不上上游（代理不可用，直连 {CFG['upstream']} 也失败）："
                               f"{e2}；检查 Clash 是否运行、节点是否可用")
                        log(f"[{method} {self.path}] {msg}")
                        note_error(self.path, "direct", msg)
                        req_finish(sid, False, msg)
                        self.send_proxy_error(502, msg)
                        return
                else:
                    msg = (f"muse-proxy {stage}失败：{e}"
                           f"（{FIRST_BYTE_TIMEOUT}s 内上游无数据则为上游/节点卡住）")
                    log(f"[{method} {self.path}] {msg}")
                    note_error(self.path, "direct", msg)
                    req_finish(sid, False, msg)
                    self.send_proxy_error(504 if stage == "等待上游首字节" else 502, msg)
                    return

            # 403 地区限制 → 换节点重试一次
            if via_proxy and resp.status == 403:
                raw = resp.read(65536)
                if is_region_error(raw) and attempts == 1 and AUTOSWITCH:
                    node = switch_node(exclude=(switched,) if switched else ())
                    if node:
                        switched = node
                        log(f"[{method} {self.path}] 403 RegionError，已换节点 {node} 重试")
                        try:
                            conn.close()
                        except Exception:
                            pass
                        continue
                msg = explain_upstream(403, raw)
                log(f"[{method} {self.path}] {msg}（{time.time() - t0:.2f}s）")
                note_error(self.path, "proxy", msg)
                try:
                    conn.close()
                except Exception:
                    pass
                req_finish(sid, False, msg)
                self.send_proxy_error(403, msg)
                return
            break

        log(f"[{method} {self.path}] 响应头 {resp.status} ({time.time() - t0:.2f}s) "
            f"{'proxy' if via_proxy else 'direct'}")

        # 3) 其他上游错误也翻成人话
        if via_proxy and resp.status >= 400:
            try:
                raw = resp.read(65536)
            except Exception:
                raw = b""
            msg = explain_upstream(resp.status, raw)
            log(f"[{method} {self.path}] {msg}（{time.time() - t0:.2f}s）")
            note_error(self.path, "proxy", msg)
            try:
                conn.close()
            except Exception:
                pass
            req_finish(sid, False, msg)
            self.send_proxy_error(resp.status, msg)
            return

        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() in ("transfer-encoding", "connection", "content-length", "keep-alive"):
                continue
            self.send_header(k, v)
        # 一律 chunked，保证 SSE 边收边发
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self.wfile.flush()
        req_mark_e2e(sid)  # 首字节已发出：端到端首字节
        req_stage(sid, "流式传输")

        sent = 0
        err = None
        try:
            conn.sock.settimeout(STREAM_IDLE_TIMEOUT)
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
                sent += len(chunk)
                req_progress(sid, len(chunk))
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError) as e:
            err = f"客户端断开({e.__class__.__name__})"
        except Exception as e:
            # 流中途断：绝不能补 0\r\n\r\n，否则客户端当成正常结束——那正是「卡住又不报错」的来源
            err = f"流中断({e.__class__.__name__}: {e})"
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
        finally:
            dur = time.time() - t0
            traffic_add(0, sent, via_proxy)  # 下行：实际发给客户端的字节
            if err is None:
                req_finish(sid, True, sent=sent)
            elif err.startswith("流中断"):
                req_finish(sid, False, err, sent=sent)
            else:
                # 客户端提前断开：上游本身正常，记 warn 不计入失败
                req_finish(sid, True, err, sent=sent, outcome="warn")
            if err:
                msg = f"muse-proxy {err}，已发 {sent}B 后断开（本轮回复不完整）"
                log(f"[{method} {self.path}] {msg} 用时 {dur:.2f}s")
                note_error(self.path, "proxy" if via_proxy else "direct", msg)
            else:
                log(f"[{method} {self.path}] 完成 {sent}B 用时 {dur:.2f}s")
            try:
                conn.close()
            except Exception:
                pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64  # 默认 5，线程被卡住时新请求会排队表现为「完全无反应」

    # 客户端（OpenCode）断开 keep-alive 连接是常态，别刷一堆 traceback
    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def main() -> None:
    ap = argparse.ArgumentParser(description="OpenCode 本地分流代理：muse 走代理，其他直连")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MUSE_PROXY_PORT", DEFAULT_PORT)))
    ap.add_argument("--upstream", default=os.environ.get("MUSE_PROXY_UPSTREAM", DEFAULT_UPSTREAM))
    ap.add_argument("--proxy", default=os.environ.get("MUSE_PROXY_HTTP", DEFAULT_PROXY))
    args = ap.parse_args()

    CFG.update(port=args.port, upstream=args.upstream, proxy=args.proxy)
    srv = Server(("127.0.0.1", CFG["port"]), Handler)
    log(f"muse-proxy 监听 127.0.0.1:{CFG['port']} → {CFG['upstream']}（muse* 经 {CFG['proxy']}，其他直连）")
    log(f"超时 建连{CONNECT_TIMEOUT}s 请求体{BODY_READ_TIMEOUT}s 首字节{FIRST_BYTE_TIMEOUT}s 流空闲{STREAM_IDLE_TIMEOUT}s")
    if PREFLIGHT:
        t = threading.Thread(target=prober_loop, name="prober", daemon=True)
        t.start()
        log(f"后台探活线程已启动（每{PROBE_INTERVAL}s，握手{PREFLIGHT_TIMEOUT}s），主流程不等待探活")
    log(f"换节点 {'开' if AUTOSWITCH else '关'}(控制口 {CTL})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
