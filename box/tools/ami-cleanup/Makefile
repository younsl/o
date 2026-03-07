BINARY_NAME := ami-cleanup
INSTALL_DIR := $(HOME)/.local/bin

.PHONY: build release install clean check fmt lint test

build:
	cargo build

release:
	cargo build --release

install: release
	@mkdir -p $(INSTALL_DIR)
	cp target/release/$(BINARY_NAME) $(INSTALL_DIR)/
	@echo "Installed to $(INSTALL_DIR)/$(BINARY_NAME)"

clean:
	cargo clean

check:
	cargo check

fmt:
	cargo fmt

lint:
	cargo clippy -- -D warnings

test:
	cargo test
