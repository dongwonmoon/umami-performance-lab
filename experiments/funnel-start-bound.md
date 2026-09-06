# PostgreSQL 퍼널 조회 시작일 명시 — 2026-09-06

## 질문과 배경

목적은 포트폴리오용 독립 성능 연구다. PR이나 특정 최적화를 미리 성공 조건으로
정하지 않았다. 초기 30일 규모 데이터에서는 뚜렷한 병목이 없었고, 보관 데이터와
조회 기간을 구분하기 위해 약 180일로 확장했다.

Retention은 이번 입력으로 평가하지 않는다. upstream seed가 매번 새 세션을
만들어 지속적인 재방문을 대표하지 못하고, 실제 Retention UI는 한 달을 조회한다.
이는 실험 입력의 한계이지 Umami 결함이 아니다.

## 고정 조건

- Umami v3.3.1: `ca661c7057984aa98ed4f7083d84dae2f65bfcb0`.
- PostgreSQL 15.19, arm64. Docker VM 10 CPU, 메모리 12,601,012,224 bytes.
- 사용자 실행: upstream `pnpm seed-data -- --days 180 --clear`.
- Demo SaaS: 262,196 이벤트·91,225 세션. 전체 DB: 263,306 이벤트.
- SaaS ID: `18573f23-3e24-44ef-b580-154cf371e7fe`.
- 이벤트 min/max: `2026-03-09T15:01:46.849Z` / `2026-09-06T14:57:45.079Z`.
- 고정 DB dump SHA-256: `388bbf3e1ab06a6ae82b7a0d3f8e7b6b530f71400b164ae577092009c8e28c32`.
- seed는 DB 직접 삽입이다. 수집 API 처리량 실험이 아니며, 호스트의 다른 부하는 통제하지 않았다.
- 퍼널: `/ → /pricing → /signup`, 단계 사이 60분. 필터 없음.

## 관찰 → 가설 → 변경

정확한 7일 조회의 두 번째 단계가 전체 이벤트 테이블을 순차 스캔했다.
50,859행 통과·212,447행 제거였다. SQL은 후속 이벤트가 앞 단계 이후임을
보장하지만, 전체 조회 시작일은 후속 단계에 직접 표현하지 않았다.

앞 단계가 시작일 이후이고 각 후속 단계가 앞 단계 이후라면, 후속 이벤트도
시작일 이후다. 이 논리적으로 중복된 조건을 명시하면 결과를 유지하면서
PostgreSQL이 인덱스를 선택하기 쉬워질 것이라고 가정했다.

```sql
and we.created_at >= {{startDate}}
```

이 한 줄만 PostgreSQL 분기에 추가했다. 새 인덱스·캐시·DB 설정은 없고,
ClickHouse는 수정하지 않았다. [patch](../patches/funnel-start-bound.patch).

## 결과

SQL 단독 A/B는 2회 준비 후 20회씩 순서를 번갈아 호출했다.
7일 중앙값은 40.8→11.5ms, 30일 68.1→43.8ms, 전체 192.0→195.0ms였다.
7일의 두 번째 단계는 기존 `website_event_created_at_idx`의 Index Scan으로
바뀌었다(1,874행 통과·7,908행 제거; 단계 시간 25.6→1.2ms).
관측된 스캔은 shared buffer hit이므로 물리 디스크 읽기 절감이라고 하지 않는다.

이후 같은 upstream Dockerfile로 수정 전후 이미지를 만들었다. Node v22.23.2와
공통 기반 17개 레이어가 같았다. 두 앱을 동일 DB에 연결하고 `node server.js`로
실행했다. 기동 시 migration 절차 검증은 하지 않았다.

API는 2회 준비 후 40회씩 A→B/B→A 순서로, 한 번에 한 요청만 호출했다.
시간은 localhost HTTP 요청부터 JSON 해석까지이고 로그인은 제외했다.
매번 기존 공식 이미지의 기준 응답 및 두 버전의 전체 JSON이 일치했다.

| 범위 | 수정 전 p50 / p95 | 수정 후 p50 / p95 |
|---|---:|---:|
| 정확한 7일 | 52.0 / 60.2ms | 23.1 / 32.3ms |
| 정확한 30일 | 78.6 / 102.6ms | 56.2 / 65.6ms |
| 전체 181일 | 198.8 / 224.8ms | 202.7 / 224.6ms |
| UI Last 7 days | 53.1 / 56.6ms | 24.7 / 27.5ms |

앞뒤 20회로 나눠도 짧은 기간의 개선 방향이 같았다. 변경하지 않은 Overview
API 중앙값은 같은 순서로 25.7→25.4, 75.2→74.5, 174.6→177.8,
28.6→28.8ms였다. 전반적인 두 번째 앱의 속도 차이만으로 퍼널 개선을 설명하기는 어렵다.

UI에서 실제 퍼널을 만들었다. 이 버전의 `Last 7 days`는 7일 전 자정부터
오늘 마지막 밀리초까지 **8개 날짜**를 포함한다. 해당 API 결과 1,858→1,099→814명이
화면과 같았다. 네트워크 본문 직접 캡처가 아니라 화면·호출 코드·API의 교차 확인이다.

날짜 경계·60분 초과·반복 방문·동일 시각, wildcard, 이벤트 속성 필터,
8단계를 포함하는 임시 테이블 검사 4개가 기대값과 일치했다. 관련 upstream
테스트는 새 검사 실패를 먼저 확인한 후 패치 적용으로 9개 통과했다.
변경 파일의 Biome, diff 검사를 통과했고, 전체 테스트는 실행하지 않았다.

**판정:** 이 고정 데이터·준비 호출 후·단일 요청 조건의 짧은 퍼널 조회에서
개선이 확인됐다. 전체 기간의 약 2% 증가는 작은 비용인지 측정 변동인지 미확정이다.
기존에도 약 50~80ms였으므로 서비스 장애 해결이나 운영 환경의 56% 개선으로
표현하지 않는다. 동시 입력·처리량·cold cache·다른 데이터 분포는 미검증이다.

## 근거와 재실행

[API 표본과 요청](../evidence/2026-09-06/umami-funnel-api-ab-20260906.json),
[SQL과 실행 계획](../evidence/2026-09-06/umami-funnel-bound-20260906.json)은
원본 측정 파일을 그대로 보존했다. 스크립트만 저장소 기준 경로로 옮겼다.

아래 예시는 저장소 루트에서 시작한다. Node, upstream 의존성과 Prisma 생성,
별도 disposable PostgreSQL 및 고정 DB가 필요하다. 새 seed는 날짜·UUID·분포가
달라지므로 historical 기준 응답과 비교하면 실패하는 것이 정상이다.

```bash
export LAB_DIR="$PWD"
export UMAMI_DIR='/absolute/path/to/umami-checkout'
export DATABASE_URL='postgresql://umami:umami@127.0.0.1:5433/umami'

git -C "$UMAMI_DIR" apply --check "$LAB_DIR/patches/funnel-start-bound.patch"
git -C "$UMAMI_DIR" apply "$LAB_DIR/patches/funnel-start-bound.patch"
cd "$UMAMI_DIR"
pnpm exec vitest run src/queries/sql/reports/getFunnel.test.ts
pnpm exec tsx --tsconfig tsconfig.json "$LAB_DIR/scripts/correctness.mts"
pnpm exec tsx --tsconfig tsconfig.json "$LAB_DIR/scripts/sql-ab.mts"
```

패치 적용 전후 각각 upstream Dockerfile로 `umami-funnel:before`와
`umami-funnel:after`를 빌드한다. 기존 실험의 DB network가 존재할 때:

```bash
docker run --rm -d --name umami-funnel-before-check --init \
  --network umami-qualification_default -p 127.0.0.1:3001:3000 \
  -e DATABASE_URL=postgresql://umami:umami@db:5432/umami \
  -e APP_SECRET=replace-me-with-a-random-string \
  -e TWO_FACTOR_ENCRYPTION_KEY=replace-me-with-a-64-character-hex-string \
  umami-funnel:before node server.js
docker run --rm -d --name umami-funnel-after-check --init \
  --network umami-qualification_default -p 127.0.0.1:3002:3000 \
  -e DATABASE_URL=postgresql://umami:umami@db:5432/umami \
  -e APP_SECRET=replace-me-with-a-random-string \
  -e TWO_FACTOR_ENCRYPTION_KEY=replace-me-with-a-64-character-hex-string \
  umami-funnel:after node server.js
node "$LAB_DIR/scripts/api-ab.mjs"
docker stop umami-funnel-before-check umami-funnel-after-check
```

위 공개 기본값은 localhost 실험 전용이다. 새 DB의 기준선을 만들 때는
`scripts/query-probe.mjs WEBSITE_ID START_ISO END_ISO OUTPUT_JSON`을 사용하고,
별도 실험 요청 파일과 날짜를 명시한다. 기존 evidence를 덮어쓰지 않는다.

## 다음 판단

독립 저장소에서 추가 조사와 실험을 이어간다. 현재 사례는 보존하고, 다음 질문은
사용자와 정한다. 유지보수자에게 의견을 구하는 Discussion이나 PR은 선택사항이며
아직 제출하지 않았다. upstream 제출 전에는 최신 `dev`, 중복 변경, 기여 지침을
다시 확인한다. 무리하게 새 결함을 만들거나 개선을 미리 약속하지 않는다.
