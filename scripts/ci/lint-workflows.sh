#!/usr/bin/env bash
# 固定工具版本并校验官方发布包，先检查工作流语法/表达式，再做耗时的编译和浏览器测试。
set -euo pipefail
root_dir="$(git rev-parse --show-toplevel)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
curl --fail --silent --show-error --location --retry 3 --max-time 90 --retry-max-time 180 \
  https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \
  -o "$work_dir/actionlint.tar.gz"
printf '%s  %s\n' '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8' \
  "$work_dir/actionlint.tar.gz" | sha256sum --check
tar -xzf "$work_dir/actionlint.tar.gz" -C "$work_dir" actionlint
cd "$root_dir"
# 该闸检查 Actions 结构和表达式；嵌入式 shell 的存量规则不在此扩张为新合并门槛。
"$work_dir/actionlint" -shellcheck=''
