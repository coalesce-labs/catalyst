.PHONY: help lint format check-frontmatter check install-user install-project test clean favicons

# Default target - show help
help:
	@echo "Ryan Claude Workspace - Development Commands"
	@echo ""
	@echo "Quality Checks:"
	@echo "  make lint              - Run all Trunk linters (shellcheck, markdownlint, etc.)"
	@echo "  make format            - Auto-fix formatting issues with Trunk"
	@echo "  make check-frontmatter - Validate command/agent frontmatter consistency"
	@echo "  make check             - Run all quality checks (lint + frontmatter)"
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

# Validate frontmatter in commands and agents
check-frontmatter:
	@echo "Validating frontmatter in commands and agents..."
	@for file in commands/**/*.md agents/**/*.md .claude/commands/**/*.md .claude/agents/**/*.md; do \
		if [ -f "$$file" ]; then \
			./hack/validate-frontmatter.sh "$$file" || exit 1; \
		fi \
	done
	@echo "✅ All frontmatter valid!"

# Run all quality checks
check: lint check-frontmatter
	@echo ""
	@echo "✅ All quality checks passed!"

# Install to user's home directory
install-user:
	@echo "Installing to ~/.claude/..."
	@./hack/install-user.sh

# Install to a specific project (interactive)
install-project:
	@echo "Install workspace to a project"
	@read -p "Enter project path: " path; \
	./hack/install-project.sh "$$path"

# Run tests
test:
	@echo "Running plugin tests..."
	@bash plugins/dev/scripts/test-workflow-context.sh
	@echo ""
	@echo "✅ All test suites passed!"

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
