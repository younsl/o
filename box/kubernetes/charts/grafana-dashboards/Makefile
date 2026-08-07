.PHONY: help lint template install upgrade uninstall package push clean

CHART_NAME := grafana-dashboards
VERSION := $(shell grep '^version:' Chart.yaml | awk '{print $$2}')
NAMESPACE := monitoring
RELEASE_NAME := grafana-dashboards
REGISTRY := ghcr.io/younsl/charts

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

lint: ## Lint the chart
	helm lint .

template: ## Render chart templates locally
	helm template $(RELEASE_NAME) . --namespace $(NAMESPACE)

install: ## Install chart to cluster
	helm install $(RELEASE_NAME) . --namespace $(NAMESPACE) --create-namespace

upgrade: ## Upgrade chart release
	helm upgrade $(RELEASE_NAME) . --namespace $(NAMESPACE)

uninstall: ## Uninstall chart release
	helm uninstall $(RELEASE_NAME) --namespace $(NAMESPACE)

package: ## Package chart as tgz
	helm package . --version $(VERSION)

push: package ## Push chart to OCI registry
	helm push $(CHART_NAME)-$(VERSION).tgz oci://$(REGISTRY)

clean: ## Remove packaged chart
	rm -f $(CHART_NAME)-*.tgz

tag: ## Create and push git tag for release
	git tag $(CHART_NAME)/charts/$(VERSION)
	git push origin $(CHART_NAME)/charts/$(VERSION)
