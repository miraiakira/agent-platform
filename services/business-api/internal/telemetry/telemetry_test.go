package telemetry

import (
	"bytes"
	"context"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPContextAndPrivacy(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := trace.NewTracerProvider(trace.WithSyncer(exporter))
	defer provider.Shutdown(context.Background())
	handler := HTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }), provider.Tracer("test"))
	request := httptest.NewRequest("GET", "http://business/api/transactions/high-risk?secret=never-export", nil)
	request.Header.Set("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
	request.Header.Set("Authorization", "Bearer private-key")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	spans := exporter.GetSpans()
	if len(spans) != 1 || spans[0].SpanContext.TraceID().String() != "11111111111111111111111111111111" || spans[0].Parent.SpanID().String() != "2222222222222222" {
		t.Fatalf("context lost: %+v", spans)
	}
	for _, attr := range spans[0].Attributes {
		if attr.Value.AsString() == "never-export" || attr.Value.AsString() == "Bearer private-key" {
			t.Fatal("sensitive data exported")
		}
	}
}
func TestDisabledInit(t *testing.T) { t.Setenv("OTEL_ENABLED", "false"); Init(context.Background())() }

func TestLogRedaction(t *testing.T) {
	var output bytes.Buffer
	original := stdout
	stdout = slog.New(slog.NewJSONHandler(&output, nil))
	defer func() { stdout = original }()
	Event(context.Background(), "Bearer sk-secret", "postgres://password")
	if strings.Contains(output.String(), "secret") || strings.Contains(output.String(), "password") {
		t.Fatal("sensitive log content")
	}
	if !strings.Contains(output.String(), "redacted_event") {
		t.Fatal("expected redacted log")
	}
}
func TestHTTPErrorStatus(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := trace.NewTracerProvider(trace.WithSyncer(exporter))
	defer provider.Shutdown(context.Background())
	handler := HTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }), provider.Tracer("test"))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/health", nil))
	if exporter.GetSpans()[0].Status.Code.String() != "Error" {
		t.Fatal("missing error status")
	}
}
