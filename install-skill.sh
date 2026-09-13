#!/usr/bin/env bash
#
# install-skill.sh —— 把「受管技能源」软链进运行时技能目录 ~/.dsh/skills/
#
# 技能源（三处，全部是权威来源，运行时只放软链）：
#   1. <dsh-extensions>/skills/<分组>/**/SKILL.md   ← 按上游仓库分组；技能目录 = 含 SKILL.md 的目录
#      （上游把技能放在不同层级：skills/<名>/、skills/<分类>/<名>/、.agents/skills/<名>/、
#        plugins/<插件>/skills/<名>/……所以按 SKILL.md 递归发现，而不是写死两级）
#   2. <update-app>/skills/<技能>/                ← update-all 随它的 CLI 走
#   3. ~/projects/<项目>/.dsh/skills/<技能>/      ← 项目专用技能（各项目自己的仓）
#
# 目标：
#   ~/.dsh/skills/<技能>  ->  <源目录>   （符号链接）
#
# 设计取舍：
#   - 只管理上述三处里出现的技能。~/.dsh/skills/ 下其余条目一律不碰。
#   - 用软链而非副本：消灭「运行时副本与源漂移」。曾经运行时的 dsh-extension-dev
#     还是旧的、在教一个已被删除的仓库。
#   - 幂等：重复运行无副作用。
#   - 覆盖真实目录需要显式 --force，且先把原目录移到 ~/.dsh/skill-backups/（放在技能根
#     之外，避免被技能发现逻辑当成一个技能扫到）。
#
# 用法：
#   ./install-skill.sh             # 安装/更新软链
#   ./install-skill.sh --dry-run   # 只看会做什么，不改动
#   ./install-skill.sh --force     # 允许覆盖已存在的真实目录（先备份）
#   ./install-skill.sh --list      # 列出受管技能及其来源，不安装
#
set -euo pipefail

DSH_EXT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_ROOT="${HOME}/.dsh/skills"
BACKUP_ROOT="${HOME}/.dsh/skill-backups"
UPDATE_APP="${HOME}/projects/update-app"
PROJECTS_ROOT="${HOME}/projects"

dry_run=0 force=0 list_only=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --force)   force=1 ;;
    --list)    list_only=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（试用 --help）" >&2; exit 2 ;;
  esac
done

run() { if [ "$dry_run" -eq 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }

[ -d "$SKILLS_ROOT" ] || { echo "技能根不存在：$SKILLS_ROOT" >&2; exit 1; }

declare -a names=() paths=()

add_skill() {  # $1 = 技能目录；名字优先取 frontmatter 的 name:，否则用目录名
  local dir="${1%/}" name
  [ -d "$dir" ] || return 0
  [ -f "$dir/SKILL.md" ] || return 0
  name="$(skill_name "$dir")"
  local i
  for i in "${!names[@]}"; do
    if [ "${names[$i]}" = "$name" ]; then
      echo "跳过（重名，已在 ${paths[$i]}）：$dir" >&2
      return 0
    fi
  done
  names+=("$name"); paths+=("$dir")
}

# 取技能名：frontmatter 里的 name: 优先（本地改写的技能名不随上游目录改名而变）
skill_name() {
  local n
  n="$(sed -n '1{/^---[[:space:]]*$/!q};1,/^---[[:space:]]*$/p' "$1/SKILL.md" 2>/dev/null \
       | sed -n 's/^name:[[:space:]]*//p' | head -1 | tr -d '\r' \
       | sed 's/^["'"'"']//; s/["'"'"']$//; s/[[:space:]]*$//')"
  if [ -n "$n" ]; then printf '%s' "$n"; else basename "$1"; fi
}

# 源 1：dsh-extensions/skills/<分组>/**/SKILL.md
#   不限深度（上游层级不一：skills/<名>/、skills/<分类>/<名>/、.agents/skills/<名>/、
#   plugins/<插件>/skills/<名>/……深处还有更深的结构，硬编码层数会静默漏技能）。
#   排序按「路径深度优先」：同一技能被多份副本携带时（上游常给多个 harness 各放一份）
#   取最浅的那份，故 canonical 目录（skills/、.agents/skills/）优先于 .openclaw/skills/ 之类的分发副本。
#   排除测试/示例噪音，且**把跳过的列出来**（静默跳过是过去的教训）。
if [ -d "$DSH_EXT/skills" ]; then
  declare -a skipped=()
  while IFS= read -r f; do
    d="$(dirname "$f")"
    case "$d" in
      */tests/*|*/test/*|*/fixtures/*|*/examples/*|*/sample*) skipped+=("$d"); continue ;;
    esac
    add_skill "$d"
  done < <(
    find "$DSH_EXT/skills" -mindepth 2 -type f -name SKILL.md \
      -not -path '*/.git/*' -not -path '*/node_modules/*' \
      -printf '%d\t%p\n' | sort -k1,1n -k2,2 | cut -f2-
  )
  if [ "${#skipped[@]}" -gt 0 ]; then
    echo "跳过（测试/示例噪音，共 ${#skipped[@]} 个）：" >&2
    for d in "${skipped[@]}"; do echo "  ${d#"$DSH_EXT"/}" >&2; done
  fi
fi
# 源 2：update-app/skills/<技能>
[ -d "$UPDATE_APP/skills" ] && for sk in "$UPDATE_APP"/skills/*/; do add_skill "$sk"; done
# 源 3：各项目 .dsh/skills/<技能>
for proj in "$PROJECTS_ROOT"/*/; do
  [ -d "${proj}.dsh/skills" ] || continue
  for sk in "${proj}.dsh/skills"/*/; do add_skill "$sk"; done
done

if [ "${#names[@]}" -eq 0 ]; then echo "没有找到任何技能源，什么也没做。"; exit 0; fi

echo "受管技能 ${#names[@]} 个："
for i in "${!names[@]}"; do
  printf "  %-40s <- %s\n" "${names[$i]}" "${paths[$i]}"
done
echo
[ "$list_only" -eq 1 ] && exit 0

linked=0 repointed=0 refused=0
for i in "${!names[@]}"; do
  name="${names[$i]}"; src="${paths[$i]}"; target="${SKILLS_ROOT}/${name}"
  if [ -L "$target" ]; then
    current="$(readlink -f "$target" || true)"
    if [ "$current" = "$src" ]; then
      :
    else
      echo "重指      ${name}  ${current:-<失效>}  ->  ${src}"
      run ln -sfn "$src" "$target"; repointed=$((repointed + 1))
    fi
  elif [ -e "$target" ]; then
    if [ "$force" -ne 1 ]; then
      echo "拒绝      ${name}（真实目录已存在，需 --force；原目录会先备份）" >&2
      refused=$((refused + 1)); continue
    fi
    ts="$(date +%Y%m%d-%H%M%S)"; dest="${BACKUP_ROOT}/${name}-${ts}"
    echo "备份+覆盖 ${name}  ->  ${dest}"
    run mkdir -p "$BACKUP_ROOT"; run mv "$target" "$dest"; run ln -sfn "$src" "$target"
    linked=$((linked + 1))
  else
    run ln -sfn "$src" "$target"; linked=$((linked + 1))
  fi
done

echo
echo "完成：新建 ${linked}，重指 ${repointed}，拒绝 ${refused}。"
[ "$dry_run" -eq 1 ] && echo "（dry-run，未做任何改动）"
[ "$refused" -gt 0 ] && { echo "有 ${refused} 项被拒绝：加 --force 覆盖（先备份到 ${BACKUP_ROOT}）。" >&2; exit 1; }
exit 0
