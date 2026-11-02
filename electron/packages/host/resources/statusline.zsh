# Claude Code statusLine for terminal-mode tasks (spec/agents-and-providers#quota-sources), run as `/bin/zsh -f`. The person's own statusline runs
# first with the same stdin and its output is printed unchanged; then `rate_limits` (documented statusline field) goes to the
# host over the hook role, the same socket and token as hook.zsh. Never prints an error: a status line is not a place for one.
emulate -R zsh
setopt no_multibyte
input=
if zmodload zsh/system 2>/dev/null; then
  while :; do
    sysread -s 65536 chunk; case $? in 0) input+=$chunk;; *) break;; esac
    (( ${#input} <= 1048576 )) || exit 0
  done
else input=$(head -c 1048576); fi
if [[ -n $BRIGADIR_USER_STATUSLINE ]]; then print -rn -- "$input" | /bin/sh -c "$BRIGADIR_USER_STATUSLINE"; fi
[[ $input == *'"rate_limits"'* ]] || exit 0
zmodload zsh/net/socket zsh/system 2>/dev/null || exit 0
for value in "$BRIGADIR_HOST_INSTANCE" "$BRIGADIR_PROJECT_ID" "$BRIGADIR_TASK_ID" "$BRIGADIR_HOOK_TOKEN"; do [[ $value =~ '^[A-Za-z0-9_-]{1,200}$' ]] || exit 0; done
input=${input//$'\n'/ }
zsocket "$BRIGADIR_HOST_SOCKET" 2>/dev/null || exit 0
fd=$REPLY
print -rnu $fd -- "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"handshake\",\"params\":{\"protocolVersion\":1,\"instance\":\"$BRIGADIR_HOST_INSTANCE\",\"key\":{\"projectId\":\"$BRIGADIR_PROJECT_ID\",\"id\":\"$BRIGADIR_TASK_ID\"},\"role\":\"hook\",\"token\":\"$BRIGADIR_HOOK_TOKEN\"}}"$'\n'"{\"jsonrpc\":\"2.0\",\"params\":$input,\"id\":2,\"method\":\"cli_statusline\"}"$'\n' 2>/dev/null || exit 0
# Wait briefly for the reply so the host reads the frame before the socket closes; the answer itself carries nothing.
buffer=
while sysread -i $fd -t 2 -s 65536 chunk; do buffer+=$chunk; [[ $buffer == *'"id":2,'* ]] && break; done
exit 0
