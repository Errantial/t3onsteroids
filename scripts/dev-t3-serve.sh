#!/usr/bin/env bash
# Run a throwaway T3 server for dev/verification work, then tear it down.
#
#   scripts/dev-t3-serve.sh [--t3 PATH] [--port N] [--base-dir DIR] -- <command...>
#
# The command runs with T3_DEV_URL=http://127.0.0.1:<port> and T3_DEV_BASE_DIR set; the server
# is stopped when the command exits, fails, or is interrupted.
#
# Why: inside WSL, 127.0.0.1 is forwarded to the Windows host (wslrelay.exe). A dev server on
# :3773 there shadows the host's own T3 for every loopback client, including the T3 Connect
# tunnel, so the phone reaches the wrong environment. So this wrapper:
#   - never uses port 3773 (default 3777, or the first free port above it),
#   - never uses the real ~/.t3 or ~/.t3-nightly data directory,
#   - refuses to start if the chosen port already answers on 127.0.0.1.
set -euo pipefail

t3_bin="${T3_BIN:-t3}"
port="${T3_DEV_PORT:-3777}"
base_dir="${T3_DEV_BASE_DIR:-$HOME/.t3-dev}"
while [ $# -gt 0 ]; do
  case "$1" in
    --t3) t3_bin="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --base-dir) base_dir="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "dev-t3-serve: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || { echo "dev-t3-serve: pass the command to run after --" >&2; exit 2; }

if [ "$port" = "3773" ]; then
  echo "dev-t3-serve: port 3773 is reserved for the machine's own T3; pick another" >&2; exit 2
fi
case "$(cd "$(dirname "$base_dir")" 2>/dev/null && pwd)/$(basename "$base_dir")" in
  "$HOME/.t3" | "$HOME/.t3-nightly" | /home/opc/.t3-nightly)
    echo "dev-t3-serve: $base_dir is a real T3 data directory; use a scratch one" >&2; exit 2 ;;
esac

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for _ in $(seq 1 50); do
  port_in_use "$port" || break
  port=$((port + 1))
  [ "$port" = "3773" ] && port=$((port + 1))
done
if port_in_use "$port"; then echo "dev-t3-serve: no free port found" >&2; exit 1; fi

mkdir -p "$base_dir"
log="$base_dir/dev-serve.log"
T3CODE_NO_BROWSER=1 "$t3_bin" serve --host 127.0.0.1 --port "$port" --base-dir "$base_dir" >>"$log" 2>&1 </dev/null &
server_pid=$!

teardown() {
  if kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$server_pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$server_pid" 2>/dev/null && kill -KILL "$server_pid" 2>/dev/null || true
  fi
}
trap teardown EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for _ in $(seq 1 120); do
  if ! kill -0 "$server_pid" 2>/dev/null; then echo "dev-t3-serve: server exited; see $log" >&2; exit 1; fi
  port_in_use "$port" && break
  sleep 0.5
done
port_in_use "$port" || { echo "dev-t3-serve: server did not listen on $port; see $log" >&2; exit 1; }

echo "dev-t3-serve: pid $server_pid on 127.0.0.1:$port (base dir $base_dir)" >&2
T3_DEV_URL="http://127.0.0.1:$port" T3_DEV_BASE_DIR="$base_dir" "$@"
