ZDOTDIR="$BRIGADIR_SHELL_HOME"
# /etc/zshrc runs before this wrapper and may derive HISTFILE from our ZDOTDIR.
[[ "$HISTFILE" == "$BRIGADIR_SHELL_ASSETS/.zsh_history" ]] && HISTFILE="$ZDOTDIR/.zsh_history"
[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
# One encoding pipeline for command and cwd: macOS base64 does not wrap and $() drops its line break.
function _brigadir_preexec() {
  printf '\033]777;brigadir;%s\007\033]133;C\007' "$(printf '%s\0%s' "$1" "$PWD" | /usr/bin/base64)"
}
function _brigadir_precmd() {
  local brigadir_code=$?
  printf '\033]133;D;%d\007\033]133;A\007' "$brigadir_code"
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec _brigadir_preexec
add-zsh-hook precmd _brigadir_precmd
