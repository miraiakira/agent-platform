package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthHandler(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/health",
		nil,
	)

	recorder := httptest.NewRecorder()

	NewHandler().ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf(
			"expected 200, got %d",
			recorder.Code,
		)
	}

	var response HealthResponse

	if err := json.Unmarshal(
		recorder.Body.Bytes(),
		&response,
	); err != nil {
		t.Fatal(err)
	}

	if response.Status != "ok" {
		t.Fatalf(
			"unexpected status: %s",
			response.Status,
		)
	}

	if response.Service != "business-api" {
		t.Fatalf(
			"unexpected service: %s",
			response.Service,
		)
	}
}
