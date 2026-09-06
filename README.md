# Umami Performance Lab

[Umami](https://github.com/umami-software/umami)를 대상으로 하는 독립적인
성능·운영 연구 저장소. 실제 사용 흐름을 이해하고, 측정으로 문제를 확인한 뒤
작은 변경의 효과와 한계를 검증한다. Umami 공식 프로젝트가 아니며, 기록된
데이터와 부하는 로컬 합성 실험이다. upstream 기여는 선택사항이다.

## 첫 사례: PostgreSQL 퍼널 조회의 불필요한 스캔

후속 퍼널 단계에 조회 시작일을 명시하는 SQL 한 줄을 추가했다.
같은 데이터에서 production-build API를 번갈아 40회 측정한 결과다.

| 조회 범위 | 수정 전 중앙값 | 수정 후 중앙값 |
|---|---:|---:|
| 정확한 7일 | 52.0ms | 23.1ms |
| 정확한 30일 | 78.6ms | 56.2ms |
| 전체 181일 | 198.8ms | 202.7ms |

전체 JSON 응답은 같았다. 전체 기간은 개선되지 않았고, 실제 고객 지연이나
동시 처리량 개선은 아직 주장하지 않는다.

- [실험 기록·재현 범위·다음 판단](experiments/funnel-start-bound.md)
- [한 줄 변경과 관련 테스트 패치](patches/funnel-start-bound.patch)
- [측정 코드](scripts/), [공개 가능한 측정 근거](evidence/2026-09-06/)

## 구성과 실행 경계

Umami 소스와 실행 환경은 별도 checkout으로 유지한다. 저장소에는 새 앱,
프레임워크, CI/CD 또는 모니터링 스택을 추가하지 않았다.

실험은 `v3.3.1`의 `ca661c7057984aa98ed4f7083d84dae2f65bfcb0`에 고정되어
있다. patch는 해당 checkout에서 `git apply --check` 후 적용한다.
스크립트는 Node 내장 기능과 upstream에 이미 설치된 `tsx`/Prisma를 사용한다.
구체적인 명령과 전제는 실험 기록에 있다.

기록된 요청은 **당시의 고정 DB**를 대상으로 한다. upstream seed는 현재 날짜와
난수를 사용하므로 새로 생성한 데이터로 과거 숫자를 그대로 재현할 수 없다.
DB는 공개하지 않으며, 새 실험에서는 자신의 고정 데이터와 요청 기준선을 만든다.
`evidence/`에는 원본 이벤트·DB·인증 토큰이 아닌 합성 데이터의 집계 응답,
측정 표본과 실행 계획만 보존했다. 새 출력은 무시되는 `.local/`에 기록한다.

현재는 독립 저장소에서 실험을 계속하는 단계다. PR 승인이나 반영을 성과로
기입하지 않는다. 필요하면 Discussion으로 의견을 구하되 연구의 선행 조건은 아니다.

패치와 SQL 실행 계획에 포함된 upstream 코드 발췌의 저작권 및 MIT 조건은
[Umami 라이선스](third_party/umami-LICENSE)에 있다.
