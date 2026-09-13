#!/usr/bin/env bash
#
# install-skill.sh —— 把「受管技能源」软链进运行时技能目录 ~/.dsh/skills/
#
# 技能源（权威，单一事实源）：
#   /home/sx/projects/MyAI/dsh-extensions/skills/<name>/
#   /home/sx/projects/update-app/skills/<name>/
#
# 目标：
#   ~/.dsh/skills/<name>  ->  <源目录>   （符号链接）
#
# 设计取舍：
#   - 只管理上面两个源里出现的技能。~/.dsh/skills/ 下其余两百多个技能一律不碰。
#   - 用软链而非副本：消灭「运行时副本与仓库副本漂移」——曾经出现运行时那份还在教
#     「在 dsh-web-ui 全家包里加包」，而那个仓库早已删除。
#   - 幂等：重复运行无副作用。
#   - 覆盖真实目录需要显式 --force，且先把原目录移到 ~/.dsh/skill-backups/（放在技能根
#     之外，避免被技能发现逻辑当成一个技能扫到）。
#
# 用法：
#   ./install-skill.sh             # 安装/更新软链
#   ./install-skill.sh --dry-run   # 只看会做什么，不改动
#   ./install-skill.sh --force     # 允许覆盖已存在的真实目录（先备份）
#
set -euo pipefail

SKILLS_ROOT="${HOME}/.dsh/skills"
BACKUP_ROOT="${HOME}/.dsh/skill-backups"
SOURCES=(
  "/home/sx/projects/MyAI/dsh-extensions/skills"
  "/home/sx/projects/update-app/skills"
)

dry_run=0
force=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --force)   force=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（试用 --help）" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$dry_run" -eq 1 ]; then echo "  [dry-run] $*"; else "$@"; fi
}

[ -d "$SKILLS_ROOT" ] || { echo "技能根不存在：$SKILLS_ROOT" >&2; exit 1; }

linked=0 repointed=0 refused=0 missing_src=0

# 收集受管技能（源里含 SKILL.md 的一级子目录）
declare -a names=() paths=()
for src in "${SOURCES[@]}"; do
  [ -d "$src" ] || { echo "跳过（源不存在）：$src" >&2; continue; }
  for dir in "$src"/*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    if [ ! -f "${dir}SKILL.md" ]; then
      echo "跳过（无 SKILL.md）：$dir" >&2
      missing_src=$((missing_src + 1))
      continue
    fi
    names+=("$name")
    paths+=("${dir%/}")
  done
done

if [ "${#names[@]}" -eq 0 ]; then
  echo "没有找到任何受管技能源，什么也没做。"
  exit 0
fi

echo "受管技能源 ${#names[@]} 个："
for i in "${!names[@]}"; do echo "  ${names[$i]}  <-  ${paths[$i]}"; done
echo

for i in "${!names[@]}"; do
  name="${names[$i]}"
  src="${paths[$i]}"
  target="${SKILLS_ROOT}/${name}"

  if [ -L "$target" ]; then
    current="$(readlink -f "$target" || true)"
    if [ "$current" = "$src" ]; then
      echo "ok        ${name}（已指向源）"
    else
      echo "重指      ${name}  ${current:-<悬空>}  ->  ${src}"
      run ln -sfn "$src" "$target"
      repointed=$((repointed + 1))
    fi
  elif [ -e "$target" ]; then
    if [ "$force" -ne 1 ]; then
      echo "拒绝      ${name}（真实目录已存在，需 --force 才会覆盖；原目录会先备份）" >&2
      refused=$((refused + 1))
      continue
    fi
    ts="$(date +%Y%m%d-%H%M%S)"
    dest="${BACKUP_ROOT}/${name}-${ts}"
    echo "备份+覆盖 ${name}  ${target}  ->  ${dest}"
    run mkdir -p "$BACKUP_ROOT"
    run mv "$target" "$dest"
    run ln -sfn "$src" "$target"
    linked=$((linked + 1))
  else
    echo "新建      ${name}  ->  ${src}"
    run ln -sfn "$src" "$target"
    linked=$((linked + 1))
  fi
done

echo
echo "完成：新建/覆盖 ${linked}，重指 ${repointed}，拒绝 ${refused}。"
[ "$dry_run" -eq 1 ] && echo "（dry-run，未做任何改动）"
[ "$refused" -gt 0 ] && { echo "有 ${refused} 项被拒绝：加 --force 覆盖（会先备份到 ${BACKUP_ROOT}）。" >&2; exit 1; }
exit 0
