.PHONY: build test vet fuzz vuln gen-proto run keys dist clean

build:
	go build -o dist/broker ./cmd/broker

test:
	go test ./... -timeout 90s

vet:
	go vet ./...

fuzz:
	go test -run=NONE -fuzz=FuzzValidateChannel -fuzztime=10s ./internal/hub/
	go test -run=NONE -fuzz=FuzzInboundJSON -fuzztime=10s ./internal/server/

vuln:
	govulncheck ./...

gen-proto:
	buf generate proto

run: build
	go run ./cmd/broker

keys:
	go run ./cmd/broker -gen-keys ./devkeys

# Linux release binary + checksum (run on a machine with sha256sum for the .sha256)
dist:
	mkdir -p dist
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/broker ./cmd/broker
	@if command -v sha256sum >/dev/null; then sha256sum dist/broker > dist/broker.sha256; fi

clean:
	rm -rf dist
