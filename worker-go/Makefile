# blk-sync (Go). Needs Go 1.26+.
VERSION ?= 1.3.0
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build linux linux-arm64 test vet package clean

build:            ## binary for this machine, in bin/
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/ ./cmd/blk-sync

linux:            ## static Linux amd64 binary, in dist/
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/blk-sync ./cmd/blk-sync

linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/blk-sync-arm64 ./cmd/blk-sync

test:
	go test ./...

vet:
	go vet ./...

package: linux    ## dist/blk-sync-$(VERSION)-linux-amd64.tar.gz: binary + install script + unit + config + docs
	cp deploy/install.sh deploy/blk-sync.service deploy/blk-sync-legacy.service config.example.json README.md dist/
	tar -C dist -czf dist/blk-sync-$(VERSION)-linux-amd64.tar.gz blk-sync install.sh blk-sync.service blk-sync-legacy.service config.example.json README.md

clean:
	rm -rf bin dist
