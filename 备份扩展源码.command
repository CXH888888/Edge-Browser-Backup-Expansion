#!/bin/bash
# 备份扩展源码到 <插件目录>/backups/扩展源码/
#
# Edge / Chrome 的 Extensions 目录位于浏览器配置目录内，
# 浏览器按设计不允许扩展通过 showDirectoryPicker 授权该路径
# （会提示「此文件夹包含系统文件」），所以改由这个脚本在沙箱外复制。
#
# 用法：双击运行即可；也可以在终端里执行 ./备份扩展源码.command

set -u

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_ROOT="$PLUGIN_DIR/backups"
DEST="$BACKUP_ROOT/扩展源码"

say() { printf '%s\n' "$*"; }

say "插件目录：$PLUGIN_DIR"
say "备份目标：$DEST"
say ""

if ! mkdir -p "$DEST" "$BACKUP_ROOT/完整备份"; then
  say "✗ 无法创建备份目录，请确认插件所在位置可写。"
  say ""
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

# 把绝对路径留给插件界面显示（浏览器拿不到路径，脚本可以）
printf '%s\n' "$PLUGIN_DIR" > "$BACKUP_ROOT/位置.txt"

SOURCES=()
for root in \
  "$HOME/Library/Application Support/Microsoft Edge" \
  "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/Chromium" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
do
  [ -d "$root" ] || continue
  while IFS= read -r d; do
    [ -n "$d" ] && SOURCES+=("$d")
  done < <(find "$root" -maxdepth 3 -type d -name Extensions 2>/dev/null)
done

if [ ${#SOURCES[@]} -eq 0 ]; then
  say "✗ 没找到任何 Extensions 目录。"
  say "  预期位置：~/Library/Application Support/Microsoft Edge/Default/Extensions"
  say ""
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

read_name() {
  python3 - "$1" <<'PY' 2>/dev/null
import json, os, sys

d = sys.argv[1]
name, version = '', ''
try:
    with open(os.path.join(d, 'manifest.json'), encoding='utf-8') as f:
        m = json.load(f)
    name = m.get('name') or ''
    version = m.get('version') or ''
    if isinstance(name, str) and name.startswith('__MSG_') and name.endswith('__'):
        key = name[6:-2]
        locs = []
        dl = m.get('default_locale')
        if dl:
            locs.append(dl)
        locs += ['zh_CN', 'zh', 'en', 'en_US']
        base = os.path.join(d, '_locales')
        try:
            locs += sorted(os.listdir(base))
        except Exception:
            pass
        seen = set()
        found = ''
        for loc in locs:
            if loc in seen:
                continue
            seen.add(loc)
            path = os.path.join(base, loc, 'messages.json')
            if not os.path.isfile(path):
                continue
            try:
                with open(path, encoding='utf-8') as f:
                    node = json.load(f).get(key)
                if isinstance(node, dict) and node.get('message'):
                    found = node['message']
                    break
            except Exception:
                continue
        name = found or key
except Exception:
    pass
print((name or '').replace('\t', ' '), version, sep='\t')
PY
}

copied=0
skipped=0
failed=0

for src in "${SOURCES[@]}"; do
  say "读取：$src"
  for id_dir in "$src"/*; do
    [ -d "$id_dir" ] || continue
    id="$(basename "$id_dir")"
    case "$id" in
      _metadata|Temp|temp) continue ;;
    esac

    ver_dir=""
    for v in "$id_dir"/*; do
      [ -d "$v" ] || continue
      case "$(basename "$v")" in
        _metadata) continue ;;
      esac
      if [ -z "$ver_dir" ] || [ "$v" -nt "$ver_dir" ]; then
        ver_dir="$v"
      fi
    done

    if [ -z "$ver_dir" ]; then
      skipped=$((skipped + 1))
      continue
    fi

    info="$(read_name "$ver_dir")"
    name="$(printf '%s' "$info" | cut -f1)"
    version="$(printf '%s' "$info" | cut -f2)"
    [ -n "$name" ] || name="$id"

    safe="$(printf '%s' "$name" | tr '/\\:*?"<>|' '________' | cut -c1-60)"
    [ -n "$safe" ] || safe="$id"

    id8="${id:0:8}"
    folder="$safe-$id8"
    target="$DEST/$folder"

    # 名称解析更新或扩展改名后，同一 ID 的旧副本先清掉，避免出现两份
    for old in "$DEST"/*-"$id8"; do
      [ -d "$old" ] || continue
      rm -rf "$old"
    done

    if cp -R "$ver_dir" "$target" 2>/dev/null; then
      copied=$((copied + 1))
      say "  ✓ ${name}  v${version:-?}"
    else
      failed=$((failed + 1))
      say "  ✗ ${name}（复制失败，可能权限不足）"
    fi
  done
  say ""
done

total="$(du -sh "$DEST" 2>/dev/null | cut -f1)"
msg="完成：成功 ${copied} 个"
[ "$skipped" -gt 0 ] && msg="$msg，跳过 ${skipped} 个"
[ "$failed" -gt 0 ] && msg="$msg，失败 ${failed} 个"
say "$msg"
say "占用：${total:-未知}"
say ""
say "回到插件 →「备份管理」页签 →「刷新」，新备份会出现在「扩展源码」分组里。"
say ""
read -n 1 -s -r -p "按任意键关闭…"
