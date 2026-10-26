package httpapi

import (
	"encoding/json"
	"net/http"
)

type HealthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}

func NewHandler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", healthHandler)

	return mux
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
