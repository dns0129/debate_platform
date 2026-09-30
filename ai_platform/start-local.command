#!/bin/bash
# AI 辩论模拟平台 · 本地一键启动
# 在 Finder 中双击即可运行；关闭窗口或按 Ctrl+C 停止服务。
#
# 做的事情：
#   1. 检查 Node.js（需要 18+）
#   2. 首次运行或 package.json 变更后自动安装依赖（旧淘宝镜像失效时自动换 npmmirror）
#   3. 没有 .env 时从 .env.example 创建；一个模型 API Key 都没有配置时可当场输入 DeepSeek Key 或选择演示模式；
#      博查 API Key 同样可当场输入
#   4. 端口被占用时自动顺延；平台已在运行则直接打开浏览器
#   5. 服务就绪后自动打开浏览器

cd "$(dirname "$0")" || exit 1
# 双击运行时不一定加载用户的 shell 配置，补上 Homebrew 常见路径
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
printf '\033]0;AI 辩论模拟平台\007'

MIRROR="https://registry.npmmirror.com"

info() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
pause_exit() {
  echo
  read -n 1 -s -r -p "按任意键关闭窗口…"
  echo
  exit "${1:-0}"
}
fail() {
  printf '\033[1;31m✗\033[0m %s\n' "$*"
  pause_exit 1
}

# 读取 .env 中的值（去掉首尾引号与空白）
env_get() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- |
    sed -e "s/^[\"']//" -e "s/[\"'][[:space:]]*$//" -e 's/[[:space:]]*$//'
}

# 原位替换 .env 中的键，不存在则追加
env_set() {
  local tmp
  tmp=$(mktemp) || fail "无法写入 .env"
  awk -v k="$1" -v v="$2" '
    $0 ~ "^" k "=" { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env >"$tmp" && mv "$tmp" .env
}

# 环境变量或 .env 里有这个密钥
has_key() { [ -n "${!1}" ] || [ -n "$(env_get "$1")" ]; }

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
# 通过 /api/config 的返回判断端口上跑的是不是本平台
is_platform() { curl -fs --max-time 1 "http://localhost:$1/api/config" 2>/dev/null | grep -q '"judges"'; }

echo
echo "================  AI 辩论模拟平台  ================"
echo

# ---------- 1. Node.js ----------
command -v node >/dev/null 2>&1 || fail "未找到 Node.js，请先安装：https://nodejs.org 或 brew install node"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 18 ] || fail "Node.js 版本过低（当前 $(node -v)，需要 18 及以上）"
info "Node.js $(node -v)"

# ---------- 2. 依赖 ----------
if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ]; then
  info "安装依赖…"
  registry=$(npm config get registry 2>/dev/null)
  if [[ "$registry" == *registry.npm.taobao.org* ]]; then
    warn "检测到已停用的旧淘宝镜像，本次改用 $MIRROR"
    npm install --registry="$MIRROR" || fail "依赖安装失败，请检查网络"
  elif ! npm install; then
    warn "安装失败，改用 $MIRROR 重试…"
    npm install --registry="$MIRROR" || fail "依赖安装失败，请检查网络"
  fi
fi
[ -x node_modules/.bin/tsx ] || fail "依赖不完整，请删除 node_modules 后重新运行"

# ---------- 3. 端口 ----------
port=$(env_get PORT)
[[ "$port" =~ ^[0-9]+$ ]] || port=3000
while port_in_use "$port"; do
  if is_platform "$port"; then
    info "平台已在运行：http://localhost:$port ，直接打开浏览器"
    open "http://localhost:$port"
    sleep 1
    exit 0
  fi
  warn "端口 $port 已被其他程序占用，尝试 $((port + 1))"
  port=$((port + 1))
done

# ---------- 4. 配置与运行模式 ----------
if [ ! -f .env ]; then
  cp .env.example .env
  info "已根据 .env.example 创建 .env"
fi

mock=0
if [ "$(env_get DEBATE_MOCK)" = "1" ]; then
  mock=1
elif ! has_key DEEPSEEK_API_KEY && ! has_key ZHIPU_API_KEY && ! has_key DASHSCOPE_API_KEY; then
  echo
  warn "尚未配置任何模型 API Key（DeepSeek / 智谱 / 千问，智谱和千问的 Key 请直接写入 .env）"
  echo "  1) 现在输入 API Key（保存到 .env）"
  echo "  2) 以演示模式启动（不调用 API、不联网，内容为占位数据）"
  echo "  3) 退出"
  read -r -p "请选择 [1/2/3]：" choice
  case "$choice" in
    1)
      read -r -s -p "粘贴 DeepSeek API Key（输入不会显示）：" key
      echo
      [ -n "$key" ] || fail "未输入 API Key"
      env_set DEEPSEEK_API_KEY "$key"
      chmod 600 .env
      info "已保存到 .env"
      ;;
    2) mock=1 ;;
    *) exit 0 ;;
  esac
fi

# 博查搜索是可选项：不配置则跳过资料检索，辩手只能进行推理论证
if [ "$mock" = "0" ] && [ -z "$BOCHA_API_KEY" ] && [ -z "$(env_get BOCHA_API_KEY)" ]; then
  echo
  warn "尚未配置 BOCHA_API_KEY（博查搜索，研究员联网检索用）"
  read -r -s -p "粘贴博查 API Key（输入不会显示，直接回车则跳过联网检索）：" key
  echo
  if [ -n "$key" ]; then
    env_set BOCHA_API_KEY "$key"
    chmod 600 .env
    info "已保存到 .env"
  fi
fi

# ---------- 5. 启动 ----------
url="http://localhost:$port"
echo
if [ "$mock" = "1" ]; then
  info "模式：演示模式（不调用 API）"
else
  debate_model=$(env_get DEBATE_MODEL)
  judge_model=$(env_get JUDGE_MODEL)
  search="未配置"
  [ -n "$BOCHA_API_KEY" ] || [ -n "$(env_get BOCHA_API_KEY)" ] && search="博查"
  info "模式：正式模式（默认辩手模型 ${debate_model:-deepseek-flash}，可在页面上按队伍更换；裁判 ${judge_model:-deepseek-flash}；联网搜索：${search}）"
fi
info "地址：$url"
info "关闭此窗口或按 Ctrl+C 即可停止服务"
echo

# 后台等待服务就绪后打开浏览器（最多等 30 秒）
(
  for _ in $(seq 1 60); do
    sleep 0.5
    if is_platform "$port"; then
      open "$url"
      exit 0
    fi
  done
) &
opener=$!
trap 'kill "$opener" 2>/dev/null' EXIT

PORT="$port" DEBATE_MOCK="$mock" ./node_modules/.bin/tsx src/server.ts
code=$?

# Ctrl+C（130）属于正常停止；其他非零退出码说明服务异常，保留窗口方便查看报错
if [ "$code" -ne 0 ] && [ "$code" -ne 130 ]; then
  echo
  warn "服务异常退出（退出码 ${code}），请查看上方报错信息"
  pause_exit "$code"
fi
