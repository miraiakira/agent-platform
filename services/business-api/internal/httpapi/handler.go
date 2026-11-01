package httpapi

import (
	"encoding/json"
	"github.com/miraiakira/businese-api/internal/telemetry"
	"go.opentelemetry.io/otel"
	"net/http"
)

type HealthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}

func NewHandler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", healthHandler)

	mux.HandleFunc(
		"GET /api/transactions/high-risk",
		requireService(highRiskTransactionsHandler),
	)

	return telemetry.HTTP(mux, otel.Tracer("eap-business-api"))
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	response := HealthResponse{
		Status:  "ok",
		Service: "business-api",
	}

	if err := json.NewEncoder(w).Encode(response); err != nil {
		return
	}
}
