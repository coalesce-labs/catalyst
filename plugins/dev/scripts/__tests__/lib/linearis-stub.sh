#!/usr/bin/env bash
# Shared linearis-stub helper for phase-agent e2e tests (CTL-632).
#
# Two functions:
#   linearis_stub_install <bin_dir> <log_file> [read_fixture]
#       Writes a `linearis` shim that supports `issues read|discuss|update`,
#       logs every call's args to <log_file> one-per-line, and (for `read`)
#       prints the contents of <read_fixture> if given, else '{}'.
#
#   linearis_stub_install_failing <bin_dir> <log_file> [read_fixture]
#       Same shape, but the `issues discuss` arm exits non-zero (with a
#       stderr line) so callers can exercise the CTL-632 fail-open mirror.
#
# The body of each stub mirrors plugins/dev/scripts/__tests__/phase-triage-e2e.test.sh
# (the canonical stub) so existing assertions stay compatible.

linearis_stub_install() {
	local bin_dir="${1:?bin_dir required}"
	local log_file="${2:?log_file required}"
	local read_fixture="${3:-}"
	mkdir -p "${bin_dir}"

	# `cat <<EOF` (unquoted) so $log_file and $read_fixture expand at install
	# time; runtime variables ($1, $2, $@) are escaped with \$ to defer.
	if [ -n "$read_fixture" ]; then
		cat >"${bin_dir}/linearis" <<EOF
#!/usr/bin/env bash
LOG="${log_file}"
case "\$1" in
  issues)
    case "\$2" in
      read)
        printf '%s\n' "\$@" >> "\$LOG"
        cat "${read_fixture}"
        ;;
      discuss)
        printf '%s\n' "\$@" >> "\$LOG"
        echo '{"ok": true, "kind": "discuss"}'
        ;;
      update)
        printf '%s\n' "\$@" >> "\$LOG"
        echo '{"ok": true, "kind": "update"}'
        ;;
      *)
        printf 'linearis stub: unsupported issues subcommand: %s\n' "\$2" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    printf 'linearis stub: unsupported domain: %s\n' "\$1" >&2
    exit 2
    ;;
esac
EOF
	else
		cat >"${bin_dir}/linearis" <<EOF
#!/usr/bin/env bash
LOG="${log_file}"
case "\$1" in
  issues)
    case "\$2" in
      read)
        printf '%s\n' "\$@" >> "\$LOG"
        echo '{}'
        ;;
      discuss)
        printf '%s\n' "\$@" >> "\$LOG"
        echo '{"ok": true, "kind": "discuss"}'
        ;;
      update)
        printf '%s\n' "\$@" >> "\$LOG"
        echo '{"ok": true, "kind": "update"}'
        ;;
      *)
        printf 'linearis stub: unsupported issues subcommand: %s\n' "\$2" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    printf 'linearis stub: unsupported domain: %s\n' "\$1" >&2
    exit 2
    ;;
esac
EOF
	fi
	chmod +x "${bin_dir}/linearis"
}

linearis_stub_install_failing() {
	local bin_dir="${1:?bin_dir required}"
	local log_file="${2:?log_file required}"
	local read_fixture="${3:-}"
	mkdir -p "${bin_dir}"

	if [ -n "$read_fixture" ]; then
		cat >"${bin_dir}/linearis" <<EOF
#!/usr/bin/env bash
LOG="${log_file}"
case "\$1" in
  issues)
    case "\$2" in
      read)
        printf '%s\n' "\$@" >> "\$LOG"
        cat "${read_fixture}"
        ;;
      discuss)
        printf '%s\n' "\$@" >> "\$LOG"
        echo "linearis stub: simulated discuss failure" >&2
        exit 1
        ;;
      update)
        printf '%s\n' "\$@" >> "\$LOG"
        echo '{"ok": true, "kind": "update"}'
        ;;
      *)
        printf 'linearis stub: unsupported issues subcommand: %s\n' "\$2" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    printf 'linearis stub: unsupported domain: %s\n' "\$1" >&2
    exit 2
    ;;
esac
EOF
	else
		cat >"${bin_dir}/linearis" <<EOF
#!/usr/bin/env bash
LOG="${log_file}"
case "\$1" in
  issues)
    case "\$2" in
      read)
        printf '%s\n' "\$@" >> "\$LOG"
        echo '{}'
        ;;
      discuss)
        printf '%s\n' "\$@" >> "\$LOG"
        echo "linearis stub: simulated discuss failure" >&2
        exit 1
        ;;
      update)
        printf '%s\n' "\$@" >> "\$LOG"
        echo '{"ok": true, "kind": "update"}'
        ;;
      *)
        printf 'linearis stub: unsupported issues subcommand: %s\n' "\$2" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    printf 'linearis stub: unsupported domain: %s\n' "\$1" >&2
    exit 2
    ;;
esac
EOF
	fi
	chmod +x "${bin_dir}/linearis"
}
