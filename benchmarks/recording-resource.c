// macOS-only, read-only observer. Compile with clang; no npm runtime dependency.
#include <errno.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

#define CAPACITY 4096
typedef struct {
  int pid, parent, samples;
  uint64_t birth, user, system, footprint, rss, last_ns;
  char path[PROC_PIDPATHINFO_MAXSIZE];
} Reading;
static Reading readings[CAPACITY];
static int count;
static mach_timebase_info_data_t timebase;

static double cpu_ms(uint64_t ticks) {
  return (double)ticks * timebase.numer / timebase.denom / 1000000;
}

static uint64_t now_ns(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) exit(2);
  return (uint64_t)value.tv_sec * 1000000000 + (uint64_t)value.tv_nsec;
}

static void observe(int pid, int parent) {
  struct rusage_info_v4 usage;
  if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) return;
  Reading *entry = NULL;
  for (int i = 0; i < count; i++) {
    if (readings[i].pid == pid && readings[i].birth == usage.ri_proc_start_abstime) entry = &readings[i];
  }
  if (entry == NULL) {
    if (count == CAPACITY) { fprintf(stderr, "observer capacity exhausted\n"); exit(2); }
    entry = &readings[count++];
    entry->pid = pid;
    entry->parent = parent;
    entry->birth = usage.ri_proc_start_abstime;
  }
  // A forked child may exec between samples. Retain the latest readable executable, with the same birth identity.
  char current_path[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath(pid, current_path, sizeof(current_path)) > 0) strcpy(entry->path, current_path);
  else if (entry->samples == 0) strcpy(entry->path, "unreadable");
  entry->samples++;
  entry->user = usage.ri_user_time;
  entry->system = usage.ri_system_time;
  if (usage.ri_lifetime_max_phys_footprint > entry->footprint) entry->footprint = usage.ri_lifetime_max_phys_footprint;
  if (usage.ri_resident_size > entry->rss) entry->rss = usage.ri_resident_size;
  entry->last_ns = now_ns();
  int children[CAPACITY];
  // This convenience API returns a pid count, while its buffer size is in bytes.
  errno = 0;
  int children_count = proc_listchildpids(pid, children, sizeof(children));
  if (children_count < 0 || (children_count == 0 && errno != 0 && errno != ESRCH)) { fprintf(stderr, "cannot read descendants of %d\n", pid); exit(2); }
  if (children_count >= CAPACITY) { fprintf(stderr, "descendant capacity exhausted\n"); exit(2); }
  for (int i = 0; i < children_count; i++) if (children[i] > 1) observe(children[i], pid);
}

// Escape paths too. Application text and process paths never become JSON syntax.
static void quoted(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') printf("\\%c", *p);
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}

int main(int argc, char **argv) {
  if (argc != 3) { fprintf(stderr, "usage: observer <launched-pid> <limit-ms>\n"); return 2; }
  char *end;
  long root = strtol(argv[1], &end, 10);
  if (*end || root < 2) return 2;
  long limit = strtol(argv[2], &end, 10);
  if (*end || limit < 1) return 2;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) return 2;
  const uint64_t started = now_ns();
  uint64_t largest_gap = 0, previous = started;
  while (kill((int)root, 0) == 0 || errno != ESRCH) {
    uint64_t at = now_ns();
    if (at - started > (uint64_t)limit * 1000000) { fprintf(stderr, "observer limit reached\n"); return 2; }
    if (at - previous > largest_gap) largest_gap = at - previous;
    previous = at;
    observe((int)root, getppid());
    const struct timespec pause = { .tv_sec = 0, .tv_nsec = 5000000 };
    nanosleep(&pause, NULL);
  }
  printf("{\"schemaVersion\":1,\"intervalMs\":5,\"cpuClock\":\"mach-absolute\",\"timebaseNumer\":%u,\"timebaseDenom\":%u,\"largestGapMs\":%.6f,\"processes\":[", timebase.numer, timebase.denom, (double)largest_gap / 1000000);
  for (int i = 0; i < count; i++) {
    Reading *r = &readings[i];
    if (i) putchar(',');
    printf("{\"pid\":%d,\"parentPid\":%d,\"startIdentity\":\"%llu\",\"path\":", r->pid, r->parent, (unsigned long long)r->birth);
    quoted(r->path);
    printf(",\"samples\":%d,\"userCpuMs\":%.6f,\"systemCpuMs\":%.6f,\"peakFootprintBytes\":%llu,\"sampledPeakRssBytes\":%llu,\"lastSampleElapsedMs\":%.6f}", r->samples, cpu_ms(r->user), cpu_ms(r->system), (unsigned long long)r->footprint, (unsigned long long)r->rss, (double)(r->last_ns - started) / 1000000);
  }
  puts("]}");
  return 0;
}
