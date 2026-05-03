.PHONY: help lint template install upgrade uninstall package push docs clean

CHART_NAME := copyfail-guard
CHART_VERSION := $(shell grep '^version:' Chart.yaml | awk '{print $$2}')
NAMESPACE ?= kube-system
RELEASE_NAME ?= copyfail-guard
OCI_REGISTRY ?= oci://ghcr.io/younsl/charts

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

lint: ## Lint the chart
	helm lint .

template: ## Render templates locally
	helm template $(RELEASE_NAME) . --namespace $(NAMESPACE)

install: ## Install chart
	helm install $(RELEASE_NAME) . --namespace $(NAMESPACE) --create-namespace

upgrade: ## Upgrade chart
	helm upgrade $(RELEASE_NAME) . --namespace $(NAMESPACE) --install

uninstall: ## Uninstall chart
	helm uninstall $(RELEASE_NAME) --namespace $(NAMESPACE)

package: ## Package chart as tgz
	helm package .

push: package ## Push packaged chart to OCI registry
	helm push $(CHART_NAME)-$(CHART_VERSION).tgz $(OCI_REGISTRY)

docs: ## Regenerate README.md from values.yaml using helm-docs
	helm-docs --chart-search-root .

clean: ## Remove packaged chart
	rm -f $(CHART_NAME)-*.tgz
