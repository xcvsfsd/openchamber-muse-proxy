# openchamber-muse-proxy

muse 分流代理（`~/.local/bin/muse-proxy`）的 OpenChamber 扩展：工作区状态条 + 详情面板。

- 状态条：当前节点 / 探活结果 / 最近异常，带「换节点」「探活」按钮
- 面板：超时配置、探活统计、最近异常与换节点记录，可操作

## 构建

```bash
bun run build
```

输出 `panel/main.js`、`service/main.js` 必须提交（安装时不构建）。
