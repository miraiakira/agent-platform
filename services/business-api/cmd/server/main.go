package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/miraiakira/businese-api/internal/httpapi"
	"github.com/miraiakira/businese-api/internal/telemetry"
)

func main() { os.Exit(run()) }

func run() int {
	if len(os.Getenv("BUSINESS_API_KEY")) < 32 {
		telemetry.Event(context.Background(), "server.configuration_failed", "BUSINESS_API_KEY_REQUIRED")
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownTelemetry := telemetry.Init(ctx)
	defer shutdownTelemetry()
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           httpapi.NewHandler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	telemetry.Event(ctx, "server.started", "")
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	case err := <-done:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			telemetry.Event(ctx, "server.failed", "HTTP_SERVER_ERROR")
			return 1
		}
	}
	return 0
}
