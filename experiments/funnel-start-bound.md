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
표현하지 않는다. 당시 동시 조회·처리량은 미검증이었으며 아래 추가 실험으로 확인했다.
수집 동시 실행·cold cache·다른 데이터 분포는 여전히 미검증이다.

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

## 동시 조회 검증

### 조건과 실행 — 본 측정 완료

- 질문: 짧은 기간의 이득이 동시 조회에서도 유지되는가? 전체 기간에는 반복되는 손해가 있는가?
- 기존 고정 DB와 수정 전후 이미지를 재사용한다. 7일·전체 기간 퍼널에 동시 요청 1/4/8개를 각각 적용하고, 조건별 3회 반복한다. 실제 이용자 수나 운영 트래픽을 대표한다고 가정하지 않는다.
- 버전별 10초 동안 응답을 받은 요청 슬롯이 다음 요청을 보내는 closed-loop 방식이다. 준비 호출 후 측정하고, 종료 시 진행 중인 요청을 기다린다. 수정 전후는 같은 DB에 **동시에** 부하를 주지 않으며, 반복마다 실행 순서를 바꾼다.
- 반복별 성공 응답 p50/p95, 성공 처리량, 오류·전체 JSON 불일치, DB 컨테이너 CPU 누적 사용량 차이를 남긴다. CPU는 DB 전체의 백그라운드 작업과 측정 비용도 포함하므로 정확한 쿼리별 CPU라고 해석하지 않는다. 준비된 캐시 조건이며, cold cache·수집 동시 실행·실제 브라우저 UX는 이번 범위 밖이다.
- 결과 불일치나 오류는 성공 성능 표본으로 숨기지 않는다. 부하가 달라지면 요청 수도 달라지므로 CPU 총량뿐 아니라 성공 요청당 CPU도 함께 본다. 불리하거나 차이가 작은 결과도 보존하며, 유리한 반복만 골라 보고하지 않는다.
- 메인은 조건·해석·최종 확인, Luna는 측정 코드 구현을 담당한다. 본 측정은 사용자가 실행한다. 짧은 smoke 검사는 정확성·실행 확인용이며 성능 결론에 사용하지 않는다.

실행은 위의 비교용 컨테이너 두 개와 기존 DB가 켜진 상태에서 진행한다. 데이터 재생성·수집이나 Umami 화면 조작, 다른 부하 테스트는 측정 중 피한다. CPU 제한과 DB 설정은 바꾸지 않는다.

```bash
cd /Users/dongwon/workspace/umami-performance-lab
node scripts/concurrent-ab.mjs --check  # 외부 서비스 없이 측정 루프 검사
node scripts/concurrent-ab.mjs --smoke # 0.5초 블록, 전체 12블록 동작 확인
node scripts/concurrent-ab.mjs         # 본 측정: 10초 블록 × 36, 약 6~8분
```

각 실행은 `.local/`의 고유한 JSON에 조건·실제 이미지 ID·반복별 표본과 CPU 사용량을 기록한다. 본 측정과 smoke를 구분하며, 파일 경로가 콘솔에 출력된다. 기존 공개 evidence는 덮어쓰지 않는다. 실행 후 비교 앱이 필요 없으면 `docker stop umami-funnel-before-check umami-funnel-after-check`로 종료할 수 있다(기존 3000번 앱과 DB는 유지).

2026-09-07 준비 확인: Luna가 `scripts/concurrent-ab.mjs`를 구현했고 메인이 검토했다. `--check`의 동시성 상한·진행 중 요청 종료 대기·오류 및 불일치 집계를 확인했고, 실제 두 앱의 최종 `--smoke` 12블록 모두 오류·불일치 0이었다. 누적 JSON의 완료 상태·표본 수·CPU 값과 Git 무시도 확인했다. 로컬 근거는 `.local/concurrent-ab-2026-09-06T150331604Z.json`이며, 이 준비 검사 뒤 사용자가 아래 본 측정을 실행했다.

#### 본 측정 결과 — 2026-09-07

사용자가 00:06:25~00:12:38 KST에 실행했다(373.4초).
근거: [측정 JSON](../evidence/2026-09-07/concurrent-ab-2026-09-06T150625164Z.json).
원본과 바이트 단위로 같은 사본이며, SHA-256은 `1ac1a766f3d2ee5d0b7fcff52b38b93aa32556bdfa8e56704fe2adbac9c4037a`다.
합성 요청 조건·이미지 ID·지연 표본·집계만 포함하고 인증 정보나 원본 이벤트·DB는 포함하지 않는다.
완료 상태와 36개 고유 조건 블록, 측정 응답 19,148개·준비 응답 156개를 확인했다.
기록상 오류·전체 JSON 불일치는 모두 0이고, 시작·완료·성공 수와 지연 표본 수가 일치한다.
저장된 지연 표본에서 p50/p95를 재계산하고 처리량·요청당 CPU 계산도 확인했다.
이는 기록과 측정 코드의 일관성 확인이며 모든 종류의 결함 부재를 증명하지 않는다.

아래는 **각 반복 지표 3개의 중앙값**이다. 요청 전체를 합친 백분위수가 아니다.
화살표는 수정 전 → 후, CPU는 성공 요청당 DB 컨테이너 CPU 시간이다.

| 범위 | 동시 요청 | p50 (ms) | p95 (ms) | 성공 요청/초 | CPU (ms/요청) |
|---|---:|---:|---:|---:|---:|
| 7일 | 1 | 46.4 → 16.0 | 52.1 → 19.8 | 21.28 → 60.16 | 36.90 → 9.07 |
| 7일 | 4 | 58.0 → 32.3 | 70.8 → 43.4 | 68.99 → 121.35 | 33.83 → 9.52 |
| 7일 | 8 | 81.7 → 54.7 | 103.1 → 71.4 | 97.80 → 145.35 | 37.90 → 9.95 |
| 전체 | 1 | 195.9 → 199.3 | 208.9 → 211.0 | 5.09 → 5.01 | 186.72 → 190.15 |
| 전체 | 4 | 188.7 → 195.0 | 213.3 → 211.4 | 21.05 → 20.44 | 171.05 → 173.47 |
| 전체 | 8 | 224.4 → 226.6 | 248.2 → 250.4 | 35.15 → 34.91 | 203.38 → 206.82 |

**판정:** 7일 조회는 9개 짝 비교 모두 지연 p50/p95와 요청당 CPU가 감소하고 처리량이 증가했다.
동시성별 대표값으로 요청당 CPU는 약 72~75% 감소했다. 동시 요청 8개에서는 처리량이 약 49% 증가했다.
단순한 화면 체감 개선보다, 이 조건에서 같은 요청을 처리하는 DB 비용 감소의 근거가 강해졌다.

전체 기간은 p50과 요청당 CPU가 9개 짝 비교 모두 증가했다. 대표 p50은 약 1~3%, 요청당 CPU는 약 1~2% 증가했다.
p95·처리량 방향은 반복마다 일부 다르다. 작은 손해가 반복 관찰되었으므로 단순히 잡음이라고 버리지 않는다.
다만 동일 호스트의 짧은 3회 반복만으로 패치의 고유 비용과 환경 영향을 완전히 분리했다고 주장하지 않는다.

closed-loop는 버전별 도착률을 고정하지 않으며 빠른 버전이 더 많은 요청을 만든다.
따라서 이번 처리량은 실제 서비스 최대 용량이나 동일 유입량에서의 UX/SLO 검증이 아니다.
DB CPU에는 백그라운드 작업도 포함되고 앱·부하 생성기·DB가 같은 Docker 호스트 자원을 공유한다.
반복 순서는 A/B, B/A, A/B로 완전히 균형 잡힌 순서는 아니다. 다른 데이터 분포·cold cache는 여전히 미검증이다.

## 종결 판단 — 2026-09-07

사용자와 이 사례를 현재 범위에서 마무리하기로 했다. 추가 부하나 장애 실험을 하지 않는다.
포트폴리오에 주장할 범위는 특정 로컬 합성 데이터에서의 불필요한 스캔 원인 분석,
같은 결과를 유지한 SQL 변경, 짧은 기간의 개선과 전체 기간의 작은 손해 확인이다.
운영 신뢰성 확보·실서비스 UX 개선·모든 입력에서의 유리함을 주장하지 않는다.

Umami 임시 checkout에는 기존 실험용 SQL·테스트 수정이 남아 있고, 이 저장소에는
그 수정의 재현용 패치가 이미 보존되어 있다. 이번 종결에서는 Umami 본체를 추가로
수정하거나 그 checkout에 커밋하지 않는다. 기존 3000번 공식 앱도 교체하지 않는다.
실험 저장소의 측정 코드·공개 가능한 근거·기록만 로컬 브랜치에 커밋한다.
DB·dump·토큰·smoke 원본은 Git 미추적 상태로 유지한다.

실제 적용이나 upstream 제안을 추진할 때 다른 데이터 분포 검증을 재검토한다.
Discussion이나 PR은 아직 제출하지 않았으며, 제출 전에는 최신 `dev`, 중복 변경,
기여 지침을 다시 확인하고 사용자 승인을 받는다.
