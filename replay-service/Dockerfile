FROM maven:3.9.11-eclipse-temurin-21 AS parser-build
RUN git clone https://github.com/odota/parser.git /src/parser && cd /src/parser && git checkout a03b9e5f228cecb3f2e3ddfd378683bbb1d467fa
COPY replay-service/odota-decision-state.patch /src/odota-decision-state.patch
RUN cd /src/parser && git apply /src/odota-decision-state.patch
RUN cd /src/parser && mvn -q -DskipTests package
COPY replay-service/ReplayBzip2.java /src/ReplayBzip2.java
RUN mkdir -p /src/replay-tools && \
    javac -cp /src/parser/target/stats-0.1.0.jar -d /src/replay-tools /src/ReplayBzip2.java && \
    jar --create --file /src/replay-tools.jar -C /src/replay-tools .

FROM node:22-bookworm-slim AS node-runtime

FROM eclipse-temurin:21-jre-jammy
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=parser-build /src/parser/target/stats-0.1.0.jar /opt/odota-parser/parser.jar
COPY --from=parser-build /src/replay-tools.jar /opt/odota-parser/replay-tools.jar
COPY replay-service/server.mjs replay-service/download.mjs replay-service/enhance.mjs replay-service/extract.mjs replay-service/replay-format.mjs replay-service/start.sh ./
RUN apt-get update && apt-get install -y --no-install-recommends zstd && \
    rm -rf /var/lib/apt/lists/* && \
    chmod +x /app/start.sh && mkdir -p /data
ENV PORT=8080 DATA_DIR=/data PARSER_URL=http://127.0.0.1:5600/
EXPOSE 8080
CMD ["/app/start.sh"]
