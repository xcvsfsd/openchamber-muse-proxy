// Muse 代理面板：状态一览 + 换节点/探活按钮 + 最近异常与换节点记录。
import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBadge, mountButton, mountList, mountSeparator, mountText } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;
root.style.padding = '12px';
root.style.display = 'flex';
root.style.flexDirection = 'column';
root.style.gap = '8px';

const statusBox = document.createElement('div');
const btnRow = document.createElement('div');
btnRow.style.display = 'flex';
btnRow.style.gap = '8px';
const listBox = document.createElement('div');
const histBox = document.createElement('div');
root.append(statusBox, btnRow, listBox, histBox);

mountText(statusBox, { text: '加载中…' });
const refreshBtn = mountButton(btnRow, { label: '刷新', variant: 'outline', size: 'sm', onClick: () => void load() });
const switchBtn = mountButton(btnRow, {
  label: '换节点', variant: 'outline', size: 'sm',
  onClick: () => void act('/status', { id: 'switch' }, '已换节点'),
});
const probeBtn = mountButton(btnRow, {
  label: '立即探活', variant: 'outline', size: 'sm',
  onClick: () => void act('/status', { id: 'probe' }, '探活完成'),
});
const svcBtn = mountButton(btnRow, {
  label: '重启/拉起', variant: 'outline', size: 'sm',
  onClick: () => void act('/status', { id: 'svc' }, '已执行'),
});

async function req(path: string, method = 'GET', body?: unknown) {
  const r = await host.serviceRequest({ method: method as 'GET', path, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: r.body ? JSON.parse(r.body) : null };
}

async function act(path: string, body: unknown, okMsg: string) {
  try {
    const r = await req(path, 'POST', body);
    if (r.status >= 200 && r.status < 300) {
      await host.toast({ kind: 'success', message: okMsg });
      await load();
    } else {
      await host.toast({ kind: 'error', message: String((r.json as { message?: string })?.message ?? '操作失败') });
    }
  } catch (e) {
    await host.toast({ kind: 'error', message: `请求失败：${e instanceof Error ? e.message : e}` });
  }
}

async function load() {
  try {
    const r = await req('/full');
    if (r.status !== 200 || !r.json) throw new Error(`http-${r.status}`);
    draw(r.json as { health: Record<string, unknown>; history: { switches: string[]; errors: string[] }; process?: { listening: boolean; systemd: string; unit: boolean } });
  } catch (e) {
    statusBox.textContent = '';
    mountText(statusBox, { text: `服务不可用：${e instanceof Error ? e.message : e}` });
  }
}

function draw(full: { health: Record<string, unknown>; history: { switches: string[]; errors: string[] }; process?: { listening: boolean; systemd: string; unit: boolean } }) {
  const h = full.health as {
    reachable: boolean; at: string; proxy: string; timeouts: Record<string, number>;
    preflight: { ok: boolean; err: string; runs: number; failures: number };
    autoswitch: { enabled: boolean; group: string; now: string; now_blocked: boolean };
    last_error: { time: string; error: string };
  };
  statusBox.textContent = '';
  histBox.textContent = '';
  listBox.textContent = '';
  if (!h?.reachable) {
    mountText(statusBox, { text: '分流代理不可达：检查 muse-proxy.service' });
    return;
  }
  mountBadge(statusBox, { label: h.autoswitch?.now_blocked ? '节点已禁用' : h.preflight?.ok === false ? '探活失败' : '正常', tone: h.autoswitch?.now_blocked || h.preflight?.ok === false ? 'error' : 'success' });
  const ps = full.process;
  mountList(listBox, {
    ariaLabel: '代理状态',
    onSelect: () => {},
    items: [
      { id: 'node', title: h.autoswitch?.now ?? '未知', subtitle: `策略组 ${h.autoswitch?.group ?? '-'}`, meta: h.at ?? '' },
      { id: 'proc', title: ps ? (ps.listening ? '代理进程运行中' : '代理进程已停止') : '进程状态未知', subtitle: ps ? `systemd ${ps.systemd}·unit${ps.unit ? '已注册' : '未注册'}` : '', meta: '' },
      { id: 'probe', title: h.preflight?.ok ? '探活正常' : `探活失败 ${h.preflight?.err ?? ''}`, subtitle: `成功 ${h.preflight?.runs ?? 0} / 失败 ${h.preflight?.failures ?? 0}`, meta: '' },
      { id: 'timeout', title: '超时 建连/首字节/流空闲', subtitle: `${h.timeouts?.connect ?? '-'}/${h.timeouts?.first_byte ?? '-'}（首字节）/${h.timeouts?.stream_idle ?? '-'}s`, meta: '' },
      { id: 'err', title: h.last_error?.time ? `最近异常 ${h.last_error.time}` : '暂无异常', subtitle: (h.last_error?.error ?? '').slice(0, 120), meta: '' },
    ],
  });
  mountSeparator(histBox, {});
  const items = [
    ...(full.history?.switches ?? []).map((s, i) => ({ id: `s${i}`, title: s, subtitle: '换节点', meta: '' })),
    ...(full.history?.errors ?? []).map((s, i) => ({ id: `e${i}`, title: s.slice(0, 120), subtitle: '异常', meta: '' })),
  ];
  if (items.length === 0) {
    mountText(histBox, { text: '暂无换节点与异常记录' });
  } else {
    mountList(histBox, { ariaLabel: '历史记录', onSelect: () => {}, items: items.slice(0, 20) });
  }
  try {
    void host.setHeight(Math.min(600, Math.ceil(root.getBoundingClientRect().height)));
  } catch { /* 非面板表面忽略 */ }
}

let booted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (booted) { void load(); return; }
  booted = true;
  void load();
  setInterval(() => { void load(); }, 20000);
});
void refreshBtn;
void switchBtn;
void probeBtn;
void svcBtn;
