ARG BASE_IMAGE=otel/opentelemetry-collector-contrib:0.135.0
FROM golang:1.26-alpine AS probe
WORKDIR /src
COPY healthcheck.go .
RUN CGO_ENABLED=0 go build -o /healthcheck healthcheck.go
FROM ${BASE_IMAGE}
COPY --from=probe /healthcheck /eap-healthcheck
