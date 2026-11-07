# Same PostgreSQL 17.11 / Alpine 3.24 base as the existing local data volume.
ARG POSTGRES_BASE=postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
FROM ${POSTGRES_BASE} AS vector-build
ARG PGVECTOR_VERSION=0.8.2
RUN set -eux; \
    apk add --no-cache build-base curl; \
    curl -fsSL --retry 3 "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" -o /tmp/pgvector.tar.gz; \
    tar -xzf /tmp/pgvector.tar.gz -C /tmp; \
    make -C "/tmp/pgvector-${PGVECTOR_VERSION}" OPTFLAGS="" with_llvm=no; \
    make -C "/tmp/pgvector-${PGVECTOR_VERSION}" install DESTDIR=/pgvector with_llvm=no
FROM ${POSTGRES_BASE}
COPY --from=vector-build /pgvector/usr/local/ /usr/local/
