# openchamber-muse-proxy

muse 分流代理（`~/.local/bin/muse-proxy`）的 OpenChamber 扩展：状态栏小面板 + 后台 service。
按请求体 `model` 以 muse 开头走代理，其余直连，只监听 127.0.0.1。

![网络代理面板](screenshot.png)

## 小面板

网速/状态/日志同频，1s 自动刷；探活/刷新全自动；字号与按钮与其他插件一致（标题 14px，行文 12-13px，行距收紧，按钮 xs 紧凑档）；
标题栏两个控件（与 git 插件一致）：`✓` + `↑下行 ↓上行`（分开才放得下宿主每控件 5rem 限宽；点网速=立即刷新），无“状态”分区头，无底部版本号行。
内容区无网速行：节点行 → 代理服务行。长内容自动换行显示，不截断（节点名/日志/测速名）。

- 状态行：节点行尾 ↻ 刷新（订阅更新+全组测速约 10-20s，刷完自动切最快），点行展开 Top 下拉，点行切节点；
  代理服务行尾 ↻ 重启，点行展开日志下拉
- 日志近 5 条，`#sid` 唯一标识，无时间列，异常整行红字

## 说明

- 切节点只影响新建连接，在途流不受影响；香港节点对 muse 不可用，测速自动排除
- 流量/日志记录只记内存，重启清零

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

输出 `status/main.js`、`service/main.js` 必须提交（安装时不构建）。
