package httpapi

import (
	"crypto/subtle"
	"net/http"
	"os"
	"regexp"
)

var tenantID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Only trusted application/worker callers may assert a tenant, never a browser.
func requireService(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := os.Getenv("BUSINESS_API_KEY")
		if len(key) < 32 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+key)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !tenantID.MatchString(r.Header.Get("X-Eap-Tenant-Id")) || r.Header.Get("X-Eap-Actor-Id") == "" {
			http.Error(w, "invalid execution context", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}
