# shellcheck shell=bash
# ~/.config/direnv/lib/profiles.sh
# Loaded automatically by direnv from ~/.config/direnv/lib/
#
# ⛔ CTL-1956: VENDORED HERE BECAUSE IT WAS IN NO REPOSITORY AT ALL. This file defines
# `use_profile`, which every Catalyst .envrc calls. It was byte-identical on the laptop and mini
# (md5 240be04758b32b03965774cb9daef5da) purely because somebody once copied it to two machines —
# and it was ABSENT on mini-2, where `use_profile` was therefore an undefined function, so .envrc
# evaluation failed and every token read EMPTY. install-cli.sh's ensure_direnv_runtime installs it.
# It carries no secrets; the secrets live in the profiles/ files it sources.
#
# Usage in .envrc files:
#   use_profile personal          # Load base profile
#   use_profile slides            # Layer project-specific overrides
#
# Profiles are loaded in order — later profiles override earlier ones.
# This enables a pattern like:
#
#   ~/.config/direnv/profiles/personal.env     # Global defaults (AI keys, cloud accounts)
#   ~/.config/direnv/profiles/slides.env       # Project-specific overrides (ElevenLabs, PostHog)
#   ~/.config/direnv/profiles/adva.env         # Client-specific keys
#
# Directory hierarchy:
#   ~/conductor/workspaces/slides/.envrc       → use_profile personal + use_profile slides
#   ~/conductor/workspaces/slides/oslo/.envrc  → source_env_if_exists .env.project (optional local overrides)
#
# The DEV_PROFILES variable tracks all loaded profiles (comma-separated).

use_profile() {
	local profile="$1"
	local profile_env="$HOME/.config/direnv/profiles/${profile}.env"

	if [ -z "$profile" ]; then
		log_error "use_profile requires a profile name (e.g., personal, slides, adva)"
		return 1
	fi

	if [ ! -f "$profile_env" ]; then
		if [ -f "${profile_env}.example" ]; then
			log_error "Profile env file not found: $profile_env"
			log_error "Copy the .example file and fill in your values:"
			log_error "  cp ${profile_env}.example ${profile_env}"
		else
			log_error "Profile not found: $profile_env"
			log_error "Create it with your project-specific variables."
		fi
		return 1
	fi

	# Track loaded profiles (comma-separated for debugging)
	if [ -z "$DEV_PROFILES" ]; then
		export DEV_PROFILES="$profile"
	else
		export DEV_PROFILES="${DEV_PROFILES},${profile}"
	fi

	# Keep DEV_PROFILE pointing to the most recently loaded profile
	export DEV_PROFILE="$profile"

	source_env "$profile_env"
}
