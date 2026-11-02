// Process identity and a kernel-held transaction guard. No stale mutex files to reap.
#include <sys/types.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#ifdef __APPLE__
#include <sys/sysctl.h>
#include <sys/proc.h>
#endif

static int identity(const char *arg) {
  char *end; errno = 0; long value = strtol(arg, &end, 10);
  if (errno || *end || value <= 0 || value > INT_MAX) return 2;
#ifdef __APPLE__
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)value};
  struct kinfo_proc info; size_t size = sizeof(info);
  if (sysctl(mib, 4, &info, &size, NULL, 0) != 0) { if (errno == ESRCH) { puts("null"); return 0; } return 3; }
  if (!size || info.kp_proc.p_stat == SZOMB) { puts("null"); return 0; }
  printf("\"%lld:%06d\"\n", (long long)info.kp_proc.p_starttime.tv_sec, (int)info.kp_proc.p_starttime.tv_usec);
#elif defined(__linux__)
  char path[64], data[8192], boot[80]; snprintf(path, sizeof(path), "/proc/%ld/stat", value);
  FILE *file = fopen(path, "r");
  if (!file) { if (errno == ENOENT) { puts("null"); return 0; } return 3; }
  if (!fgets(data, sizeof(data), file)) { fclose(file); return 3; } fclose(file);
  char *last = strrchr(data, ')'); if (!last || !last[1]) return 3;
  char *save, *field = strtok_r(last + 2, " ", &save);
  if (field && (!strcmp(field, "Z") || !strcmp(field, "X"))) { puts("null"); return 0; }
  for (int n = 3; field && n < 22; n++) field = strtok_r(NULL, " ", &save);
  if (!field || strspn(field, "0123456789") != strlen(field)) return 3;
  file = fopen("/proc/sys/kernel/random/boot_id", "r"); if (!file) return 3;
  if (!fgets(boot, sizeof(boot), file)) { fclose(file); return 3; } fclose(file);
  boot[strcspn(boot, "\n")] = 0;
  if (strspn(boot, "0123456789abcdef-") != strlen(boot)) return 3;
  printf("\"%s:%s\"\n", boot, field);
#else
  return 3;
#endif
  return 0;
}

static int guard(const char *path) {
  if (*path != '/') return 2;
  int fd = open(path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return 3;
  struct stat info;
  if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_nlink != 1) { close(fd); return 3; }
  while (flock(fd, LOCK_EX)) { if (errno != EINTR) { close(fd); return 3; } }
  puts("ready"); fflush(stdout);
  char data[32]; ssize_t n;
  // The parent owns stdin. Its death/close releases the kernel lock, even after SIGKILL.
  do { n = read(STDIN_FILENO, data, sizeof(data)); } while (n > 0 || (n < 0 && errno == EINTR));
  close(fd); return n < 0 ? 3 : 0;
}

static int run(const char *cwd, const char *shell, const char *command) {
  if (*cwd != '/' || *shell != '/') return 2;
  char start = 0; ssize_t count;
  do { count = read(STDIN_FILENO, &start, 1); } while (count < 0 && errno == EINTR);
  if (count != 1 || start != 's') return 125;
  pid_t child = fork(); if (child < 0) return 3;
  if (!child) {
    if (setpgid(0, 0) || chdir(cwd)) _exit(126);
    // Setup scripts have no interactive input; fd 0 is reserved for parent liveness.
    int input = open("/dev/null", O_RDONLY); if (input < 0 || dup2(input, STDIN_FILENO) < 0) _exit(126); if (input != STDIN_FILENO) close(input);
    execl(shell, shell, "-lc", command, (char *)NULL); _exit(127);
  }
  setpgid(child, child);
  struct pollfd input = {STDIN_FILENO, POLLIN | POLLHUP, 0};
  int status = 0, cancelled = 0;
  for (;;) {
    siginfo_t info = {0};
    int result = waitid(P_PID, (id_t)child, &info, WEXITED | WNOHANG | WNOWAIT);
    if (result == 0 && info.si_pid == child) break;
    if (result < 0 && errno != EINTR) { cancelled = 1; break; }
    int resultPoll = poll(&input, 1, 100);
    struct stat output;
    if (resultPoll < 0 && errno != EINTR) { cancelled = 1; break; }
    if (input.revents & (POLLIN | POLLHUP | POLLERR)) { cancelled = 1; break; }
    if (!fstat(STDOUT_FILENO, &output) && S_ISREG(output.st_mode) && output.st_size > 64 * 1024 * 1024) { cancelled = 1; break; }
  }
  if (cancelled) {
    kill(-child, SIGTERM);
    // Keep the child unreaped until all group signals are sent, preventing PID reuse.
    usleep(1000000);
    kill(-child, SIGKILL); while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    return 125;
  }
  // A setup command is a finite preparation step; do not leave detached shell jobs behind.
  kill(-child, SIGTERM);
  kill(-child, SIGKILL);
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

int main(int argc, char **argv) {
  if (argc == 5 && !strcmp(argv[1], "run")) return run(argv[2], argv[3], argv[4]);
  if (argc != 3) return 2;
  if (!strcmp(argv[1], "identity")) return identity(argv[2]);
  if (!strcmp(argv[1], "guard")) return guard(argv[2]);
  return 2;
}
