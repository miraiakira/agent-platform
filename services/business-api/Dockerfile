FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY go.mod ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux \
    go build -o /business-api ./cmd/server

FROM alpine:3.22

RUN apk add --no-cache ca-certificates \
    && addgroup -S app \
    && adduser -S app -G app

COPY --from=builder /business-api /usr/local/bin/business-api

USER app

EXPOSE 8080

CMD ["business-api"]