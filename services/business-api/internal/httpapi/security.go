package httpapi

import (
	"crypto/subtle"
	"net/http"
	"os"
	"regexp"
)

var actorID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)
var tenantID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Only trusted application/worker callers may assert a tenant, never a browser.
func requireService(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := os.Getenv("BUSINESS_API_KEY")
		// Reject ambiguous credentials rather than trusting whichever duplicate a proxy picks.
		if len(r.Header.Values("Authorization")) != 1 || len(key) < 32 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+key)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if len(r.Header.Values("X-Eap-Tenant-Id")) != 1 || len(r.Header.Values("X-Eap-Actor-Id")) != 1 ||
			!tenantID.MatchString(r.Header.Get("X-Eap-Tenant-Id")) || !actorID.MatchString(r.Header.Get("X-Eap-Actor-Id")) {
			http.Error(w, "invalid execution context", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}
