// Command tunnel-agent is the lightweight per-VPS agent for tunnel-panel.
// It does not reimplement tunnel logic: it's a thin, authenticated HTTPS
// wrapper around the already-built, already-tested tunnel-manager.sh cores
// running locally on the same machine.
package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/authtoken"
	"github.com/dr-hoseyn/tunnel-panel/agent/internal/server"
	"github.com/dr-hoseyn/tunnel-panel/agent/internal/tlscert"
	"github.com/dr-hoseyn/tunnel-panel/agent/internal/tunnels"
	"github.com/dr-hoseyn/tunnel-panel/agent/internal/tunnelscript"
)

func main() {
	var (
		listenAddr  = flag.String("listen", ":8443", "HTTPS listen address")
		dataDir     = flag.String("data-dir", "/etc/tunnel-agent", "directory for the agent's token hash and TLS cert/key")
		scriptPath  = flag.String("script", "/opt/tunnel-manager/tunnel-manager.sh", "path to tunnel-manager.sh")
		initToken   = flag.Bool("init", false, "generate a new bearer token, print it once, and exit")
		fingerprint = flag.Bool("fingerprint", false, "print the agent's TLS cert fingerprint (generating the cert first if needed) and exit")
	)
	flag.Parse()

	tokenPath := filepath.Join(*dataDir, "token.hash")
	certPath := filepath.Join(*dataDir, "agent.crt")
	keyPath := filepath.Join(*dataDir, "agent.key")

	if *initToken {
		runInit(tokenPath)
		return
	}

	if *fingerprint {
		runFingerprint(certPath, keyPath)
		return
	}

	tokenHash, err := authtoken.LoadHash(tokenPath)
	if err != nil {
		log.Fatalf("no token found at %s -- run with -init first: %v", tokenPath, err)
	}

	cert, err := tlscert.LoadOrGenerate(certPath, keyPath)
	if err != nil {
		log.Fatalf("loading/generating TLS cert: %v", err)
	}

	if _, err := os.Stat(*scriptPath); err != nil {
		log.Printf("warning: tunnel-manager.sh not found at %s -- /metrics and /tunnels will fail until it's installed there: %v", *scriptPath, err)
	}

	tunnels.SetDataDir(*dataDir)
	store, err := tunnels.NewStore(filepath.Join(*dataDir, "tunnels"))
	if err != nil {
		log.Fatalf("initializing tunnel store: %v", err)
	}

	runner := tunnelscript.Runner{ScriptPath: *scriptPath, Timeout: 10 * time.Second}
	srv := server.New(tokenHash, tokenPath, runner, store)

	httpServer := &http.Server{
		Addr:         *listenAddr,
		Handler:      srv.Handler(),
		TLSConfig:    &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	log.Printf("tunnel-agent listening on %s (TLS)", *listenAddr)
	log.Fatal(httpServer.ListenAndServeTLS("", ""))
}

func runInit(tokenPath string) {
	token, err := authtoken.Generate()
	if err != nil {
		log.Fatalf("generating token: %v", err)
	}
	if err := authtoken.SaveHash(tokenPath, token); err != nil {
		log.Fatalf("saving token: %v", err)
	}
	fmt.Println("Agent bearer token -- save this now, it will not be shown again:")
	fmt.Println(token)
	fmt.Println()
	fmt.Println("Enter this token in the panel when registering this server.")
}

func runFingerprint(certPath, keyPath string) {
	if _, err := tlscert.LoadOrGenerate(certPath, keyPath); err != nil {
		log.Fatalf("loading/generating TLS cert: %v", err)
	}
	fp, err := tlscert.FingerprintSHA256(certPath)
	if err != nil {
		log.Fatalf("computing fingerprint: %v", err)
	}
	fmt.Println(fp)
}
