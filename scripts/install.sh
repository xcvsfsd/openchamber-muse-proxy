#!/bin/bash
# muse-proxy 一键安装：拷脚本、写配置、注册 systemd user 服务并启动。
# 幂等，可反复跑；默认不碰 opencode.json（加 --patch-opencode 才写）。
# 用法: ./scripts/install.sh [--proxy 192.168.34.201:7897] [--ctl 192.168.34.201:9097] [--patch-opencode] [--force]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HOME/.local/bin/muse-proxy"
ENV_DIR="$HOME/.config/muse-proxy"
ENV_FILE="$ENV_DIR/env"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/muse-proxy.service"

PROXY="192.168.34.201:7897"
CTL="192.168.34.201:9097"
PATCH_OPENCODE=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --proxy) PROXY="$2"; shift 2;;
    --ctl) CTL="$2"; shift 2;;
    --patch-opencode) PATCH_OPENCODE=1; shift;;
    --force) FORCE=1; shift;;
    *) echo "未知参数: $1" >&2; exit 1;;
  esac
done

command -v python3 >/dev/null || { echo "缺 python3，先装" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "无 systemctl（非 systemd 机器）：只拷脚本，改用插件面板「拉起代理」" >&2; HAS_SYSTEMD=0; }
HAS_SYSTEMD="${HAS_SYSTEMD:-1}"
TS="$(date +%Y%m%d-%H%M%S)"

echo "== 1/4 部署脚本 =="
mkdir -p "$(dirname "$BIN")"
[ -f "$BIN" ] && cp -a "$BIN" "$BIN.bak.$TS" && echo "已备份 $BIN.bak.$TS"
cp -a "$REPO_DIR/vendor/muse-proxy.py" "$BIN" && chmod +x "$BIN"
python3 -m py_compile "$BIN" && echo "语法 OK: $BIN"

echo "== 2/4 写配置 $ENV_FILE =="
mkdir -p "$ENV_DIR"
if [ -f "$ENV_FILE" ] && [ "$FORCE" -eq 0 ]; then
  echo "已存在，不覆盖（--force 可覆写）"
else
  cat > "$ENV_FILE" <<EOF
# muse-proxy 机器相关配置（install.sh 生成）
MUSE_PROXY_HTTP=$PROXY
MUSE_PROXY_CTL=$CTL
EOF
  echo "已写入"
fi

if [ "$HAS_SYSTEMD" -eq 1 ]; then
  echo "== 3/4 注册 systemd user 服务 =="
  mkdir -p "$UNIT_DIR"
  [ -f "$UNIT" ] && cp -a "$UNIT" "$UNIT.bak.$TS" && echo "已备份 unit"
  sed -e "s|@BIN@|$BIN|" "$REPO_DIR/scripts/muse-proxy.service.tpl" > "$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now muse-proxy.service
  if [ "$(loginctl show-user "$USER" 2>/dev/null | grep -c 'Linger=yes' || true)" -eq 0 ]; then
    echo "提示：未开 linger，开机自启需 sudo loginctl enable-linger $USER"
  fi
  sleep 1
  systemctl --user is-active muse-proxy.service
  echo "== 4/4 健康检查 =="
  curl -s -m 5 http://127.0.0.1:8788/__health | python3 -m json.tool | head -n 12
else
  echo "== 跳过 systemd：请在 OpenChamber 插件面板点「拉起代理」 =="
fi

if [ "$PATCH_OPENCODE" -eq 1 ]; then
  echo "== opencode.json 未自动改：把下面这段合进 provider 里 =="
fi
cat <<'EOF'
# opencode.json 需要含（没有就加，有就跳过）：
  "provider": {
    "opencode-go": { "options": { "baseURL": "http://127.0.0.1:8788/zen/go/v1" } }
  },
EOF
echo "完成。"
