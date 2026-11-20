# openchamber-muse-proxy

muse 分流代理（`~/.local/bin/muse-proxy`）的 OpenChamber 扩展：Rail 面板 + 后台 service。
按请求体 `model` 以 muse 开头走代理，其余直连，只监听 127.0.0.1。

![Muse 代理面板](screenshot.png)

## 面板

2s 自动刷，探活/刷新全自动；无顶栏标题，徽标跟在状态后。

- 状态：当前节点行尾挂绿色 [Clash刷新]，点行展开/收起 Clash 测速 Top 下拉
  （默认收起，下拉内只有 Top 列表，点行可手动换）；代理服务行尾挂蓝色 [重启/拉起]
- 状态行尾速率：`↑ x/s ↓ y/s 🌴 累计总量`
- 日志（收进代理服务下拉，近 5 条，`#sid` 唯一标识，无时间列，
  过滤 `/zen/go/v1/responses` 噪音）：在途阶段追踪，卡住标红，徽标同步告警
- Clash刷新：订阅更新（逐个 PUT provider）+ 全组并行测速，
  刷完自动切到最快节点并展开下拉
- 底部：上次刷新时间 + 版本号（service 运行时读包内 package.json）

## 说明

- 切节点只影响新建连接，在途流不受影响；香港节点对 muse 不可用，测速自动排除
- 流量/流程记录只记内存，重启清零

## 迁移到新机器

脚本唯一真相在 `vendor/muse-proxy.py`，一键安装：

```bash
./scripts/install.sh [--proxy 宿主机:7897] [--ctl 宿主机:9097]
```

做四件事：拷脚本到 `~/.local/bin`（自动备份旧的）、写 `~/.config/muse-proxy/env`、
注册 systemd user 服务并启动、健康检查。有 systemd 才注册服务，
无 systemd 的机器装完扩展后在面板点「重启/拉起」即可。

`opencode.json` 默认不碰，装完按脚本最后打印的片段手动合
`provider.opencode-go.options.baseURL = http://127.0.0.1:8788/zen/go/v1`。

## 构建

```bash
bun run build
```

输出 `panel/main.js`、`service/main.js` 必须提交（安装时不构建）。
