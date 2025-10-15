#!/usr/bin/env bash
# Check prerequisites for workflow commands

set -euo pipefail

# Check if HumanLayer CLI is installed
check_humanlayer() {
	if ! command -v humanlayer &>/dev/null; then
		echo "❌ HumanLayer CLI not found"
		echo ""
		echo "Install it:"
		echo "  brew install humanlayer/tap/humanlayer"
		echo "  # or"
		echo "  curl -sSL https://humanlayer.dev/install.sh | bash"
		echo ""
		echo "Then initialize:"
		echo "  humanlayer thoughts init"
		return 1
	fi
	return 0
}

# Check if thoughts are initialized
check_thoughts() {
	if ! humanlayer thoughts status &>/dev/null; then
		echo "❌ HumanLayer thoughts not initialized"
		echo ""
		echo "Initialize:"
		echo "  humanlayer thoughts init"
		echo "  humanlayer thoughts sync"
		return 1
	fi
	return 0
}

# Check jq is installed
check_jq() {
	if ! command -v jq &>/dev/null; then
		echo "❌ jq not found"
		echo ""
		echo "Install it:"
		echo "  brew install jq"
		echo "  # or"
		echo "  apt-get install jq  # Linux"
		return 1
	fi
	return 0
}

# Main check
main() {
	local failed=0

	# shellcheck disable=SC2310 # Intentionally using functions in || to capture failures
	check_humanlayer || failed=1
	# shellcheck disable=SC2310
	check_thoughts || failed=1
	# shellcheck disable=SC2310
	check_jq || failed=1

	if [[ $failed -eq 1 ]]; then
		echo ""
		echo "Please install missing prerequisites and try again."
		exit 1
	fi

	echo "✅ All prerequisites satisfied"
	return 0
}

main "$@"
