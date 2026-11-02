// CLI hooks and the Claude statusline of a terminal-mode task -> the task host's socket (spec/architecture-and-platform#linux-package), for systems
// where zsh is not a given (Fedora and Ubuntu do not install it). The same contract as resources/hook.zsh and
// statusline.zsh, which macOS keeps:
//   cli-relay hook        stdin (a hook's JSON, up to 1 MiB) -> `cli_hook` with role `hook` and its own token; only a
//                         non-null result reaches stdout; any failure prints one line to stderr and exits 1.
//   cli-relay statusline  the person's own statusline (BRIGADIR_USER_STATUSLINE, /bin/sh -c) gets the same stdin and
//                         prints unchanged; `rate_limits` then goes to the host as `cli_statusline`. Never prints an error.
// Frames are the host's newline-delimited JSON-RPC (peer.ts): the handshake first, then one request with id 2.
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define INPUT_LIMIT (1024 * 1024)
#define REPLY_LIMIT (64 * 1024 * 1024)

static const char hook_failure[] = "Brigadir could not record this CLI hook.\n";

static int write_all(int fd, const char *data, size_t size) {
  while (size) {
    ssize_t n = write(fd, data, size);
    if (n < 0) { if (errno == EINTR) continue; return 0; }
    data += n; size -= (size_t)n;
  }
  return 1;
}

// Ids and tokens of the host: the same check as the scripts' `^[A-Za-z0-9_-]{1,200}$`, so they go into JSON as they are.
static int valid_id(const char *value) {
  if (!value) return 0;
  size_t length = strlen(value);
  if (length < 1 || length > 200) return 0;
  for (const char *c = value; *c; c++)
    if (!((*c >= 'A' && *c <= 'Z') || (*c >= 'a' && *c <= 'z') || (*c >= '0' && *c <= '9') || *c == '_' || *c == '-')) return 0;
  return 1;
}

// All of stdin; 0 when it is longer than the limit or unreadable.
static int read_input(char **out, size_t *size) {
  size_t cap = 65536, used = 0;
  char *data = malloc(cap);
  if (!data) return 0;
  for (;;) {
    if (used == cap) {
      if (cap > INPUT_LIMIT) { free(data); return 0; }
      char *grown = realloc(data, cap * 2);
      if (!grown) { free(data); return 0; }
      data = grown; cap *= 2;
    }
    ssize_t n = read(STDIN_FILENO, data + used, cap - used);
    if (n < 0) { if (errno == EINTR) continue; free(data); return 0; }
    if (n == 0) break;
    used += (size_t)n;
    if (used > INPUT_LIMIT) { free(data); return 0; }
  }
  *out = data; *size = used;
  return 1;
}

static int connect_host(void) {
  const char *path = getenv("BRIGADIR_HOST_SOCKET");
  if (!path || !*path) return -1;
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(address.sun_path)) return -1;
  memcpy(address.sun_path, path, strlen(path));
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { close(fd); return -1; }
  return fd;
}

// The handshake and the request as one write each. Outside strings a JSON line break is whitespace, inside one it is
// invalid: either way the input becomes one frame. `params` goes first so the fields after it win.
static int send_request(int fd, const char *method, char *input, size_t size) {
  const char *names[] = {"BRIGADIR_HOST_INSTANCE", "BRIGADIR_PROJECT_ID", "BRIGADIR_TASK_ID", "BRIGADIR_HOOK_TOKEN"};
  const char *values[4];
  for (int i = 0; i < 4; i++) { values[i] = getenv(names[i]); if (!valid_id(values[i])) return 0; }
  char line[2048];
  int length = snprintf(line, sizeof(line),
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"handshake\",\"params\":{\"protocolVersion\":1,\"instance\":\"%s\",\"key\":{\"projectId\":\"%s\",\"id\":\"%s\"},\"role\":\"hook\",\"token\":\"%s\"}}\n{\"jsonrpc\":\"2.0\",\"params\":",
    values[0], values[1], values[2], values[3]);
  if (length <= 0 || (size_t)length >= sizeof(line)) return 0;
  for (size_t i = 0; i < size; i++) if (input[i] == '\n') input[i] = ' ';
  char tail[96];
  int tail_length = snprintf(tail, sizeof(tail), ",\"id\":2,\"method\":\"%s\"}\n", method);
  return write_all(fd, line, (size_t)length) && write_all(fd, input, size) && write_all(fd, tail, (size_t)tail_length);
}

// Reads replies until a whole line starts with `{"jsonrpc":"2.0","id":2,`; returns what follows the prefix (without the
// line break) or NULL on timeout, close or a reply past the limit. The host answers the handshake first.
static char *await_reply(int fd, int timeout_ms) {
  static const char prefix[] = "{\"jsonrpc\":\"2.0\",\"id\":2,";
  size_t cap = 65536, used = 0, line = 0;
  char *data = malloc(cap);
  if (!data) return NULL;
  for (;;) {
    struct pollfd wait = {fd, POLLIN, 0};
    int ready = poll(&wait, 1, timeout_ms);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) break;
    if (used == cap) {
      if (cap >= REPLY_LIMIT) break;
      char *grown = realloc(data, cap * 2);
      if (!grown) break;
      data = grown; cap *= 2;
    }
    ssize_t n = read(fd, data + used, cap - used);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    used += (size_t)n;
    char *end;
    while ((end = memchr(data + line, '\n', used - line))) {
      size_t length = (size_t)(end - (data + line));
      if (length >= sizeof(prefix) - 1 && memcmp(data + line, prefix, sizeof(prefix) - 1) == 0) {
        size_t rest = length - (sizeof(prefix) - 1);
        memmove(data, data + line + sizeof(prefix) - 1, rest);
        data[rest] = 0;
        return data;
      }
      line += length + 1;
    }
  }
  free(data);
  return NULL;
}

static int hook(void) {
  char *input; size_t size;
  if (!read_input(&input, &size)) goto fail;
  int fd = connect_host();
  if (fd < 0 || !send_request(fd, "cli_hook", input, size)) goto fail;
  char *reply = await_reply(fd, 8000);
  if (!reply) goto fail;
  size_t length = strlen(reply);
  static const char result[] = "\"result\":";
  if (strcmp(reply, "\"result\":null}") == 0) return 0;
  if (length > sizeof(result) && memcmp(reply, result, sizeof(result) - 1) == 0 && reply[length - 1] == '}') {
    if (!write_all(STDOUT_FILENO, reply + sizeof(result) - 1, length - sizeof(result))) goto fail;
    return 0;
  }
fail:
  write_all(STDERR_FILENO, hook_failure, sizeof(hook_failure) - 1);
  return 1;
}

// The person's statusline with our stdin; its output is theirs, unchanged.
static void user_statusline(const char *command, const char *input, size_t size) {
  int pipes[2];
  if (pipe(pipes) != 0) return;
  pid_t child = fork();
  if (child < 0) { close(pipes[0]); close(pipes[1]); return; }
  if (child == 0) {
    close(pipes[1]);
    if (dup2(pipes[0], STDIN_FILENO) < 0) _exit(127);
    close(pipes[0]);
    signal(SIGPIPE, SIG_DFL);
    execl("/bin/sh", "sh", "-c", command, (char *)NULL);
    _exit(127);
  }
  close(pipes[0]);
  write_all(pipes[1], input, size);
  close(pipes[1]);
  while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
}

static int statusline(void) {
  char *input; size_t size;
  if (!read_input(&input, &size)) return 0;
  const char *command = getenv("BRIGADIR_USER_STATUSLINE");
  if (command && *command) user_statusline(command, input, size);
  static const char marker[] = "\"rate_limits\"";
  int found = 0;
  for (size_t i = 0; !found && i + sizeof(marker) - 1 <= size; i++) found = memcmp(input + i, marker, sizeof(marker) - 1) == 0;
  if (!found) return 0;
  int fd = connect_host();
  if (fd < 0 || !send_request(fd, "cli_statusline", input, size)) return 0;
  // Wait briefly for the reply so the host reads the frame before the socket closes; the answer itself carries nothing.
  free(await_reply(fd, 2000));
  return 0;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc == 2 && strcmp(argv[1], "hook") == 0) return hook();
  if (argc == 2 && strcmp(argv[1], "statusline") == 0) return statusline();
  fprintf(stderr, "usage: cli-relay hook|statusline\n");
  return 2;
}
