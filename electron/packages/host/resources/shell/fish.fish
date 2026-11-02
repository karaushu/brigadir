function _brigadir_preexec --on-event fish_preexec
  printf '\033]777;brigadir;%s;%s\007\033]133;C\007' (printf %s "$argv[1]" | /usr/bin/base64 | string join '') (printf %s "$PWD" | /usr/bin/base64 | string join '')
end
function _brigadir_postexec --on-event fish_postexec
  set -l brigadir_code $status
  printf '\033]133;D;%d\007\033]133;A\007' $brigadir_code
end
