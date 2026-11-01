package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestServiceBoundary(t *testing.T) {
	t.Setenv("BUSINESS_API_KEY", "test-only-business-api-key-32-chars")
	for _, c := range []struct {
		key, tenant, actor string
		want               int
	}{
		{"", "", "", 401}, {"Bearer wrong", "", "", 401},
		{"Bearer test-only-business-api-key-32-chars", "", "", 403},
		{"Bearer test-only-business-api-key-32-chars", "00000000-0000-0000-0000-000000000001", "actor", 400},
	} {
		r := httptest.NewRequest(http.MethodGet, "/api/transactions/high-risk", nil)
		r.Header.Set("Authorization", c.key)
		r.Header.Set("X-Eap-Tenant-Id", c.tenant)
		r.Header.Set("X-Eap-Actor-Id", c.actor)
		w := httptest.NewRecorder()
		NewHandler().ServeHTTP(w, r)
		if w.Code != c.want {
			t.Fatalf("want %d got %d", c.want, w.Code)
		}
	}
}
func TestMissingServiceKeyFailsClosed(t *testing.T) {
	t.Setenv("BUSINESS_API_KEY", "")
	r := httptest.NewRequest(http.MethodGet, "/api/transactions/high-risk", nil)
	w := httptest.NewRecorder()
	NewHandler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
}
