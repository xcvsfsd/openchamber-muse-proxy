[Unit]
Description=muse-proxy: OpenCode 本地分流代理（muse 走代理，其他直连）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/muse-proxy/env
ExecStart=@BIN@
Restart=always
RestartSec=3
StandardOutput=append:%h/.local/share/muse-proxy.log
StandardError=append:%h/.local/share/muse-proxy.log

[Install]
WantedBy=default.target
