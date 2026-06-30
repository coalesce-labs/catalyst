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

	# CTL-1397: scripts and phase-bodies now read Linear through `catalyst-linear`
	# (replica-first), so the read path needs a `catalyst-linear` shim alongside
	# the `linearis` one. `read|list|search` return the same fixture/`{}` the
	# linearis `issues read` arm does; writes still go through the linearis shim.
	if [ -n "$read_fixture" ]; then
		cat >"${bin_dir}/catalyst-linear" <<EOF
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "catalyst-linear" "\$@" >> "\$LOG"
case "\$1" in
  read|list|search)
    cat "${read_fixture}"
    ;;
  *)
    printf 'catalyst-linear stub: unsupported subcommand: %s\n' "\$1" >&2
    exit 2
    ;;
esac
EOF
	else
		cat >"${bin_dir}/catalyst-linear" <<EOF
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "catalyst-linear" "\$@" >> "\$LOG"
case "\$1" in
  read|list|search)
    echo '{}'
    ;;
  *)
    printf 'catalyst-linear stub: unsupported subcommand: %s\n' "\$1" >&2
    exit 2
    ;;
esac
EOF
	fi
	chmod +x "${bin_dir}/catalyst-linear"
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

# linear_comment_post_stub_install — stub for linear-comment-post.sh (CTL-550).
# Creates a "linear-comment-post.sh" shim in bin_dir that logs args and exits 0.
linear_comment_post_stub_install() {
	local bin_dir="${1:?bin_dir required}"
	local log_file="${2:?log_file required}"
	mkdir -p "${bin_dir}"
	cat >"${bin_dir}/linear-comment-post.sh" <<EOF
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "\$@" >> "\$LOG"
echo '{"success":true}'
EOF
	chmod +x "${bin_dir}/linear-comment-post.sh"
}

linear_comment_post_stub_install_failing() {
	local bin_dir="${1:?bin_dir required}"
	local log_file="${2:?log_file required}"
	mkdir -p "${bin_dir}"
	cat >"${bin_dir}/linear-comment-post.sh" <<EOF
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "\$@" >> "\$LOG"
echo "linear-comment-post stub: simulated failure" >&2
exit 1
EOF
	chmod +x "${bin_dir}/linear-comment-post.sh"
}
