package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/miraiakira/businese-api/internal/httpapi"
)

func main() {
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           httpapi.NewHandler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("business-api listening on %s", addr)

	if err := server.ListenAndServe(); err != nil &&
		err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
