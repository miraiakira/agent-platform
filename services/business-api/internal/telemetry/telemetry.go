package telemetry

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	otellog "go.opentelemetry.io/otel/log"
	logglobal "go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var codePattern = regexp.MustCompile(`^[A-Z_]{1,64}$`)

var stdout = slog.New(slog.NewJSONHandler(os.Stdout, nil))

func Init(ctx context.Context) func() {
	if os.Getenv("OTEL_ENABLED") != "true" {
		return func() {}
	}
	// Avoid default SDK error logs leaking exporter URLs or headers.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) { Event(context.Background(), "telemetry.export_failed", "EXPORT_FAILED") }))
	res := resource.NewWithAttributes("", attribute.String("service.name", "eap-business-api"), attribute.String("service.version", "0.1.0"))
	te, err := otlptracehttp.New(ctx, otlptracehttp.WithTimeout(time.Second))
	if err != nil {
		return func() {}
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithResource(res), sdktrace.WithBatcher(te, sdktrace.WithBatchTimeout(time.Second), sdktrace.WithExportTimeout(time.Second)))
	otel.SetTracerProvider(tp)
	le, err := otlploghttp.New(ctx, otlploghttp.WithTimeout(time.Second))
	var lp *sdklog.LoggerProvider
	if err == nil {
		lp = sdklog.NewLoggerProvider(sdklog.WithResource(res), sdklog.WithProcessor(sdklog.NewBatchProcessor(le, sdklog.WithExportInterval(time.Second), sdklog.WithExportTimeout(time.Second))))
		logglobal.SetLoggerProvider(lp)
	}
	return func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = tp.Shutdown(shutdown)
		if lp != nil {
			_ = lp.Shutdown(shutdown)
		}
	}
}

// Only fixed event names and error codes enter logs; no URL, headers or payload.
func Event(ctx context.Context, message, errorCode string) {
	switch message {
	case "http.request", "server.started", "server.failed", "telemetry.export_failed":
	default:
		message = "redacted_event"
	}
	if errorCode != "" && !codePattern.MatchString(errorCode) {
		errorCode = "INTERNAL_ERROR"
	}
	sc := trace.SpanContextFromContext(ctx)
	traceID, spanID := "", ""
	if sc.IsValid() {
		traceID, spanID = sc.TraceID().String(), sc.SpanID().String()
	}
	level, severity := slog.LevelInfo, otellog.SeverityInfo
	if errorCode != "" {
		level, severity = slog.LevelError, otellog.SeverityError
	}
	stdout.Log(ctx, level, message, "service", "eap-business-api", "trace_id", traceID, "span_id", spanID, "error_code", errorCode)
	// Export only request events, never recursively report exporter failures via OTLP.
	if message == "telemetry.export_failed" {
		return
	}
	record := otellog.Record{}
	record.SetTimestamp(time.Now())
	record.SetSeverity(severity)
	record.SetBody(otellog.StringValue(message))
	record.AddAttributes(otellog.String("error_code", errorCode))
	logglobal.GetLoggerProvider().Logger("eap-http").Emit(ctx, record)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *statusWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func HTTP(next http.Handler, tracer trace.Tracer) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := "unknown"
		if r.URL.Path == "/api/health" {
			route = "/api/health"
		}
		if r.URL.Path == "/api/transactions/high-risk" {
			route = "/api/transactions/high-risk"
		}
		ctx := propagation.TraceContext{}.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		method := r.Method
		switch method {
		case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS":
		default:
			method = "OTHER"
		}
		ctx, span := tracer.Start(ctx, "business.http", trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(attribute.String("http.route", route), attribute.String("http.request.method", method)))
		defer span.End()
		writer := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(writer, r.WithContext(ctx))
		status := writer.status
		if status == 0 {
			status = http.StatusOK
		}
		span.SetAttributes(attribute.Int("http.response.status_code", status))
		code := ""
		if status >= 500 {
			code = "HTTP_ERROR"
			span.SetStatus(codes.Error, code)
		}
		Event(ctx, "http.request", code)
	})
}
