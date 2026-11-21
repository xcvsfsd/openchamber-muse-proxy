// 网络代理小面板：五行固定布局（网络代理 / 更新时间 / 代理服务 / 更新时间 / 最新消息）。
import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBadge, mountButton, mountText } from '@openchamber/sdk/ui';

const host = connectHost();

const root = document.querySelector<HTMLElement>('#root')!;

const stateBox = document.createElement('div');
root.append(stateBox);

// 第一行：网络代理 + 状态徽标 + 刷新按钮
const headRow = document.createElement('div');
stateBox.appendChild(headRow);
const headTitle = document.createElement('span');
headTitle.textContent = '网络代理：';
headRow.appendChild(headTitle);
const statusBadge = mountBadge(headRow, { label: '…', tone: 'neutral' });
const refreshBtn = mountButton(headRow, {
  label: '刷新', variant: 'default', size: 'xs',
  onClick: busy({ update: (p: object) => refreshBtn.update(p) }, clashRefresh),
});

// 第二行：测速时间 + Top延迟 + 异常原因
const updClash = document.createElement('div');
stateBox.appendChild(updClash);

// 第三行：代理服务 + 状态徽标 + 重启按钮
const procRow = document.createElement('div');
stateBox.appendChild(procRow);
const procTitle = document.createElement('span');
procTitle.textContent = '代理服务：';
procRow.appendChild(procTitle);
const procBadge = mountBadge(procRow, { label: '…', tone: 'neutral' });
const restartBtn = mountButton(procRow, {
  label: '重启', variant: 'destructive', size: 'xs',
  onClick: busy({ update: (p) => restartBtn.update(p) }, () => act('/status', { id: 'svc' }, '已执行')),
});

// 第四行：最新数据时间 + 累计流量 + 异常原因
const updProc = document.createElement('div');
stateBox.appendChild(updProc);

// 第五行：最新消息（纯文本，不弹框）
const latestBox = document.createElement('div');
stateBox.appendChild(latestBox);

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

async function clashRefresh() {
  try {
    await host.toast({ kind: 'info', message: 'Clash刷新中：订阅更新+全组测速，约10-20秒…' });
    const r = await req('/status', 'POST', { id: 'clash-refresh' });
    if (r.status >= 200 && r.status < 300) {
      const c = (r.json as { clash?: ClashInfo } | null)?.clash;
      await host.toast({ kind: 'success', message: c?.top?.length ? `${c.sub_note ? c.sub_note + '；' : ''}${c.switched_to ? `已自动切到最快 ${c.switched_to}` : `当前已是最快 ${c.top[0].name}`}` : 'Clash刷新完成' });
    } else {
      await host.toast({ kind: 'error', message: String((r.json as { message?: string } | null)?.message ?? 'Clash刷新失败') });
    }
    await load();
  } catch (e) {
    await host.toast({ kind: 'error', message: `请求失败：${e instanceof Error ? e.message : e}` });
    await load();
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
    await load();
  } catch (e) {
    await host.toast({ kind: 'error', message: `请求失败：${e instanceof Error ? e.message : e}` });
  }
}

type Traffic = {
  up_bytes: number; down_bytes: number;
  up_muse: number; down_muse: number;
  up_rate: number; down_rate: number;
  up_window: number; down_window: number; window_s: number;
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
type ClashDelay = { at: string; name: string; delay_ms: number | null } | null;
type ClashInfo = {
  at: string; group: string; now: string; elapsed: number;
  tested: number; switched_to: string; sub_note: string; top: ClashTop[];
};

type Full = {
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
  delay?: ClashDelay;
  process?: { listening: boolean; systemd: string; unit: boolean };
};

// 模型名只显示头部第一个单词：muse-spark → muse，deepseek-chat → deepseek
const shortModel = (m: string): string => (m || '').split(/[-_ ]/)[0] || '—';

async function load() {
  try {
    const f = await req('/full');
    if (f.status !== 200 || !f.json) throw new Error(`full http-${f.status}`);
    const full = f.json as Full;
    draw(full);
  } catch (e) {
    statusBadge.update({ label: '!', tone: 'error' });
    updClash.textContent = '—';
    procBadge.update({ label: '!', tone: 'error' });
    updProc.textContent = '—';
    latestBox.textContent = '';
    mountText(latestBox, { text: `${e instanceof Error ? e.message : String(e)}`.slice(0, 80) });
  }
}

function humanBytes(n: number): string {
  if (!isFinite(n)) return `${n}B`;
  if (n < 1024) return `${Math.round(n)}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

// 卡住判定：在途请求停在某个阶段太久（等首字节>20s / 建连>15s / 任一阶段>120s / 总耗时>300s）
function isStuck(a: ReqActive): boolean {
  if (a.stage === '等上游首字节' && a.stuck_s > 20) return true;
  if (a.stage === '建连中' && a.stuck_s > 15) return true;
  if (a.stuck_s > 120 || a.elapsed_s > 300) return true;
  return false;
}

// 最新消息：每行拆成单元格，用原生 table 对齐各列（无自定义样式）
function latestCells(a: ReqActive | ReqRecent): string[] {
  const icon = 'stage' in a
    ? (isStuck(a) ? '⚠' : '✓')
    : a.outcome === 'ok' ? '✓' : a.outcome === 'warn' ? '○' : '✗';
  const cells = [icon];
  cells.push(`🤖${shortModel(a.model || '—')}`);
  cells.push(`📦${humanBytes('stage' in a ? a.sent : (a.bytes ?? 0))}`);
  cells.push(`⏱${'stage' in a ? a.elapsed_s : a.total_s}s`);
  const first = 'stage' in a ? (a.e2e_first_ms ?? a.up_first_ms) : (a.first_ms ?? a.up_ms);
  cells.push(first == null ? '🥇—' : first < 1000 ? `🥇${first}ms` : `🥇${(first / 1000).toFixed(1)}s`);
  if (!('stage' in a) && a.outcome === 'error' && a.error) cells.push(`⚠️${a.error.slice(0, 32)}`);
  return cells;
}

function draw(full: Full) {
  const h = full.health;
  if (!h?.reachable) {
    statusBadge.update({ label: '✗ 不可达', tone: 'error' });
    updClash.textContent = '— · 原因：分流代理不可达';
    procBadge.update({ label: '✗ 已停止', tone: 'error' });
    updProc.textContent = '—';
    latestBox.textContent = '';
    mountText(latestBox, { text: '暂无' });
    return;
  }
  const actives = h.requests?.active ?? [];
  const recents = h.requests?.recent ?? [];
  const stuckN = actives.filter(isStuck).length;
  const bad = h.autoswitch?.now_blocked || h.preflight?.ok === false;
  const icon = stuckN > 0 ? '⚠' : bad ? '✗' : '✓';
  const stateText = stuckN > 0 ? `可能卡住×${stuckN}` : bad ? '异常' : '正常';
  const tone = stuckN > 0 ? 'warning' : bad ? 'error' : 'success';
  statusBadge.update({ label: `${icon} ${stateText}`, tone });

  const top0 = full.clash?.top?.[0];
  // 延迟优先用 service 每 60s 刷新的单节点实测（定时刷新），没有才回退到 Top 数据
  const liveMs = full.delay && typeof full.delay.delay_ms === 'number' ? full.delay.delay_ms : null;
  const showMs = liveMs ?? top0?.delay_ms;
  const clashAt = full.clash?.at ? full.clash.at.slice(11) : '—';
  let netCause = '';
  if (stuckN > 0) netCause = '在途请求卡住';
  else if (h.autoswitch?.now_blocked) netCause = '当前节点被禁用';
  else if (h.preflight && h.preflight.ok === false) netCause = '探活失败';
  let line2 = clashAt;
  if (showMs != null) line2 += ` 延迟:${showMs}ms`;
  if (netCause) line2 += ` · 原因：${netCause}`;
  updClash.textContent = line2;

  const p = full.process;
  const running = !!p?.listening;
  procBadge.update({ label: running ? '✓ 正常' : '✗ 已停止', tone: running ? 'success' : 'error' });
  const t = h.traffic;

  const latests = [...actives, ...recents].sort((a, b) => Number(b.sid) - Number(a.sid)).slice(0, 5);
  const latest = latests[0];
  const updTime = latest && !('stage' in latest) && latest.at ? (latest.at.slice(11) || latest.at) : (h.at ? h.at.slice(11) : '—');
  let line4 = updTime;
  if (t) line4 += ` 累计:${humanBytes(t.up_bytes + t.down_bytes)}`;
  if (!running) line4 += ' · 原因：代理进程未运行';
  updProc.textContent = line4;


  latestBox.textContent = '';
  if (latests.length === 0) {
    mountText(latestBox, { text: '暂无' });
  } else {
    const table = document.createElement('table');
    latestBox.appendChild(table);
    for (const r of latests) {
      const tr = document.createElement('tr');
      table.appendChild(tr);
      for (const cell of latestCells(r)) {
        const td = document.createElement('td');
        tr.appendChild(td);
        mountText(td, { text: cell });
      }
    }
  }
  try {
    const hgt = Math.ceil(root.getBoundingClientRect().height);
    if (Math.abs(hgt - lastHeight) > 8) {
      lastHeight = hgt;
      void host.setHeight(hgt);
    }
  } catch { /* 非面板表面忽略 */ }
}

// 自动刷新 1s 一次；手动操作后强制刷一次。
let lastHeight = 0;

let booted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (booted) { void load(); return; }
  booted = true;
  // 清掉旧版本发布过的标题栏控件（本版不再使用标题栏）
  try { void host.setStatusControls([]); } catch { /* 老宿主不支持就忽略 */ }
  void load();
  setInterval(() => { void load(); }, 1000);
});
void refreshBtn;
void restartBtn;
