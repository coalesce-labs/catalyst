.PHONY: help lint format check install-user install-project test clean favicons

# Default target - show help
help:
	@echo "Ryan Claude Workspace - Development Commands"
	@echo ""
	@echo "Quality Checks:"
	@echo "  make lint              - Run all Trunk linters (shellcheck, markdownlint, etc.)"
	@echo "  make format            - Auto-fix formatting issues with Trunk"
	@echo "  make test              - Run the full test suite (shell + bun)"
	@echo "  make check             - Run all quality checks (lint + test)"
	@echo ""
	@echo "Installation:"
	@echo "  make install-user      - Install workspace to ~/.claude/"
	@echo "  make install-project   - Install workspace to a project (interactive)"
	@echo ""
	@echo "Brand assets:"
	@echo "  make favicons          - Build the V2 favicon set + distribute to consumers"
	@echo ""
	@echo "Maintenance:"
	@echo "  make clean             - Clean temporary files and caches"
	@echo ""

# Run Trunk linters
lint:
	@echo "Running Trunk linters..."
	trunk check

# Auto-fix formatting issues
format:
	@echo "Auto-fixing formatting issues..."
	trunk fmt

# Run all quality checks (real audit gate)
check: lint test
	@echo ""
	@echo "✅ All quality checks passed (lint + test)!"

# Install to user's home directory
install-user:
	@echo "Installing to ~/.claude/..."
	@./hack/install-user.sh

# Install to a specific project (interactive)
install-project:
	@echo "Install workspace to a project"
	@read -p "Enter project path: " path; \
	./hack/install-project.sh "$$path"

# Run the full test suite (shell + bun)
test:
	@echo "Running full test suite (shell + bun)..."
	@bash plugins/dev/scripts/run-tests.sh

# Build the V2 favicon set from CTL-147 mark assets and distribute to all consumer
# locations (repo root, website/public, plugins/dev/scripts/orch-monitor/public).
# Requires rsvg-convert + ImageMagick (brew install librsvg imagemagick).
favicons:
	@echo "Building V2 favicon set..."
	@bash assets/brand-v2/favicons/build.sh

# Clean temporary files
clean:
	@echo "Cleaning temporary files..."
	@find . -name "*.tmp" -delete
	@find . -name ".DS_Store" -delete
	@rm -f .claude/config.json.tmp .catalyst/config.json.tmp
	@echo "✅ Cleaned!"
