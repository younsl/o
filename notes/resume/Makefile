CHROME ?= $(shell command -v google-chrome-stable 2>/dev/null || command -v chromium 2>/dev/null || echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
HERE := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
TMP := $(HERE)/.resume.pdf.tmp

# Chrome stamps /CreationDate and /ModDate into the PDF, so two renders of the
# same HTML never compare equal. Both stamps are fixed-length strings, so
# rewriting them to a constant keeps every xref offset valid and makes the
# output reproducible. Without this the pre-commit hook would report the PDF as
# modified on every single commit.
.PHONY: pdf
pdf:
	@test -x "$(CHROME)" || { echo "chrome not found: $(CHROME)"; exit 1; }
	@"$(CHROME)" --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
		--print-to-pdf="$(TMP)" "file://$(HERE)/resume.html" 2>/dev/null
	@perl -pi -e "s/D:\d{14}\+00'00'/D:19700101000000+00'00'/g" "$(TMP)"
	@if cmp -s "$(TMP)" "$(HERE)/resume.pdf"; then \
		rm -f "$(TMP)"; echo "resume.pdf up to date"; \
	else \
		mv "$(TMP)" "$(HERE)/resume.pdf"; echo "regenerated resume.pdf"; \
	fi
