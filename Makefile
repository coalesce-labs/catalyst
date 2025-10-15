.PHONY: help lint format check-frontmatter check install-user install-project test clean

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

# Run tests (placeholder for future)
test:
	@echo "⚠️  No tests configured yet"
	@echo "TODO: Add tests for:"
	@echo "  - Command frontmatter validation"
	@echo "  - Installation script behavior"
	@echo "  - Configuration file handling"

# Clean temporary files
clean:
	@echo "Cleaning temporary files..."
	@find . -name "*.tmp" -delete
	@find . -name ".DS_Store" -delete
	@rm -f .claude/config.json.tmp
	@echo "✅ Cleaned!"
