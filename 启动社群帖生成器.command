#!/bin/zsh

cd -- "${0:A:h}" || exit 1

node_candidates=(
  "$(command -v node)"
  /opt/homebrew/bin/node
  /usr/local/bin/node
  "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node(NOn)
)

for node_path in "${node_candidates[@]}"; do
  if [[ -x "$node_path" ]] && "$node_path" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
    "$node_path" --use-system-ca ./server.mjs --open
    exit_code=$?
    if (( exit_code != 0 )); then
      read -r '?按回车键关闭窗口。'
    fi
    exit "$exit_code"
  fi
done

print '需要 Node.js 24 或以上版本。安装后重新双击此文件。'
read -r '?按回车键关闭窗口。'
exit 1
