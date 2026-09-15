---
name: git
description: Source-control safety for Git. Two rules apply whether or not you read the body. First, never commit, amend, push, tag, rebase, cherry-pick, revert, or reset --hard unless the user asked for that exact write in this session. An explicit request to create a new commit counts anywhere in the user's own task text, but it is not a request to amend, push, or tag. Finishing a task without that request is not authorization, so leave your work uncommitted for review. Second, when a Git lock file or corrupt index blocks you, never kill the holding process or bulldoze through with deletions - wait, retry, use the holder's own stop mechanism, or stop and report. Load the body only before writing Git history or recovering Git state.
user-invocable: false
---

# Git source-control safety

The working tree belongs to the user. Make the change, leave it visible, and
let them decide what becomes history.

## Never without an explicit ask

The user must have asked for that exact write in this session, in their own
words. An explicit request to create a new commit counts anywhere in the user's
own task text, but it is not a request to amend, push, or tag. Finishing a task
without that request does not authorize a history write.

- `commit`, `commit --amend`, `push`, `tag`, `rebase`, `cherry-pick`, `revert`,
  `merge`, branch deletion, `reset --hard`, path restore, and `clean -f` all
  require an explicit ask.
- Never publish merely because publication would be useful.

## Before an authorized discard

Recovery is insurance, not authorization. A save never expands what the user
allowed you to delete or overwrite.

When the user explicitly authorized an operation that may discard or broadly
overwrite workspace changes, and the workspace is an ordinary Git checkout:

1. After `read_skill` gives the physical Git skill package path, run:

   ```bash
   bash <git-skill-dir>/scripts/workspace-recovery.sh save before-discard
   ```

2. Keep the printed `refs/tbh/recovery/...` value in your handoff, then perform
   only the exact authorized operation.
3. If the save fails or the workspace is unsupported, stop before destruction
   and ask the user.

To recover that saved tree later, run:

```bash
bash <git-skill-dir>/scripts/workspace-recovery.sh restore <recovery-ref>
```

Restore first saves the current workspace, leaves HEAD, branch, and the real
index in place, and restores the selected snapshot into the worktree. The ref
also retains distinct staged bytes when the same path had later worktree edits.
Read those staged bytes with `git show '<recovery-ref>^2:<path>'`; the recovery
commit's second parent is the saved index tree. Ignored files are not saved;
restore refuses an ignored-path collision rather than overwrite data it could
not save. Use only the exact printed ref, not a revision expression.

## Always fine

Read-only inspection such as `status`, `log`, `show`, `diff`, `blame`,
`branch -v`, `show-ref`, `rev-parse`, `for-each-ref`, and `merge-base` is fine.
Staging named files to inspect `diff --cached`, and a temporary stash around a
tool that requires a clean tree, are also fine when the original state is put
back afterward.

## The rest

- Do not use a broad add in a tree you did not clean; name the files you changed.
- Do not initialize a repository inside vendored, build, data, or existing
  source-control trees.
- Do not hand-edit generated files; change their source of truth.
- Scratch repositories under a temporary directory are yours to experiment in.

## Locks and corrupt state

A Git lock usually means another process is writing. Never kill the holder on
your own initiative. Wait, inspect the holder read-only, use that tool's normal
stop mechanism, or report the block. Never delete a lock without proving no
live process owns it, and never respond to index corruption by deleting state
and committing anyway.

Never commit or push while status reports changes you did not make and cannot
explain.

## If you already made an unwanted write

Say so plainly and stop. Do not attempt more history surgery without direction.
skills/git/scripts/workspace-recovery.sh#!/usr/bin/env bash
set -euo pipefail
unset GIT_INDEX_FILE

usage() {
  echo "usage: workspace-recovery.sh save [label] | restore <recovery-ref>" >&2
  exit 2
}

die() {
  echo "workspace recovery: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is unavailable"
root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not an ordinary Git workspace"
head=$(git -C "$root" rev-parse --verify HEAD 2>/dev/null) || die "unborn HEAD is unsupported"
[ -z "$(git -C "$root" ls-files -u)" ] || die "an unmerged index is unsupported"
saved_ref=

write_recovery_commit() {
  local message=$1 tree=$2
  shift 2
  printf '%s\n' "$message" |
    GIT_AUTHOR_NAME="TBH Recovery" \
    GIT_AUTHOR_EMAIL="recovery@localhost" \
    GIT_COMMITTER_NAME="TBH Recovery" \
    GIT_COMMITTER_EMAIL="recovery@localhost" \
    git -C "$root" commit-tree "$tree" "$@"
}

save_snapshot() {
  local label=${1:-checkpoint}
  local alternate_index index_entries real_index index_tree index_commit tree commit timestamp
  local entry mode path head_entry head_mode

  case "$label" in
    ''|*[!A-Za-z0-9._-]*) die "label must use only letters, digits, dot, underscore, or dash" ;;
  esac
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  saved_ref="refs/tbh/recovery/$label/$timestamp-$$"
  git check-ref-format "$saved_ref" >/dev/null 2>&1 || die "label does not form a valid recovery ref"

  alternate_index=$(mktemp "${TMPDIR:-/tmp}/tbh-recovery-index.XXXXXX")
  index_entries=$(mktemp "${TMPDIR:-/tmp}/tbh-recovery-entries.XXXXXX")
  rm -f "$alternate_index"
  trap 'rm -f "$alternate_index" "$index_entries"' EXIT
  trap 'exit 130' HUP INT TERM

  real_index=$(git -C "$root" rev-parse --git-path index)
  case "$real_index" in
    /*) ;;
    *) real_index="$root/$real_index" ;;
  esac
  cp "$real_index" "$alternate_index"
  index_tree=$(GIT_INDEX_FILE="$alternate_index" git -C "$root" write-tree)
  index_commit=$(
    write_recovery_commit "TBH recovery index: $label" "$index_tree" -p "$head"
  )
  rm -f "$alternate_index"
  GIT_INDEX_FILE="$alternate_index" git -C "$root" read-tree "$head"
  GIT_INDEX_FILE="$alternate_index" git -C "$root" add -A -- .
  GIT_INDEX_FILE="$alternate_index" git -C "$root" ls-files --stage -z >"$index_entries"
  while IFS= read -r -d '' entry; do
    mode=${entry%% *}
    [ "$mode" = 160000 ] || continue
    case "$entry" in
      *$'\t'*) path=${entry#*$'\t'} ;;
      *) die "cannot inspect saved Git links" ;;
    esac
    head_entry=$(GIT_LITERAL_PATHSPECS=1 git -C "$root" ls-tree "$head" -- "$path")
    head_mode=${head_entry%% *}
    [ "$head_mode" = 160000 ] ||
      die "cannot save untracked embedded Git repository: $path"
  done <"$index_entries"
  tree=$(GIT_INDEX_FILE="$alternate_index" git -C "$root" write-tree)
  commit=$(
    write_recovery_commit "TBH recovery worktree: $label" "$tree" -p "$head" -p "$index_commit"
  )
  git -C "$root" update-ref "$saved_ref" "$commit" ""

  rm -f "$alternate_index"
  rm -f "$index_entries"
  trap - EXIT HUP INT TERM
}

collect_one_restore_collision() {
  local path=$1 leaf=$2 candidates=$3 directory_candidates=$4
  if [ ! -e "$root/$path" ] && [ ! -L "$root/$path" ]; then
    return
  fi
  if [ "$leaf" = false ] && [ -d "$root/$path" ] && [ ! -L "$root/$path" ]; then
    return
  fi
  if [ "$leaf" = true ] && [ -d "$root/$path" ] && [ ! -L "$root/$path" ]; then
    printf '%s\0' "$path" >>"$directory_candidates"
  fi
  printf '%s\0' "$path" >>"$candidates"
}

refuse_unsafe_restore_collisions() {
  local recovery_commit=$1 collision_dir path_list index_paths candidates directory_candidates
  local ignore_candidates ignore_matches path ancestor previous_path index_path index_eof
  local directory_path directory_eof tracked_exact leaf_directory ignore_status ignored_path
  local first_candidate LC_ALL=C

  collision_dir=$(mktemp -d "${TMPDIR:-/tmp}/tbh-recovery-collisions.XXXXXX")
  path_list="$collision_dir/recovery-paths"
  index_paths="$collision_dir/index-paths"
  candidates="$collision_dir/collision-candidates"
  directory_candidates="$collision_dir/directory-candidates"
  ignore_candidates="$collision_dir/ignore-candidates"
  ignore_matches="$collision_dir/ignore-matches"
  : >"$candidates"
  : >"$directory_candidates"
  : >"$ignore_candidates"
  trap 'rm -rf "$collision_dir"' EXIT
  trap 'exit 130' HUP INT TERM
  git -C "$root" ls-tree -r --name-only -z "$recovery_commit" >"$path_list"
  git -C "$root" ls-files -z >"$index_paths"

  previous_path=
  while IFS= read -r -d '' path; do
    ancestor=$path
    while [[ "$ancestor" == */* ]]; do
      ancestor=${ancestor%/*}
      case "$previous_path" in
        "$ancestor"/*) continue ;;
      esac
      collect_one_restore_collision "$ancestor" false "$candidates" "$directory_candidates"
    done
    collect_one_restore_collision "$path" true "$candidates" "$directory_candidates"
    previous_path=$path
  done <"$path_list"

  LC_ALL=C sort -zu "$candidates" -o "$candidates"
  LC_ALL=C sort -zu "$directory_candidates" -o "$directory_candidates"
  LC_ALL=C sort -zu "$index_paths" -o "$index_paths"

  index_path=
  index_eof=false
  exec 9<"$index_paths"
  if ! IFS= read -r -d '' index_path <&9; then
    index_eof=true
  fi
  directory_path=
  directory_eof=false
  exec 8<"$directory_candidates"
  if ! IFS= read -r -d '' directory_path <&8; then
    directory_eof=true
  fi
  while IFS= read -r -d '' path; do
    while [ "$index_eof" = false ] && [[ "$index_path" < "$path" ]]; do
      if ! IFS= read -r -d '' index_path <&9; then
        index_eof=true
        index_path=
      fi
    done
    tracked_exact=false
    if [ "$index_eof" = false ] && [ "$index_path" = "$path" ]; then
      tracked_exact=true
    fi

    while [ "$directory_eof" = false ] && [[ "$directory_path" < "$path" ]]; do
      if ! IFS= read -r -d '' directory_path <&8; then
        directory_eof=true
        directory_path=
      fi
    done
    leaf_directory=false
    if [ "$directory_eof" = false ] && [ "$directory_path" = "$path" ]; then
      leaf_directory=true
    fi

    [ "$tracked_exact" = true ] && continue
    [ "$leaf_directory" = false ] || die "restore would replace an untracked directory: $path"
    printf '%s\0' "$path" >>"$ignore_candidates"
  done <"$candidates"
  exec 9<&-
  exec 8<&-

  if [ -s "$ignore_candidates" ]; then
    if git -C "$root" check-ignore -z --stdin --no-index \
      <"$ignore_candidates" >"$ignore_matches"; then
      if IFS= read -r -d '' ignored_path <"$ignore_matches"; then
        die "restore would overwrite an ignored path: $ignored_path"
      fi
      die "cannot verify ignore rules for restore paths"
    else
      ignore_status=$?
      if [ "$ignore_status" -ne 1 ]; then
        if ! IFS= read -r -d '' first_candidate <"$ignore_candidates"; then
          first_candidate="restore paths"
        fi
        die "cannot verify ignore rules for: $first_candidate"
      fi
    fi
  fi

  rm -rf "$collision_dir"
  trap - EXIT HUP INT TERM
}

case ${1:-} in
  save)
    [ "$#" -le 2 ] || usage
    save_snapshot "${2:-checkpoint}"
    printf 'saved %s\n' "$saved_ref"
    ;;
  restore)
    [ "$#" -eq 2 ] || usage
    recovery_ref=$2
    case "$recovery_ref" in
      refs/tbh/recovery/*) ;;
      *) die "restore requires a refs/tbh/recovery/... ref" ;;
    esac
    git check-ref-format "$recovery_ref" >/dev/null 2>&1 ||
      die "restore requires an exact recovery ref"
    recovery_oid=$(git -C "$root" show-ref --verify --hash "$recovery_ref" 2>/dev/null) ||
      die "recovery ref does not name a commit"
    recovery_commit=$(git -C "$root" rev-parse --verify "$recovery_oid^{commit}" 2>/dev/null) ||
      die "recovery ref does not name a commit"
    refuse_unsafe_restore_collisions "$recovery_commit"
    save_snapshot before-restore
    printf 'saved current workspace to %s\n' "$saved_ref"
    git -C "$root" restore --source="$recovery_commit" --worktree -- .
    printf 'restored %s\n' "$recovery_ref"
    ;;
  *) usage ;;
esac
