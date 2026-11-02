# CLI hook relay: stdin -> host socket -> stdout, run as `/bin/zsh -f` (~5 ms) instead of Electron as Node (~75 ms) on every hook
# (perf review TUI-06, MCP-10). Same contract as hook-entry.ts: input up to 1 MiB, role `hook` with its own token, the host
# validates the shape; only a non-null result reaches stdout. Frames are the host's newline-delimited JSON-RPC (peer.ts).
# Input and replies reach megabytes: only linear operations on them (a `(i)` subscript or `${x#*…}` is quadratic in zsh).
emulate -R zsh
setopt no_multibyte
fail() { print -ru2 -- 'Brigadir could not record this CLI hook.'; exit 1 }
zmodload zsh/net/socket zsh/system 2>/dev/null || fail
for value in "$BRIGADIR_HOST_INSTANCE" "$BRIGADIR_PROJECT_ID" "$BRIGADIR_TASK_ID" "$BRIGADIR_HOOK_TOKEN"; do [[ $value =~ '^[A-Za-z0-9_-]{1,200}$' ]] || fail; done
input=
while :; do
  sysread -s 65536 chunk; case $? in 0) input+=$chunk;; 5) break;; *) fail;; esac
  (( ${#input} <= 1048576 )) || fail
done
# Outside strings a JSON line break is whitespace, inside one it is invalid: one frame either way. `params` goes first so
# the fields after it win over any the input might repeat.
input=${input//$'\n'/ }
zsocket "$BRIGADIR_HOST_SOCKET" 2>/dev/null || fail
fd=$REPLY
print -rnu $fd -- "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"handshake\",\"params\":{\"protocolVersion\":1,\"instance\":\"$BRIGADIR_HOST_INSTANCE\",\"key\":{\"projectId\":\"$BRIGADIR_PROJECT_ID\",\"id\":\"$BRIGADIR_TASK_ID\"},\"role\":\"hook\",\"token\":\"$BRIGADIR_HOOK_TOKEN\"}}"$'\n'"{\"jsonrpc\":\"2.0\",\"params\":$input,\"id\":2,\"method\":\"cli_hook\"}"$'\n' || fail
# The host answers the handshake first; only the cli_hook line matters. Each reply is one write ending in a line break, and
# JSON has none inside: lines are split only when the data read so far ends with one.
buffer= prefix='{"jsonrpc":"2.0","id":2,'
while :; do
  sysread -i $fd -t 8 -s 65536 chunk || fail
  buffer+=$chunk
  [[ ${chunk[-1]} == $'\n' ]] || continue
  for line in "${(@f)buffer}"; do [[ ${line[1,${#prefix}]} == "$prefix" ]] && break 2; done
done
line=${line[${#prefix}+1,-1]}
if [[ $line == '"result":null}' ]]; then :
elif [[ ${line[1,9]} == '"result":' && ${line[-1]} == '}' ]]; then print -rn -- "${line[10,-2]}"
else fail; fi
