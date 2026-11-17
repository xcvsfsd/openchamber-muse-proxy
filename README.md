# openchamber-muse-proxy

muse 分流代理（`~/.local/bin/muse-proxy`）的 OpenChamber 扩展：Rail 面板 + 后台 service。

![Muse 代理面板](screenshot.png)

- 状态条：当前节点 / 探活结果 / 最近异常 / 代理进程，带换节点、探活、重启/拉起按钮
- 面板：超时配置、探活统计、进程状态、最近异常与换节点记录，可操作

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
