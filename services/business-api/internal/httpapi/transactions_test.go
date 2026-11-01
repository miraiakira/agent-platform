package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHighRiskTransactions(t *testing.T) {
	t.Setenv("BUSINESS_API_KEY", "test-only-business-api-key-32-chars")
	date := time.Now().UTC().Format("2006-01-02")

	req := httptest.NewRequest(
		http.MethodGet,
		"/api/transactions/high-risk?date="+date+"&limit=2",
		nil,
	)

	rec := httptest.NewRecorder()
	req.Header.Set("Authorization", "Bearer test-only-business-api-key-32-chars")
	req.Header.Set("X-Eap-Tenant-Id", "00000000-0000-0000-0000-000000000001")
	req.Header.Set("X-Eap-Actor-Id", "test-actor")
	NewHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var result TransactionListResponse

	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}

	if result.Total != 3 {
		t.Fatalf("expected 3 high-risk transactions, got %d", result.Total)
	}

	if len(result.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(result.Items))
	}

	if result.Items[0].RiskScore < result.Items[1].RiskScore {
		t.Fatal("transactions are not sorted by risk score")
	}
}

func TestHighRiskTransactionsRejectsInvalidLimit(t *testing.T) {
	t.Setenv("BUSINESS_API_KEY", "test-only-business-api-key-32-chars")
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/transactions/high-risk?date=2026-10-28&limit=100",
		nil,
	)

	rec := httptest.NewRecorder()
	req.Header.Set("Authorization", "Bearer test-only-business-api-key-32-chars")
	req.Header.Set("X-Eap-Tenant-Id", "00000000-0000-0000-0000-000000000001")
	req.Header.Set("X-Eap-Actor-Id", "test-actor")
	NewHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}
