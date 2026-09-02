module dlq-sandboxed-replay

go 1.23.1

require github.com/solari-sdk/solari-sandbox-go v0.0.0

require github.com/gorilla/websocket v1.5.3 // indirect

replace github.com/solari-sdk/solari-sandbox-go => ./internal/vendor/solari-sandbox-go
