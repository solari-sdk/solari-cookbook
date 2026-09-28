// SPDX-License-Identifier: AGPL-3.0-only
// What Debian bookworm, the machines' base, answers before wsp installs
// anything: the shells and the commands of coreutils, util-linux, findutils,
// grep, sed, gawk, procps, debianutils, apt, dpkg, tar, gzip, less, login and
// the network basics the image ships. The pack reads this so a carried rc
// file's call to `dircolors` or `stty` is never mistaken for a tool the image
// lacks and silenced.
export const BASE_IMAGE_COMMANDS: ReadonlySet<string> = new Set([
  "sh", "bash", "dash",
  "apt", "apt-get", "apt-cache", "apt-key", "dpkg", "dpkg-query", "dpkg-reconfigure", "update-alternatives", "debconf", "adduser", "addgroup", "useradd", "usermod", "groupadd", "passwd", "chsh", "login", "su", "id", "whoami", "groups", "users", "who", "w", "last",
  "ls", "dir", "vdir", "dircolors", "cat", "tac", "head", "tail", "more", "less", "cp", "mv", "rm", "ln", "mkdir", "rmdir", "mktemp", "touch", "chmod", "chown", "chgrp", "install", "stat", "df", "du", "sync", "readlink", "realpath", "basename", "dirname", "pwd", "pathchk", "mkfifo", "mknod", "dd", "truncate", "shred", "link", "unlink",
  "echo", "printf", "yes", "true", "false", "test", "expr", "seq", "sleep", "date", "cal", "env", "printenv", "nice", "nohup", "timeout", "stdbuf", "tee", "tty", "stty", "clear", "reset", "tput", "tset", "infocmp", "uname", "hostname", "hostid", "arch", "nproc", "uptime", "logname",
  "sort", "uniq", "wc", "cut", "paste", "join", "tr", "fold", "fmt", "pr", "nl", "od", "xxd", "hexdump", "base64", "base32", "basenc", "md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "cksum", "sum", "comm", "csplit", "split", "shuf", "tsort", "expand", "unexpand", "numfmt", "factor", "column", "rev", "look",
  "grep", "egrep", "fgrep", "rgrep", "sed", "awk", "gawk", "mawk", "find", "xargs", "locate", "updatedb", "diff", "diff3", "cmp", "sdiff", "patch", "file", "strings", "which", "whereis", "type",
  "tar", "gzip", "gunzip", "zcat", "bzip2", "bunzip2", "bzcat", "xz", "unxz", "xzcat", "lzma", "zstd", "cpio", "ar",
  "ps", "top", "kill", "killall", "pkill", "pgrep", "pidof", "free", "vmstat", "watch", "pmap", "sysctl", "fuser", "lsof", "time", "ulimit", "renice", "ionice", "taskset", "chrt", "prlimit", "setsid", "setpriv", "flock", "script", "scriptreplay", "logger", "dmesg",
  "mount", "umount", "findmnt", "lsblk", "blkid", "fdisk", "losetup", "swapon", "swapoff", "fstrim", "mkswap", "chroot", "nsenter", "unshare", "ldd", "ldconfig", "getent", "getconf", "locale", "localedef", "iconv",
  "ip", "ping", "ss", "netstat", "ifconfig", "route", "dig", "nslookup", "host", "wget", "curl", "ssh", "scp", "sftp", "ssh-add", "ssh-agent", "ssh-keygen", "ssh-keyscan", "nc", "telnet", "traceroute", "gpg", "gpgv", "gpg-agent", "openssl",
  "vi", "vim", "nano", "ed", "editor", "pager", "sensible-editor", "sensible-pager", "sensible-browser", "run-parts", "savelog", "tempfile", "ischroot", "add-shell", "remove-shell", "invoke-rc.d", "service", "start-stop-daemon", "update-rc.d",
  "perl", "python3", "pip3", "make", "gcc", "cc", "g++", "c++", "ld", "as", "nm", "objdump", "strip", "readelf", "cpp", "gdb", "man", "info", "whatis", "apropos", "help2man", "groff", "troff", "nroff",
  "crontab", "at", "batch", "chattr", "lsattr", "getcap", "setcap", "getfacl", "setfacl", "chcon", "runcon", "mesg", "wall", "write", "pinky", "finger", "sg", "newgrp", "chfn", "expiry", "chage", "gpasswd", "vipw", "vigr", "pwck", "grpck",
]);
