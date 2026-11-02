// MCP stdio of the agent <-> the task host's socket. The host speaks MCP itself; this only authenticates
// once and copies bytes both ways, so an agent session carries no JS runtime for its tools.
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int write_all(int fd, const char *data, size_t size) {
  while (size) { ssize_t n = write(fd, data, size); if (n < 0) { if (errno == EINTR) continue; return 0; } data += n; size -= (size_t)n; }
  return 1;
}
// JSON string body; the values are ids, tokens and a path, but nothing here trusts that.
static size_t escape(char *out, size_t cap, const char *value) {
  size_t used = 0;
  for (const unsigned char *c = (const unsigned char *)value; *c; c++) {
    char piece[8]; size_t n;
    if (*c == '"' || *c == '\\') { piece[0] = '\\'; piece[1] = (char)*c; n = 2; }
    else if (*c < 0x20) n = (size_t)snprintf(piece, sizeof(piece), "\\u%04x", *c);
    else { piece[0] = (char)*c; n = 1; }
    if (used + n >= cap) return 0;
    memcpy(out + used, piece, n);
    used += n;
  }
  out[used] = 0; return used;
}
static int fail(const char *message) { fprintf(stderr, "%s\n", message); return 1; }

int main(void) {
  const char *names[] = {"BRIGADIR_HOST_SOCKET", "BRIGADIR_HOST_INSTANCE", "BRIGADIR_PROJECT_ID", "BRIGADIR_TASK_ID", "BRIGADIR_MCP_TOKEN"};
  char values[5][1024];
  for (int i = 0; i < 5; i++) { const char *value = getenv(names[i]); if (!value || !*value) return fail("Missing host socket"); if (!escape(values[i], sizeof(values[i]), value)) return fail("Invalid host environment"); }
  signal(SIGPIPE, SIG_IGN);
  const char *path = getenv("BRIGADIR_HOST_SOCKET"); struct sockaddr_un address; memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(address.sun_path)) return fail("Host socket path is too long");
  memcpy(address.sun_path, path, strlen(path));
  int host = socket(AF_UNIX, SOCK_STREAM, 0); if (host < 0 || connect(host, (struct sockaddr *)&address, sizeof(address)) != 0) return fail("Host disconnected");
  // The same handshake as every host client; `stdio` hands the rest of the stream to the host's MCP server.
  char line[8192]; int size = snprintf(line, sizeof(line), "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"handshake\",\"params\":{\"protocolVersion\":1,\"instance\":\"%s\",\"key\":{\"projectId\":\"%s\",\"id\":\"%s\"},\"role\":\"mcp\",\"token\":\"%s\",\"stdio\":true}}\n", values[1], values[2], values[3], values[4]);
  if (size <= 0 || (size_t)size >= sizeof(line) || !write_all(host, line, (size_t)size)) return fail("Host disconnected");
  // Nothing from the agent goes out before the reply, so the host switches protocols between two frames.
  static char buffer[65536]; size_t have = 0; char *end = NULL;
  while (!end) {
    if (have == sizeof(buffer)) return fail("Invalid handshake reply");
    ssize_t n = read(host, buffer + have, sizeof(buffer) - have); if (n < 0 && errno == EINTR) continue; if (n <= 0) return fail("Host disconnected");
    have += (size_t)n; end = memchr(buffer, '\n', have);
  }
  const char accepted[] = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":";
  if (strncmp(buffer, accepted, sizeof(accepted) - 1) != 0) { fwrite(buffer, 1, (size_t)(end - buffer), stderr); fputc('\n', stderr); return 1; }
  size_t rest = have - (size_t)(end + 1 - buffer); if (rest && !write_all(STDOUT_FILENO, end + 1, rest)) return 0;
  struct pollfd fds[2] = {{STDIN_FILENO, POLLIN, 0}, {host, POLLIN, 0}};
  for (;;) {
    if (poll(fds, 2, -1) < 0) { if (errno == EINTR) continue; return 1; }
    if (fds[0].revents) {
      ssize_t n = read(STDIN_FILENO, buffer, sizeof(buffer));
      if (n < 0 && errno == EINTR) continue;
      // The agent closed its side: the host sees the end, aborts what is in flight and closes.
      if (n <= 0) { shutdown(host, SHUT_WR); fds[0].fd = -1; } else if (!write_all(host, buffer, (size_t)n)) return 0;
    }
    if (fds[1].revents) {
      ssize_t n = read(host, buffer, sizeof(buffer));
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0 || !write_all(STDOUT_FILENO, buffer, (size_t)n)) return 0;
    }
  }
}
