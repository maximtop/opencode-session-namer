.PHONY: init lint type-check test check

init:
	pnpm install

lint:
	pnpm lint

type-check:
	pnpm type-check

test:
	pnpm test

check: lint type-check test
