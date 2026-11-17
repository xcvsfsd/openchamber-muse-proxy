// Muse 代理面板：状态一览 + 最近日志 + 操作按钮 + 历史记录。
import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBadge, mountButton, mountEmpty, mountList, mountSeparator, mountText } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;
root.style.padding = '12px';
root.style.display = 'flex';
root.style.flexDirection = 'column';
root.style.gap = '10px';

const headBox = document.createElement('div');
headBox.style.display = 'flex';
headBox.style.alignItems = 'center';
headBox.style.gap = '8px';
const btnRow = document.createElement('div');
btnRow.style.display = 'flex';
btnRow.style.gap = '8px';
btnRow.style.flexWrap = 'wrap';
const stateBox = document.createElement('div');
const logBox = document.createElement('div');
const histBox = document.createElement('div');
root.append(headBox, btnRow, stateBox, logBox, histBox);

mountText(headBox, { text: 'Muse 分流代理' });
const statusBadge = mountBadge(headBox, { label: '…', tone: 'neutral' });

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

const switchBtn = mountButton(btnRow, {
  label: '换节点', variant: 'default', size: 'sm',
  onClick: busy({ update: (p) => switchBtn.update(p) }, async () => {
    const r = await req('/status', 'POST', { id: 'switch' });
    await toastResult(r, '已换节点');
  }),
});
const probeBtn = mountButton(btnRow, {
  label: '立即探活', variant: 'secondary', size: 'sm',
  onClick: busy({ update: (p) => probeBtn.update(p) }, async () => {
    const r = await req('/status', 'POST', { id: 'probe' });
    await toastResult(r, '探活完成');
  }),
});
const svcBtn = mountButton(btnRow, {
  label: '重启/拉起', variant: 'destructive', size: 'sm',
  onClick: busy({ update: (p) => svcBtn.update(p) }, async () => {
    const r = await req('/status', 'POST', { id: 'svc' });
    await toastResult(r, '已执行');
  }),
});
const refreshBtn = mountButton(btnRow, {
  label: '刷新', variant: 'outline', size: 'sm',
  onClick: () => void load(),
});

async function toastResult(r: { status: number; json: unknown }, okMsg: string) {
  if (r.status >= 200 && r.status < 300) {
    await host.toast({ kind: 'success', message: okMsg });
    await load();
  } else {
    await host.toast({ kind: 'error', message: String((r.json as { message?: string } | null)?.message ?? '操作失败') });
  }
}

type Streams = {
  active: number; longest_active_s: number; closed: number;
  last_closed_s: number; errors: number;
  last_e2e_first_ms: number | null; last_up_first_ms: number | null;
};

type Full = {
  health: {
    reachable: boolean; at: string; proxy: string;
    timeouts: Record<string, number>;
    preflight: { ok: boolean; err: string; runs: number; failures: number };
    autoswitch: { enabled: boolean; group: string; now: string; now_blocked: boolean };
    last_error: { time: string; error: string };
    streams?: Streams;
  };
  history: { switches: string[]; errors: string[] };
  process?: { listening: boolean; systemd: string; unit: boolean };
};

const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}ms`);

// 五项流指标合成一行：标题放两个首字节，副标题放计数，异常/在用时挂徽标。
// 注意 streams 在 health 里面（service 原样透传 __health），不是顶层。
function streamRow(h: { streams?: Streams }) {
  const s = h.streams;
  const item: { id: string; title: string; subtitle: string; meta: string; badge?: { label: string; tone: 'error' | 'info' } } = {
    id: 'streams',
    title: `首字节 ${ms(s?.last_e2e_first_ms)} / 上游 ${ms(s?.last_up_first_ms)}`,
    subtitle: `在用 ${s?.active ?? 0} · 已关 ${s?.closed ?? 0} · 异常 ${s?.errors ?? 0}`,
    meta: (s?.active ?? 0) > 0 ? `最长${s?.longest_active_s ?? 0}s` : '',
  };
  if ((s?.errors ?? 0) > 0) item.badge = { label: `异常${s?.errors}`, tone: 'error' };
  else if ((s?.active ?? 0) > 0) item.badge = { label: `在用${s?.active}`, tone: 'info' };
  return item;
}

async function load() {
  try {
    const [f, l] = await Promise.all([req('/full'), req('/logs?lines=5')]);
    if (f.status !== 200 || !f.json) throw new Error(`full http-${f.status}`);
    draw(f.json as Full, (l.json as { lines?: string[] } | null)?.lines ?? []);
  } catch (e) {
    stateBox.textContent = '';
    mountText(stateBox, { text: `服务不可用：${e instanceof Error ? e.message : e}` });
  }
}

function logTone(line: string): 'success' | 'error' | 'info' | 'neutral' {
  if (/失败|中断|禁用|502|504| 40[013]| 403|RegionError|降级/.test(line)) return 'error';
  if (/换节点|探活|手动/.test(line)) return 'info';
  if (/完成|200/.test(line)) return 'success';
  return 'neutral';
}

function splitLog(line: string): { time: string; rest: string } {
  const m = /^(\d{2}:\d{2}:\d{2})\s?(.*)$/.exec(line);
  const rest = (m ? m[2] : line).replace(/(\d+(?:\.\d+)?)B\b/g, (_, n: string) => humanBytes(Number(n)));
  return m ? { time: m[1], rest: rest.slice(0, 140) } : { time: '', rest: rest.slice(0, 140) };
}

function humanBytes(n: number): string {
  if (!isFinite(n)) return `${n}B`;
  if (n < 1024) return `${Math.round(n)}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function draw(full: Full, logs: string[]) {
  const h = full.health;
  stateBox.textContent = '';
  logBox.textContent = '';
  histBox.textContent = '';
  if (!h?.reachable) {
    statusBadge.update({ label: '不可达', tone: 'error' });
    mountText(stateBox, { text: '分流代理不可达：检查 muse-proxy.service' });
    return;
  }
  const bad = h.autoswitch?.now_blocked || h.preflight?.ok === false;
  statusBadge.update({ label: bad ? '异常' : '正常', tone: bad ? 'error' : 'success' });

  mountText(stateBox, { text: '状态' });
  mountList(stateBox, {
    ariaLabel: '代理状态',
    onSelect: () => {},
    items: [
      { id: 'node', title: h.autoswitch?.now ?? '未知', subtitle: `策略组 ${h.autoswitch?.group ?? '-'}`, meta: h.at ?? '' },
      { id: 'proc', title: full.process ? (full.process.listening ? '代理进程运行中' : '代理进程已停止') : '进程状态未知', subtitle: full.process ? `systemd ${full.process.systemd}·unit${full.process.unit ? '已注册' : '未注册'}` : '', meta: '' },
      { id: 'probe', title: h.preflight?.ok ? '探活正常' : `探活失败 ${h.preflight?.err ?? ''}`, subtitle: `成功 ${h.preflight?.runs ?? 0} / 失败 ${h.preflight?.failures ?? 0}`, meta: '' },
      streamRow(h),
      { id: 'err', title: h.last_error?.time ? `最近异常 ${h.last_error.time}` : '暂无异常', subtitle: (h.last_error?.error ?? '').slice(0, 120), meta: '' },
    ],
  });

  mountSeparator(logBox, {});
  mountText(logBox, { text: '最近日志' });
  if (logs.length === 0) {
    mountEmpty(logBox, { title: '暂无日志' });
  } else {
    mountList(logBox, {
      ariaLabel: '最近日志',
      onSelect: () => {},
      items: logs.map((line, i) => {
        const { time, rest } = splitLog(line);
        const tone = logTone(line);
        return tone === 'neutral'
          ? { id: `l${i}`, title: rest, subtitle: '', meta: time, leading: '' }
          : { id: `l${i}`, title: rest, subtitle: '', meta: time, badge: { label: tone === 'error' ? '异常' : tone === 'info' ? '操作' : '正常', tone } };
      }),
    });
  }

  mountSeparator(histBox, {});
  mountText(histBox, { text: '换节点与异常记录' });
  const items = [
    ...(full.history?.switches ?? []).map((s, i) => ({ id: `s${i}`, title: s, subtitle: '换节点', meta: '' })),
    ...(full.history?.errors ?? []).map((s, i) => ({ id: `e${i}`, title: s.slice(0, 120), subtitle: '异常', meta: '' })),
  ];
  if (items.length === 0) {
    mountText(histBox, { text: '暂无记录' });
  } else {
    mountList(histBox, { ariaLabel: '历史记录', onSelect: () => {}, items: items.slice(0, 5) });
  }
  try {
    void host.setHeight(Math.min(700, Math.ceil(root.getBoundingClientRect().height)));
  } catch { /* 非面板表面忽略 */ }
}

let booted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (booted) { void load(); return; }
  booted = true;
  void load();
  setInterval(() => { void load(); }, 15000);
});
void refreshBtn;
void switchBtn;
void probeBtn;
void svcBtn;
