#!/usr/bin/env bash

_install_stat_stub() {
  local mockbin="$1" dialect="$2" real_stat host_dialect
  real_stat="$(command -v stat)"
  if "$real_stat" -c %Y "$0" >/dev/null 2>&1; then host_dialect=gnu; else host_dialect=bsd; fi
  mkdir -p "$mockbin"
  cat > "$mockbin/stat" <<EOF
#!/usr/bin/env bash
dialect='$dialect'; real_stat='$real_stat'; host_dialect='$host_dialect'
fmt="\${2-}"; path="\${3-}"
if [[ "\$dialect" == gnu && "\${1-}" == -f ]]; then printf '  File: "%s"\n    ID: 1 Namelen: 255 Type: fake\n' "\$path"; exit 1; fi
if [[ "\$dialect" == bsd && "\${1-}" == -c ]]; then echo 'stat: illegal option -- c' >&2; exit 1; fi
case "\$dialect:\$fmt" in
  gnu:%Y|bsd:%m) field=mtime ;;
  gnu:%s|bsd:%z) field=size ;;
  gnu:%a|bsd:%p) field=mode ;;
  gnu:%u|bsd:%u) field=owner ;;
  gnu:%i|bsd:%i) field=inode ;;
  *) exit 1 ;;
esac
if [[ "\$host_dialect" == gnu ]]; then
  case "\$field" in mtime) f=%Y;; size) f=%s;; mode) f=%a;; owner) f=%u;; inode) f=%i;; esac
  exec "\$real_stat" -c "\$f" "\$path"
else
  case "\$field" in mtime) f=%m;; size) f=%z;; mode) f=%p;; owner) f=%u;; inode) f=%i;; esac
  exec "\$real_stat" -f "\$f" "\$path"
fi
EOF
  chmod +x "$mockbin/stat"
}

stub_gnu_stat() { _install_stat_stub "$1" gnu; }
stub_bsd_stat() { _install_stat_stub "$1" bsd; }
unstub_stat() { rm -f "$1/stat"; }
