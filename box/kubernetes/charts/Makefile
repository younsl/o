CHARTS_DIR ?= .
APP_CHARTS_DIR ?= ..
SHARED_TEMPLATE ?= README.md.gotmpl

# Generate documentation for all charts
.PHONY: docs
docs: docs-standalone docs-app

# Generate docs for standalone charts (using shared template)
.PHONY: docs-standalone
docs-standalone:
	@for chart in $(CHARTS_DIR)/*/; do \
		if [ -f "$$chart/Chart.yaml" ]; then \
			echo "Generating docs for $$chart"; \
			helm-docs --chart-search-root "$$chart" --template-files="$(CURDIR)/$(SHARED_TEMPLATE)" --sort-values-order file --log-level info; \
		fi \
	done

# Generate docs for app charts (local template, fallback to shared template)
.PHONY: docs-app
docs-app:
	@find $(APP_CHARTS_DIR) -path '$(APP_CHARTS_DIR)/charts' -prune -o -name Chart.yaml -print | while read chart_yaml; do \
		chart_dir=$$(dirname "$$chart_yaml"); \
		if [ -f "$$chart_dir/README.md.gotmpl" ]; then \
			echo "Generating docs for $$chart_dir (local template)"; \
			helm-docs --chart-search-root "$$chart_dir" --template-files="README.md.gotmpl" --sort-values-order file --log-level info; \
		else \
			echo "Generating docs for $$chart_dir (shared template)"; \
			helm-docs --chart-search-root "$$chart_dir" --template-files="$(CURDIR)/$(SHARED_TEMPLATE)" --sort-values-order file --log-level info; \
		fi \
	done
