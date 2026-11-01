package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestSpoofedHeadersNeverReplaceServiceAuthentication(t *testing.T) {
	t.Setenv("BUSINESS_API_KEY", "test-only-business-api-key-32-chars")
	for _, key := range []string{"", "Bearer attacker-selected-service-key-32-chars"} {
		r := httptest.NewRequest(http.MethodGet, "/api/transactions/high-risk?date=2026-11-01", nil)
		r.Header.Set("Authorization", key)
		r.Header.Set("X-Eap-Tenant-Id", "00000000-0000-0000-0000-000000000001")
		r.Header.Set("X-Eap-Actor-Id", "owner")
		w := httptest.NewRecorder()
		NewHandler().ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("header spoof admitted: %d", w.Code)
		}
	}
}
func TestAmbiguousAndMalformedExecutionIdentityIsRejected(t *testing.T) {
	t.Setenv("BUSINESS_API_KEY", "test-only-business-api-key-32-chars")
	cases := []struct {
		name, header, value string
		duplicate           bool
		status              int
	}{
		{"duplicate credential", "Authorization", "Bearer attacker", true, 401},
		{"duplicate tenant", "X-Eap-Tenant-Id", "00000000-0000-0000-0000-000000000002", true, 403},
		{"duplicate actor", "X-Eap-Actor-Id", "other-actor", true, 403},
		{"invalid tenant", "X-Eap-Tenant-Id", "not-a-tenant", false, 403},
		{"empty actor", "X-Eap-Actor-Id", "", false, 403},
		{"whitespace actor", "X-Eap-Actor-Id", "   ", false, 403},
		{"combined actors", "X-Eap-Actor-Id", "actor,other", false, 403},
		{"oversized actor", "X-Eap-Actor-Id", strings.Repeat("a", 129), false, 403},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/transactions/high-risk?date=2026-11-01", nil)
			r.Header.Set("Authorization", "Bearer test-only-business-api-key-32-chars")
			r.Header.Set("X-Eap-Tenant-Id", "00000000-0000-0000-0000-000000000001")
			r.Header.Set("X-Eap-Actor-Id", "actor")
			if c.duplicate {
				r.Header.Add(c.header, c.value)
			} else {
				r.Header.Set(c.header, c.value)
			}
			w := httptest.NewRecorder()
			NewHandler().ServeHTTP(w, r)
			if w.Code != c.status {
				t.Fatalf("wanted %d, got %d", c.status, w.Code)
			}
			if strings.Contains(w.Body.String(), "test-only-business") || strings.Contains(w.Body.String(), "attacker") {
				t.Fatal("identity reflected in response")
			}
		})
	}
}
func TestConfiguredIdentitySucceedsAndHealthRemainsPublic(t *testing.T) {
	t.Setenv("BUSINESS_API_KEY", "test-only-business-api-key-32-chars")
	r := httptest.NewRequest(http.MethodGet, "/api/transactions/high-risk?date=2026-11-01&limit=1", nil)
	r.Header.Set("Authorization", "Bearer test-only-business-api-key-32-chars")
	r.Header.Set("X-Eap-Tenant-Id", "00000000-0000-0000-0000-000000000001")
	r.Header.Set("X-Eap-Actor-Id", "actor_01-allowed")
	w := httptest.NewRecorder()
	NewHandler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	health := httptest.NewRecorder()
	NewHandler().ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if health.Code != 200 {
		t.Fatal(health.Code)
	}
}
func TestNoDevelopmentKeyFallback(t *testing.T) {
	t.Setenv("BUSINESS_API_KEY", "")
	r := httptest.NewRequest(http.MethodGet, "/api/transactions/high-risk?date=2026-11-01", nil)
	r.Header.Set("Authorization", "Bearer test-only-business-api-key-32-chars")
	r.Header.Set("X-Eap-Tenant-Id", "00000000-0000-0000-0000-000000000001")
	r.Header.Set("X-Eap-Actor-Id", "actor")
	w := httptest.NewRecorder()
	NewHandler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
}
