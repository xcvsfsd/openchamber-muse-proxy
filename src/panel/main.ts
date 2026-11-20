// Muse 代理面板：状态 + 网速 + 日志 + Clash 测速。
import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBadge, mountButton, mountPopoverAnchor, mountSeparator, mountText } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;
root.style.padding = '12px';
root.style.display = 'flex';
root.style.flexDirection = 'column';
root.style.gap = '10px';
root.style.fontSize = '15px';

const stateBox = document.createElement('div');
root.append(stateBox);

// 分区头：标题（大字）+ 右侧操作按钮，按钮与内容在一起
function sectionHead(box: HTMLElement, title: string) {
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px;';
  const t = document.createElement('div');
  t.style.cssText = 'font-size:16px;font-weight:700;margin-right:auto;';
  t.textContent = title;
  head.appendChild(t);
  box.appendChild(head);
  const body = document.createElement('div');
  box.appendChild(body);
  return { head, body };
}

// 状态区两行常驻行：节点行 + 进程行，按钮嵌在行尾（只建一次，刷新只改字）
function liveRow(body: HTMLElement) {
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;gap:8px;align-items:center;padding:7px 4px;border-bottom:1px solid var(--oc-sdk-edge);';
  const tx = document.createElement('div');
  tx.style.cssText = 'flex:1;min-width:0;';
  const m = document.createElement('div');
  m.style.cssText = 'font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const s = document.createElement('div');
  s.style.cssText = 'font-size:13px;opacity:0.7;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  tx.append(m, s);
  const slot = document.createElement('div');
  slot.style.cssText = 'display:flex;gap:6px;flex-shrink:0;align-items:center;';
  d.append(tx, slot);
  body.appendChild(d);
  return { row: d, tx, main: m, sub: s, slot };
}

const stateSec = sectionHead(stateBox, '状态');
// 徽标紧跟在状态后
(stateSec.head.firstElementChild as HTMLElement).style.marginRight = '0';
const statusBadge = mountBadge(stateSec.head, { label: '…', tone: 'neutral' });
mountSeparator(stateSec.body, {});
const nodeLine = liveRow(stateSec.body);
// Clash Top 下拉区：默认收起，点节点行展开；挂在节点行下、进程行上
const clashDrop = document.createElement('div');
clashDrop.style.cssText = 'padding-left:14px;';
stateSec.body.appendChild(clashDrop);
// 下拉内的列表区（只建一次，刷新只改列表；按钮已移到节点行尾）
const clashList = document.createElement('div');
clashDrop.appendChild(clashList);
const procLine = liveRow(stateSec.body);
// 日志下拉区：默认收起，点代理服务行展开；挂在进程行下
const flowDrop = document.createElement('div');
flowDrop.style.cssText = 'padding-left:14px;';
stateSec.body.appendChild(flowDrop);
let flowOpen = false;
procLine.tx.style.cursor = 'pointer';
procLine.tx.title = '展开/收起日志';
procLine.tx.addEventListener('click', () => { flowOpen = !flowOpen; void load(true); });

// 底部栏：上次刷新时间 + 版本号（常驻，只改字）
const footBox = document.createElement('div');
root.appendChild(footBox);
mountSeparator(footBox, {});
const footText = document.createElement('div');
footText.style.cssText = 'font-size:12px;opacity:0.6;padding:2px 4px;';
footBox.appendChild(footText);
let pkgVersion = '';
let lastRefreshAt = '';
function paintFoot() {
  footText.textContent = `上次刷新：${lastRefreshAt || '—'} · 版本号：${pkgVersion || '—'}`;
}
paintFoot();
// 开关状态（内存，默认收起；刷出新 Top 后自动展开一次）
let clashOpen = false;
nodeLine.tx.style.cursor = 'pointer';
nodeLine.tx.title = '展开/收起 Clash 测速 Top';
nodeLine.tx.addEventListener('click', () => { clashOpen = !clashOpen; void load(true); });

// 网速信息跟在 状态/徽标 后面（小字弱化，每轮改字）
const trafficInfo = document.createElement('div');
trafficInfo.style.cssText = 'font-size:13px;opacity:0.75;font-family:monospace;white-space:nowrap;';
stateSec.head.appendChild(trafficInfo);

async function req(path: string, method = 'GET', body?: unknown) {
  const r = await host.serviceRequest({ method: method as 'GET', path, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: r.body ? JSON.parse(r.body) : null };
}

function busy(btn: { update: (p: object) => void }, fn: () => Promise<void>) {
  return async () => {
    try { btn.update({ loading: true }); await fn(); }
    finally { try { btn.update({ loading: false }); } catch { /* 忽略 */ } }
  };
}

// SDK 只有主题色/红色 variant，绿/蓝直接盖行内样式（loading 重绘不碰 style，常驻有效）
function toneBtn(slot: HTMLElement, bg: string) {
  const el = slot.querySelector('button');
  if (el) {
    const h = el as HTMLElement;
    h.style.background = bg;
    h.style.borderColor = 'transparent';
    h.style.color = '#fff';
  }
}

const svcBtn = mountButton(procLine.slot, {
  label: '重启/拉起', variant: 'destructive', size: 'sm',
  onClick: busy({ update: (p) => svcBtn.update(p) }, () => act('/status', { id: 'svc' }, '已执行')),
});
toneBtn(procLine.slot, '#2563eb'); // 蓝色
const clashBtn = mountButton(nodeLine.slot, {
  label: 'Clash刷新', variant: 'destructive', size: 'sm',
  // 订阅更新 + 全组测速约 10-20s，刷完自动切最快并展开下拉
  onClick: busy({ update: (p: object) => clashBtn.update(p) }, clashRefresh),
});
toneBtn(nodeLine.slot, '#16a34a'); // 绿色

async function clashRefresh() {
  try {
    await host.toast({ kind: 'info', message: 'Clash刷新中：订阅更新+全组测速，约10-20秒…' });
    const r = await req('/status', 'POST', { id: 'clash-refresh' });
    if (r.status >= 200 && r.status < 300) {
      const c = (r.json as { clash?: ClashInfo } | null)?.clash;
      await host.toast({ kind: 'success', message: c?.top?.length ? (c.switched_to ? `Clash刷新完成（${c.elapsed}s，测了${c.tested}个）：已自动切到最快 ${c.switched_to}` : `Clash刷新完成（${c.elapsed}s）：当前已是最快 ${c.top[0].name}`) : 'Clash刷新完成' });
      clashOpen = true; // 刷出新 Top，自动展开下拉
    } else {
      await host.toast({ kind: 'error', message: String((r.json as { message?: string } | null)?.message ?? 'Clash刷新失败') });
    }
    await load(true);
  } catch (e) {
    await host.toast({ kind: 'error', message: `请求失败：${e instanceof Error ? e.message : e}` });
  }
}

async function switchToNode(nodeName: string) {
  try {
    const r = await req('/status', 'POST', { id: 'switch', node: nodeName });
    if (r.status >= 200 && r.status < 300) {
      await host.toast({ kind: 'success', message: `已切换到 ${nodeName}` });
    } else {
      await host.toast({ kind: 'error', message: String((r.json as { message?: string } | null)?.message ?? '切换失败') });
    }
    await load(true);
  } catch (e) {
    await host.toast({ kind: 'error', message: `请求失败：${e instanceof Error ? e.message : e}` });
  }
}

async function toastResult(r: { status: number; json: unknown }, okMsg: string) {
  if (r.status >= 200 && r.status < 300) {
    await host.toast({ kind: 'success', message: okMsg });
  } else {
    await host.toast({ kind: 'error', message: String((r.json as { message?: string } | null)?.message ?? '操作失败') });
  }
}

async function act(path: string, body: unknown, okMsg: string) {
  try {
    const r = await req(path, 'POST', body);
    await toastResult(r, okMsg);
    await load(true);
  } catch (e) {
    await host.toast({ kind: 'error', message: `请求失败：${e instanceof Error ? e.message : e}` });
  }
}

type Traffic = {
  up_bytes: number; down_bytes: number;
  up_muse: number; down_muse: number;
  up_rate: number; down_rate: number; window_s: number;
};

// 日志：代理内每条请求的阶段追踪（卡住/失败一眼可见）
type ReqActive = {
  sid: string; method: string; path: string; model: string; route: string;
  stage: string; elapsed_s: number; stuck_s: number;
  connect_ms: number | null; up_first_ms: number | null;
  e2e_first_ms: number | null; sent: number;
};
type ReqRecent = {
  sid: string; at: string; method: string; path: string; model: string; route: string;
  outcome: 'ok' | 'warn' | 'error'; total_s: number;
  first_ms: number | null; up_ms: number | null; bytes: number; error: string;
};
type ClashTop = { name: string; delay_ms: number; blocked: boolean };
type ClashInfo = {
  at: string; group: string; now: string; elapsed: number;
  tested: number; switched_to: string; top: ClashTop[];
};

type Full = {
  version?: string;
  health: {
    reachable: boolean; at: string; proxy: string;
    timeouts: Record<string, number>;
    preflight: { ok: boolean; err: string; runs: number; failures: number };
    autoswitch: { enabled: boolean; group: string; now: string; now_blocked: boolean };
    last_error: { time: string; error: string };
    requests?: { active: ReqActive[]; recent: ReqRecent[] };
    traffic?: Traffic;
  };
  clash?: ClashInfo | null;
  process?: { listening: boolean; systemd: string; unit: boolean };
};

const fmtRate = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  if (v < 1024) return `${Math.round(v)}B/s`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB/s`;
  return `${(v / 1024 / 1024).toFixed(2)}MB/s`;
};

// 网速一行：标题直接带上下行速率 + 累计总量
function drawTrafficInfo(t?: Traffic) {
  if (!t) {
    trafficInfo.textContent = '暂无数据';
    return;
  }
  trafficInfo.textContent = `↑ ${fmtRate(t.up_rate)} ↓ ${fmtRate(t.down_rate)} 🌴 ${humanBytes(t.up_bytes + t.down_bytes)}`;
}

const ms = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  if (v < 1000) return `${v}ms`;
  return `${(v / 1000).toFixed(1)}s`;
};

async function load(force = false) {
  try {
    const f = await req('/full');
    if (f.status !== 200 || !f.json) throw new Error(`full http-${f.status}`);
    const full = f.json as Full;
    if (full.version) pkgVersion = full.version;
    draw(full, force);
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    lastRefreshAt = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    paintFoot();
  } catch (e) {
    stateSec.body.textContent = '';
    note(stateSec.body, `服务不可用：${e instanceof Error ? e.message : e}`);
  }
}

// 一行展示 + 移入浮框看全文。浮框走 host popover（surface=popover 时本页会重载为卡片模式）。
// 老版本 host 不支持 popover 时，点一行用 toast 看全文（可复制）。
function hoverRow(time: string, text: string, full: { title: string; body: string }) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;align-items:baseline;padding:7px 4px;border-bottom:1px solid var(--oc-sdk-edge);';
  if (time) {
    const t = document.createElement('span');
    t.style.cssText = 'font-family:monospace;white-space:nowrap;opacity:0.7;font-size:13px;';
    t.textContent = time;
    row.appendChild(t);
  }
  const tx = document.createElement('span');
  tx.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:14px;';
  row.appendChild(tx);
  mountText(tx, { text });
  try {
    mountPopoverAnchor(row, { host, getData: () => ({ ...full }), width: 380, height: 150 });
  } catch { /* 老 host 不支持 popover，用下面的点击查看 */ }
  row.addEventListener('click', () => void host.toast({ kind: 'info', message: full.body, copy: { text: full.body } }));
  return row;
}

// popover 子框：本页被 host 以 surface=popover 重新载入，用 data 画卡片。
function drawPopoverCard(data: unknown) {
  root.textContent = '';
  const d = (typeof data === 'object' && data !== null ? data : {}) as { title?: string; body?: string };
  if (d.title) {
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:600;margin-bottom:6px;';
    root.appendChild(h);
    mountText(h, { text: d.title });
  }
  const b = document.createElement('div');
  b.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
  root.appendChild(b);
  mountText(b, { text: d.body ?? '（空）' });
  try {
    void host.setHeight(Math.min(420, Math.ceil(root.scrollHeight) + 24));
  } catch { /* 忽略 */ }
}

function humanBytes(n: number): string {
  if (!isFinite(n)) return `${n}B`;
  if (n < 1024) return `${Math.round(n)}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function shortPath(p: string): string {
  const noQ = p.split('?')[0];
  return noQ.length > 42 ? `…${noQ.slice(-41)}` : noQ;
}

// 卡住判定：在途请求停在某个阶段太久（等首字节>20s / 建连>15s / 任一阶段>120s / 总耗时>300s）
function isStuck(a: ReqActive): boolean {
  if (a.stage === '等上游首字节' && a.stuck_s > 20) return true;
  if (a.stage === '建连中' && a.stuck_s > 15) return true;
  if (a.stuck_s > 120 || a.elapsed_s > 300) return true;
  return false;
}

function reqDetail(a: ReqActive | ReqRecent, active: boolean): { title: string; body: string } {
  const first = 'e2e_first_ms' in a ? (a as ReqActive).e2e_first_ms : (a as ReqRecent).first_ms;
  const up = 'up_first_ms' in a ? (a as ReqActive).up_first_ms : (a as ReqRecent).up_ms;
  const body = [
    `#${a.sid} ${a.method} ${a.path}`,
    `模型 ${a.model || '—'} · 路由 ${a.route}`,
    active
      ? `阶段 ${(a as ReqActive).stage} · 已耗时 ${(a as ReqActive).elapsed_s}s · 本阶段停留 ${(a as ReqActive).stuck_s}s`
      : `结果 ${(a as ReqRecent).outcome === 'ok' ? '完成' : (a as ReqRecent).outcome === 'warn' ? '客户端提前断开' : '失败'} · 用时 ${(a as ReqRecent).total_s}s`,
    `建连 ${ms((a as ReqActive).connect_ms ?? null)} · 上游首字节 ${ms(up ?? null)} · 端到端首字节 ${ms(first ?? null)}`,
    `已发 ${humanBytes((a as ReqActive).sent ?? (a as ReqRecent).bytes ?? 0)}`,
    (a as ReqRecent).error ? `错误：${(a as ReqRecent).error}` : '',
  ].filter(Boolean).join('\n');
  return { title: active ? `#${a.sid} 在途请求` : `#${(a as ReqRecent).sid} · ${((a as ReqRecent).at || '最近完成')}`, body };
}

// 小字提示行（14px）
function note(body: HTMLElement, text: string) {
  const d = document.createElement('div');
  d.style.cssText = 'font-size:14px;opacity:0.8;padding:4px 0;';
  body.appendChild(d);
  mountText(d, { text });
}

// 状态区两行只改字不重建（按钮常驻行尾）
function drawState(full: Full) {
  const h = full.health;
  nodeLine.main.textContent = `${clashOpen ? '▾' : '▸'} ${h.autoswitch?.now ?? '未知'}`;
  nodeLine.sub.textContent = '策略组 ' + (h.autoswitch?.group ?? '-') + ' · ' + (h.at ?? '');
  const p = full.process;
  procLine.main.textContent = `${flowOpen ? '▾' : '▸'} 代理服务 · ` + (p ? (p.listening ? '运行中' : '已停止') : '未知');
  procLine.sub.textContent = '';
}

function drawFlow(h: Full['health']) {
  if (!flowOpen) { flowDrop.style.display = 'none'; return; }
  flowDrop.style.display = '';
  flowDrop.textContent = '';
  const actives = (h.requests?.active ?? []).filter((a) => !a.path.startsWith('/zen/go/v1/responses'));
  const recents = (h.requests?.recent ?? []).filter((r) => !r.path.startsWith('/zen/go/v1/responses')).slice(0, 5);
  if (actives.length === 0 && recents.length === 0) {
    note(flowDrop, '当前空闲：无在途请求（opencode 还没发请求，或重启后记录已清零）');
    return;
  }
  const wrap = document.createElement('div');
  flowDrop.appendChild(wrap);
  for (const a of actives) {
    const stuck = isStuck(a);
    const title = `#${a.sid} ${stuck ? '⚠ ' : ''}${a.method} ${shortPath(a.path)} · ${a.stage}${stuck ? '（可能卡住）' : ''}`;
    const sub = `已耗时${a.elapsed_s}s · 本阶段${a.stuck_s}s · 已收${humanBytes(a.sent)} · ${a.route}${a.model ? ` · ${a.model}` : ''}`;
    const row = hoverRow('', `${title.slice(0, 64)} — ${sub}`.slice(0, 96), reqDetail(a, true));
    if (stuck) row.style.background = 'color-mix(in srgb, var(--destructive) 12%, transparent)';
    wrap.appendChild(row);
  }
  for (const r of recents) {
    const icon = r.outcome === 'ok' ? '✓' : r.outcome === 'warn' ? '○' : '✗';
    const title = `#${r.sid} ${icon} ${r.method} ${shortPath(r.path)} · 用时${r.total_s}s · 首字节${ms(r.first_ms)}`;
    const sub = `${r.route}${r.model ? ` · ${r.model}` : ''} · ${humanBytes(r.bytes)}${r.error ? ` · ${r.error.slice(0, 40)}` : ''}`;
    const row = hoverRow('', `${title.slice(0, 64)} — ${sub}`.slice(0, 96), reqDetail(r, false));
    row.style.opacity = r.outcome === 'ok' ? '0.85' : '1';
    if (r.outcome === 'error') row.style.background = 'color-mix(in srgb, var(--destructive) 12%, transparent)';
    wrap.appendChild(row);
  }
}

function drawClash(full: Full) {
  if (!clashOpen) { clashDrop.style.display = 'none'; return; } // 收起：整个下拉隐藏
  clashDrop.style.display = '';
  clashList.textContent = '';
  const c = full.clash;
  if (!c || !c.top?.length) {
    note(clashList, '还没测过：点上面「Clash刷新」做订阅更新 + 全组测速');
    return;
  }
  const wrap = document.createElement('div');
  clashList.appendChild(wrap);
  c.top.forEach((t, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:baseline;padding:7px 4px;border-bottom:1px solid var(--oc-sdk-edge);cursor:pointer;';
    const rank = document.createElement('span');
    rank.style.cssText = 'font-family:monospace;opacity:0.7;font-size:13px;';
    rank.textContent = `#${i + 1}`;
    const tx = document.createElement('span');
    tx.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:14px;';
    row.append(rank, tx);
    mountText(tx, { text: `${t.name} — ${t.delay_ms}ms${t.blocked ? '（禁用）' : ''}` });
    row.title = `切换到 ${t.name}`;
    row.addEventListener('click', () => void switchToNode(t.name));
    wrap.appendChild(row);
  });
}

function draw(full: Full, force = false) {
  const h = full.health;
  if (!h?.reachable) {
    statusBadge.update({ label: '不可达', tone: 'error' });
    nodeLine.main.textContent = '▸ 分流代理不可达';
    nodeLine.sub.textContent = '检查 muse-proxy.service';
    procLine.main.textContent = '▸ 代理服务 · 未知';
    procLine.sub.textContent = '';
    trafficInfo.textContent = '（代理不可达）';
    clashDrop.style.display = 'none';
    flowDrop.style.display = 'none';
    return;
  }
  const stuckN = (h.requests?.active ?? []).filter(isStuck).length;
  const bad = h.autoswitch?.now_blocked || h.preflight?.ok === false;
  if (stuckN > 0) statusBadge.update({ label: `可能卡住×${stuckN}`, tone: 'error' });
  else statusBadge.update({ label: bad ? '异常' : '正常', tone: bad ? 'error' : 'success' });

  drawState(full);
  drawTrafficInfo(h.traffic);

  // 鼠标正停在各区看浮框时不重建 DOM，否则锚点被删导致浮框反复开关
  if (hovering && !force) return;

  drawFlow(h);
  drawClash(full);
  try {
    const hgt = Math.min(700, Math.ceil(root.getBoundingClientRect().height));
    if (Math.abs(hgt - lastHeight) > 8) {
      lastHeight = hgt;
      void host.setHeight(hgt);
    }
  } catch { /* 非面板表面忽略 */ }
}

// 自动刷新 2s 一次（网速/日志要跟手）。鼠标停在各区时跳过重建（浮框开着），
// 鼠标离开后再刷一次；手动操作后强制刷一次。
let hovering = false;
let lastHeight = 0;
for (const box of [flowDrop, clashDrop]) {
  box.addEventListener('mouseenter', () => { hovering = true; });
  box.addEventListener('mouseleave', () => {
    if (!hovering) return;
    hovering = false;
    void load();
  });
}

let booted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (context.surface === 'popover') {
    drawPopoverCard(context.popover?.data);
    return;
  }
  if (booted) { void load(); return; }
  booted = true;
  void load();
  setInterval(() => { void load(); }, 2000);
});
void clashBtn;
void svcBtn;
